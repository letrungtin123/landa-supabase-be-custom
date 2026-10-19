import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// Characterization of email outbox delivery: how a worker tick claims due
// jobs (pending, failed under max_attempts, and stale 'sending' leases older
// than 5 minutes), drops jobs whose recipient was deleted, sends one SMTP
// session per tenant group, and moves each job to 'sent', back to 'pending'
// with attempts + 1 and an attempts² minutes backoff, or to 'failed' at
// max_attempts; how an SMTP outage opens the tenant circuit and the next
// tick releases that tenant's jobs until the cooldown ends; the hourly sent
// retention under its session advisory lock; and how the worker starts
// inline (timer unref'd) or dedicated (timer keeps the process alive).
//
// Every statement (whitespace-normalized text and parameters), the SMTP
// commands and the worker logs of each case are digested into a golden file
// written by the code before the outbox was split. No database, Redis or
// RabbitMQ: a pg double answers each statement, and net.connect is pointed at
// a fake SMTP server on a loopback port opened by this test. Rewrite the
// golden file only for an intended change:
//   EMAIL_OUTBOX_GOLDEN_WRITE=1 npx tsx --test src/modules/assignments/email-outbox-delivery.characterization.test.ts
// EMAIL_OUTBOX_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';

const pg = await import('pg');
const { env } = await import('../../config/env.js');
Object.assign(env as Record<string, unknown>, {
  EMAIL_OUTBOX_WORKER_ENABLED: true,
  EMAIL_OUTBOX_INTERVAL_MS: 600_000,
  EMAIL_OUTBOX_BATCH_SIZE: 10,
  EMAIL_OUTBOX_CLAIM_BATCH_SIZE: 3,
  // One tenant group at a time: statements and SMTP sessions keep one order.
  EMAIL_OUTBOX_CONCURRENCY: 1,
  EMAIL_OUTBOX_TENANT_CONCURRENCY: 1,
  EMAIL_OUTBOX_TICK_BUDGET_MS: 60_000,
  EMAIL_OUTBOX_SESSION_MAX_MESSAGES: 2,
  EMAIL_OUTBOX_SENT_RETENTION_DAYS: 30,
  EMAIL_OUTBOX_RETENTION_BATCH_SIZE: 500,
  EMAIL_OUTBOX_WAKE_DEBOUNCE_MS: 0,
  EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD: 1,
  EMAIL_OUTBOX_TENANT_COOLDOWN_MS: 60_000,
  EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS: 600_000,
  SMTP_CONFIG_ENCRYPTION_KEY: 'a'.repeat(64),
});
const { pool } = await import('../../config/database.js');
const { encryptSecret } = await import('../../utils/secret-crypto.js');
const outbox = await import('./email-outbox.service.js');

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'email-outbox-delivery.characterization.golden.json');
const WRITE_GOLDEN = process.env.EMAIL_OUTBOX_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.EMAIL_OUTBOX_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const secret = encryptSecret('smtp-app-password');
const SMTP_ROW = {
  tenant_id: TENANT_A, is_enabled: true, host: 'smtp.example.test', port: 25, secure: false, username: 'mailer',
  from_email: 'no-reply@example.test', from_name: 'Landa', reply_to_email: null, copy_to_sender: false, copy_to_email: null,
  password_ciphertext: secret.ciphertext, password_iv: secret.iv, password_auth_tag: secret.authTag,
};

function job(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n), tenant_id: TENANT_A, status: 'sending', previous_status: 'pending', recipient_user_id: `u-${n}`,
    recipient_email: `learner${n}@example.test`, subject: `Thông báo ${n}`, html_body: `<p>Xin chào ${n}</p>`,
    text_body: `Xin chào ${n}`, attempts: 0, max_attempts: 3, ...extra,
  };
}

// ── Fake SMTP server (loopback) ──

