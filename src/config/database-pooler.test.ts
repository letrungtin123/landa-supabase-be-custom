import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// P3: DATABASE_POOLER_URL (opt-in) sends only the ordinary main and reports
// pools through a transaction-mode pooler; LISTEN clients and session
// advisory locks keep their own session on DATABASE_URL. Set before the env
// module loads; no connection is opened (connect is faked).
const POOLER_URL = 'postgres://pooler-user:pooler-pass@127.0.0.1:2/pooled';
process.env.DATABASE_POOLER_URL = POOLER_URL;

const pg = await import('pg');
const { env } = await import('./env.js');
const database = await import('./database.js');
const reports = await import('./reports-database.js');

test.after(async () => {
  await reports.endReportsPool();
  await database.endSessionPool();
  await database.pool.end();
});

test('the main and reports pools connect through the pooler', () => {
  assert.equal(database.isDatabasePoolerEnabled(), true);
  assert.equal((database.pool.options as { connectionString?: string }).connectionString, POOLER_URL);
  assert.equal((reports.getReportsPool().options as { connectionString?: string }).connectionString, POOLER_URL);
});

test('session clients come from their own pool on DATABASE_URL, with the same guardrails', async (t) => {
  const seen: Array<Record<string, unknown>> = [];
  t.mock.method(pg.default.Pool.prototype, 'connect', async function connect(this: { options: Record<string, unknown> }) {
    seen.push(this.options);
    return { release() {} };
  });
  await database.getSessionClient();
  await database.getSessionClient();
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'one session pool, created once');
  assert.equal(seen[0].connectionString, env.DATABASE_URL);
  assert.notEqual(seen[0], database.pool.options);
  assert.equal(seen[0].max, env.DB_POOL_MAX);
  assert.equal(seen[0].statement_timeout, database.POOL_STATEMENT_TIMEOUT_MS);
  assert.equal(seen[0].min, 0);
  assert.equal(seen[0].idleTimeoutMillis, env.DB_POOL_IDLE_TIMEOUT_MS);
});

test('behind the pooler only the session pool counts, and the start check reads the pooled guardrails', async (t) => {
  const { logDatabaseConnectionHeadroom, ownDirectConnectionMax } = await import('./database-headroom.js');
  assert.equal(ownDirectConnectionMax({ readsReports: true }), env.DB_POOL_MAX);
  const server = async () => ({
    async query(text: string) {
      return text === 'SHOW max_connections' ? { rows: [{ max_connections: '100' }] } : { rows: [{ open: 10 }] };
    },
    async end() {},
  }) as never;
  const asText = (ms: number) => (ms === 0 ? '0' : ms % 60_000 === 0 ? `${ms / 60_000}min` : ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`);
  for (const [statementTimeout, expected] of [['0', 'db_pooler_guardrails_missing'], ['30s', 'db_pooler_guardrails']] as const) {
    const query = t.mock.method(database.pool, 'query', async (text: string) => (text === 'SHOW statement_timeout'
      ? { rows: [{ statement_timeout: statementTimeout }] }
      : { rows: [{ idle_in_transaction_session_timeout: asText(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS) }] }));
    const logs: Array<[string, Record<string, unknown>]> = [];
    await logDatabaseConnectionHeadroom('api:1', env.DB_POOL_MAX, { log: (level, event) => { logs.push([level, event]); }, connect: server });
    assert.equal(logs[0][1].pooler, true);
    assert.equal(logs[1][1].event, expected, `statement_timeout ${statementTimeout}`);
    assert.equal(logs[1][0], expected === 'db_pooler_guardrails' ? 'info' : 'warn');
    query.mock.restore();
  }
});

// Statements that need one server session for longer than a transaction:
// LISTEN and session-level advisory locks (not the _xact_ ones).
const SESSION_BOUND = /LISTEN \$\{|pg_advisory_lock(?:_shared)?\b|pg_try_advisory_lock\(/;
const KNOWN_SESSION_USERS = [
  'config/cluster-bus.ts',
  'index.ts',
  'modules/ai-chatbot/kb/kb-operation.worker.ts',
  'modules/ai-chatbot/ai-id/lesson-author-source-stream.service.ts',
  'modules/ai-chatbot/ai-id/lesson-author-workspace-stream.service.ts',
  'modules/assignments/email-outbox.service.ts',
  'workers/tenant-data-quota.worker.ts',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

test('every LISTEN and session advisory lock of the app takes a session client', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const users = sourceFiles(src)
    .filter((file) => !file.includes(`${path.sep}scripts${path.sep}`))
    .filter((file) => SESSION_BOUND.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(src, file).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(users, [...KNOWN_SESSION_USERS].sort(), 'a new session-bound use must take getSessionClient()');
  for (const file of KNOWN_SESSION_USERS) {
    assert.match(readFileSync(path.join(src, file), 'utf8'), /getSessionClient\b/, file);
  }
});