const smtpLog: string[] = [];
/** RCPT addresses the server refuses with 550. */
const refusedRecipients = new Set<string>();
const smtpServer = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  socket.write('220 fake.smtp ready\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        const subject = /^Subject: (.*)$/m.exec(message)?.[1] ?? '';
        const to = /^To: (.*)$/m.exec(message)?.[1] ?? '';
        smtpLog.push(`DATA to=${to} subject=${subject}`);
        socket.write('250 queued\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const verb = line.split(' ')[0]!.toUpperCase();
      smtpLog.push(verb === 'AUTH' ? 'AUTH PLAIN <credentials>' : line);
      if (verb === 'EHLO') socket.write('250 fake.smtp\r\n');
      else if (verb === 'AUTH') socket.write('235 ok\r\n');
      else if (verb === 'MAIL') socket.write('250 ok\r\n');
      else if (verb === 'RCPT') {
        const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
        socket.write(refusedRecipients.has(address) ? '550 no such user\r\n' : '250 ok\r\n');
      } else if (verb === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (verb === 'RSET') socket.write('250 reset\r\n');
      else if (verb === 'QUIT') {
        socket.end('221 bye\r\n');
        return;
      } else socket.write('500 unknown\r\n');
    }
  });
  socket.on('error', () => undefined);
});
await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', () => resolve()));
const smtpPort = (smtpServer.address() as net.AddressInfo).port;
const realConnect = net.connect.bind(net) as (...args: unknown[]) => net.Socket;

test.after(async () => {
  outbox.stopEmailOutboxWorker();
  await new Promise<void>((resolve) => smtpServer.close(() => resolve()));
  await pool.end();
});

// ── Database double ──

interface Statement {
  text: string;
  params: unknown[];
}
type Answer = (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined;

function installDb(t: TestContext, answer: Answer): Statement[] {
  const statements: Statement[] = [];
  const handle = async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    const params = [...(typeof config === 'string' ? values : (config.values ?? []))];
    statements.push({ text, params });
    const custom = answer(text, params);
    const rows = custom?.rows ?? [];
    return { rows, rowCount: custom?.rowCount ?? rows.length };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  return statements;
}

/** Claims answer the given rows once each (later claims find nothing); the rest answers like an idle database. */
function outboxDb(scenario: {
  runnable?: unknown[][];
  stale?: unknown[][];
  deliverable?: (ids: string[]) => string[];
  smtp?: (tenantId: string) => unknown;
}): Answer {
  const runnable = [...(scenario.runnable ?? [])];
  const stale = [...(scenario.stale ?? [])];
  return (text, params) => {
    if (/FROM notification_email_jobs/.test(text)) return { rows: [] };
    if (/WHERE status IN \('pending', 'failed'\)\s+AND next_attempt_at <= now\(\)\s+AND \(status = 'pending'/.test(text)) {
      return { rows: runnable.shift() ?? [] };
    }
    if (/WHERE status = 'sending'\s+AND updated_at </.test(text)) return { rows: stale.shift() ?? [] };
    if (/SELECT eo\.id\s+FROM email_outbox eo/.test(text)) {
      const ids = params[0] as string[];
      return { rows: (scenario.deliverable ? scenario.deliverable(ids) : ids).map((value) => ({ id: value })) };
    }
    if (/FROM tenant_smtp_configs/.test(text)) {
      const row = scenario.smtp ? scenario.smtp(String(params[0])) : { ...SMTP_ROW, tenant_id: params[0] };
      return { rows: row ? [row] : [] };
    }
    if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: true }] };
    if (/DELETE FROM email_outbox eo\s+USING doomed/.test(text)) return { rows: [], rowCount: 4 };
    return undefined;
  };
}

// ── Worker driving ──

const logs: string[] = [];

function installConsole(t: TestContext): void {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      logs.push(`${method} ${args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')}`);
    });
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 15_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const tickCount = () => logs.filter((line) => line.includes('[EmailOutbox] tick done')).length;

/** Starts the worker, waits for its startup tick (and any pending wake) to finish, then stops it. */
async function runStartupTick(source: string, ticks = 1): Promise<void> {
  const before = tickCount();
  try {
    outbox.startEmailOutboxWorker({ keepAlive: false, source });
    await waitFor(() => tickCount() >= before + ticks, 'the worker tick');
    // Let the worker's finally blocks run before stopping it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    outbox.stopEmailOutboxWorker();
  }
}

interface Case {
  name: string;
  run: (t: TestContext) => Promise<unknown>;
}
const cases: Case[] = [];
const add = (name: string, run: (t: TestContext) => Promise<unknown>) => cases.push({ name, run });

// Order matters: the hourly retention runs on the first tick only, and the
// tenant circuit opened by one case is seen by the next one.
add('tick sends, retries a refused recipient and runs the hourly retention', async (t) => {
  refusedRecipients.add('learner2@example.test');
  const statements = installDb(t, outboxDb({ runnable: [[job(1), job(2), job(3, { attempts: 1 })]] }));
  await runStartupTick('inline');
  refusedRecipients.clear();
  return statements;
});
add('a refused recipient at max attempts fails for good', async (t) => {
  refusedRecipients.add('learner4@example.test');
  const statements = installDb(t, outboxDb({ runnable: [[job(4, { attempts: 2, previous_status: 'failed' })]] }));
  await runStartupTick('inline');
  refusedRecipients.clear();
  return statements;
});
add('stale sending leases are reclaimed when the runnable claim is short', async (t) => {
  const statements = installDb(t, outboxDb({
    runnable: [[job(5)]],
    stale: [[job(6, { previous_status: 'sending', attempts: 1 }), job(7, { previous_status: 'sending' })]],
  }));
  await runStartupTick('dedicated');
  return statements;
});
add('a job whose recipient was deleted after the claim is dropped', async (t) => {
  const statements = installDb(t, outboxDb({
    runnable: [[job(8), job(9)]],
    deliverable: (ids) => ids.filter((value) => value !== id(9)),
  }));
  await runStartupTick('inline');
  return statements;
});
add('tenants are sent in separate SMTP sessions, two messages per session', async (t) => {
  const statements = installDb(t, outboxDb({
    runnable: [[job(10), job(11, { tenant_id: TENANT_C }), job(12)], [job(13)]],
  }));
  await runStartupTick('inline');
  return statements;
});
add('missing SMTP config retries every job of the tenant and opens its circuit', async (t) => {
  const statements = installDb(t, outboxDb({
    runnable: [[job(14, { tenant_id: TENANT_B }), job(15, { tenant_id: TENANT_B, attempts: 2 })]],
    smtp: () => null,
  }));
  await runStartupTick('inline');
  return statements;
});
add('an open tenant circuit releases its jobs until the cooldown ends', async (t) => {
  const statements = installDb(t, outboxDb({ runnable: [[job(16, { tenant_id: TENANT_B })]] }));
  await runStartupTick('inline');
  return statements;
});
add('an SMTP connection failure retries the slice', async (t) => {
  const statements = installDb(t, outboxDb({
    runnable: [[job(17, { tenant_id: TENANT_C })]],
    smtp: (tenantId) => ({ ...SMTP_ROW, tenant_id: tenantId, host: 'refused.example.test' }),
  }));
  await runStartupTick('inline');
  return statements;
});
add('a wake during a tick runs one more drain', async (t) => {
  const db = outboxDb({ runnable: [[job(18)]] });
  let woken = false;
  const statements = installDb(t, (text, params) => {
    // A RabbitMQ wake arrives while the first drain is claiming.
    if (!woken && /UPDATE email_outbox eo/.test(text)) {
      woken = true;
      outbox.triggerEmailOutboxWorker('rabbitmq:assignment');
    }
    return db(text, params);
  });
  await runStartupTick('inline', 2);
  return statements;
});
add('a second trigger before the tick starts only replaces its reason', async (t) => {
  const statements = installDb(t, outboxDb({}));
  const before = tickCount();
  try {
    outbox.startEmailOutboxWorker({ keepAlive: false, source: 'inline' });
    outbox.triggerEmailOutboxWorker('rabbitmq:feedback');
    await waitFor(() => tickCount() >= before + 1, 'the worker tick');
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    outbox.stopEmailOutboxWorker();
  }
  return statements;
});
add('an idle startup tick claims nothing', async (t) => {
  const statements = installDb(t, outboxDb({}));
  await runStartupTick('dedicated');
  return statements;
});
add('a claim error is counted and the tick ends', async (t) => {
  const statements = installDb(t, (text) => {
    if (/FROM notification_email_jobs/.test(text)) return { rows: [] };
    if (/UPDATE email_outbox eo/.test(text)) throw new Error('canceling statement due to lock timeout');
    return undefined;
  });
  await runStartupTick('inline');
  return statements;
});

// Start modes: inline (no keep-alive) and dedicated (keep-alive), disabled, and triggers before a start.
add('inline start unrefs its interval, dedicated start keeps it', async (t) => {
  const statements = installDb(t, outboxDb({}));
  const intervals: Array<{ ms: number; unref: boolean }> = [];
  const realSetInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn: () => void, ms: number) => {
    const handle = realSetInterval(fn, ms);
    const entry = { ms, unref: false };
    intervals.push(entry);
    const unref = handle.unref.bind(handle);
    handle.unref = () => {
      entry.unref = true;
      return unref();
    };
    return handle;
  });
  for (const keepAlive of [false, true]) {
    const before = tickCount();
    try {
      outbox.startEmailOutboxWorker({ keepAlive, source: keepAlive ? 'dedicated' : 'inline' });
      outbox.startEmailOutboxWorker({ keepAlive, source: 'second-start-is-ignored' });
      await waitFor(() => tickCount() >= before + 1, 'the startup tick');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      outbox.stopEmailOutboxWorker();
    }
  }
  return { statements, intervals };
});
add('a disabled worker never starts and triggers do nothing', async (t) => {
  const statements = installDb(t, outboxDb({}));
  const flags = env as { EMAIL_OUTBOX_WORKER_ENABLED: boolean };
  flags.EMAIL_OUTBOX_WORKER_ENABLED = false;
  try {
    outbox.startEmailOutboxWorker({ keepAlive: true, source: 'dedicated' });
    outbox.triggerEmailOutboxWorker('manual');
  } finally {
    flags.EMAIL_OUTBOX_WORKER_ENABLED = true;
  }
  outbox.triggerEmailOutboxWorker('before-start');
  await new Promise((resolve) => setTimeout(resolve, 30));
  return statements;
});

// ── Runner ──

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function digest(outcome: unknown): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

const golden: Record<string, string> = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>)
  : {};
const written: Record<string, string> = {};
const full: Record<string, unknown> = {};

/** Elapsed times and the random MIME boundary vary per run; everything else is pinned. */
function stableLog(line: string): string {
  return line.replace(/elapsed_ms=\d+/, 'elapsed_ms=<ms>');
}

for (const item of cases) {
  test(`email outbox characterization: ${item.name}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    t.mock.method(net, 'connect', (options: { host?: string }, onConnect?: () => void) =>
      options?.host === 'refused.example.test'
        ? realConnect({ host: '127.0.0.1', port: 1 }, onConnect)
        : realConnect({ host: '127.0.0.1', port: smtpPort }, onConnect),
    );
    logs.length = 0;
    smtpLog.length = 0;
    installConsole(t);
    const result = (await item.run(t)) as Statement[] | { statements: Statement[]; intervals: unknown };
    const statements = Array.isArray(result) ? result : result.statements;
    const outcome = {
      statements: statements.map((s) => ({ sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      smtp: [...smtpLog],
      logs: logs.map(stableLog),
      ...(Array.isArray(result) ? {} : { intervals: result.intervals }),
    };
    const value = digest(outcome);
    if (FULL_OUT) full[item.name] = outcome;
    if (WRITE_GOLDEN) {
      written[item.name] = value;
      return;
    }
    assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
    assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
  });
}

test('every golden entry still has its case', () => {
  if (FULL_OUT) writeFileSync(FULL_OUT, `${JSON.stringify(full, null, 1)}\n`);
  if (WRITE_GOLDEN) {
    const sorted = Object.fromEntries(Object.keys(written).sort().map((name) => [name, written[name]]));
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map((item) => item.name).sort());
});
