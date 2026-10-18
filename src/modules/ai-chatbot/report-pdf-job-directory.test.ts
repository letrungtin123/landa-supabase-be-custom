import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportPdfExportService, type ReportPdfExportDeps } from './report-pdf-export.service.js';
import { createRedisReportPdfJobDirectory, type ReportPdfJobRedisClient } from './report-pdf-job-directory.service.js';
import { vietnameseReportFixture } from './report-pdf.fixture.js';

// Report PDF jobs with several API processes: the export starts on process A,
// the dashboard polls and downloads through process B. A shared in-memory
// Redis stand-in; no Storage (REPORT_PDF_STORAGE_ENABLED=false, the default).

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const owner = { userId: USER, tenantId: TENANT, role: 'staff' as const, conversationId: CONVERSATION, assistantMessageId: MESSAGE };
const audit = { requestId: 'req-1', ipAddress: '127.0.0.1', username: 'manager' };

class FakeRedis implements ReportPdfJobRedisClient {
  readonly values = new Map<string, string>();
  down = false;
  async set(key: string, value: string) { if (this.down) throw new Error('ECONNRESET'); this.values.set(key, value); return 'OK'; }
  async get(key: string) { if (this.down) throw new Error('ECONNRESET'); return this.values.get(key) ?? null; }
}

function apiProcess(redis: FakeRedis | null, gate?: Promise<void>) {
  const fixture = vietnameseReportFixture();
  const state = { renders: 0 };
  const directory = redis ? createRedisReportPdfJobDirectory({ getClient: () => redis, deadline: (_label, work) => work }) : null;
  const deps: ReportPdfExportDeps = {
    permissionChecker: async () => true,
    loadSnapshot: async () => ({ snapshot: fixture.snapshot, question: 'Báo cáo tháng 7', locale: 'vi' }),
    enforceScope: async () => ({ groupId: fixture.snapshot.scope.groupId, subgroupId: fixture.snapshot.scope.subgroupId, teamId: fixture.snapshot.scope.teamId, allowedGroupIds: null }) as never,
    loadNarrative: async () => ({ narrative: fixture.storedNarrative, locale: 'vi', snapshotHash: fixture.snapshotHash }),
    loadBranding: async () => ({ name: 'Công ty Dược phẩm An Khang', logoDataUri: null }),
    loadLabels: async () => ({}),
    renderer: () => ({
      measure: async () => ({}),
      render: async () => { state.renders += 1; await gate; return { pdf: Buffer.from('%PDF-1.7 shared'), pageCount: 8, overflow: [], durationMs: 5 }; },
    }),
    aiWriter: () => undefined,
    store: () => null,
    audit: async () => {},
    rateLimit: async () => ({ allowed: true, scope: null, retryAfterSeconds: 0 }),
    log: () => {},
    jobDirectory: () => directory,
  };
  return { service: createReportPdfExportService(deps), state };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

test('started on process A: process B reports it running, then ready, and serves the PDF', async () => {
  const redis = new FakeRedis();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const a = apiProcess(redis, gate);
  const b = apiProcess(redis);
  const started = await a.service.start({ ...owner, locale: 'vi' });

  const running = await until(() => b.service.get({ ...owner, jobId: started.id }), (status) => status.phase === 'rendering');
  assert.equal(running.id, started.id, 'not REPORT_PDF_JOB_NOT_FOUND (the dashboard showed that as expired)');
  await assert.rejects(b.service.download({ ...owner, jobId: started.id, audit }), { code: 'REPORT_PDF_NOT_READY' });
  const again = await b.service.start({ ...owner, locale: 'vi' });
  assert.equal(again.id, started.id);
  assert.equal(b.state.renders, 0, 'B never renders the report A is rendering');

  open();
  const ready = await until(() => b.service.get({ ...owner, jobId: started.id }), (status) => status.phase === 'ready');
  assert.ok(ready.fileName);
  const downloaded = await b.service.download({ ...owner, jobId: started.id, audit });
  assert.equal(downloaded.pdf.toString(), '%PDF-1.7 shared');
});

test('another user never sees the job through the shared status', async () => {
  const redis = new FakeRedis();
  const a = apiProcess(redis);
  const b = apiProcess(redis);
  const started = await a.service.start({ ...owner, locale: 'vi' });
  await until(() => a.service.get({ ...owner, jobId: started.id }), (status) => status.phase === 'ready');
  const stranger = { ...owner, userId: '55555555-5555-4555-8555-555555555555' };
  await assert.rejects(b.service.get({ ...stranger, jobId: started.id }), { code: 'REPORT_PDF_JOB_NOT_FOUND' });
  await assert.rejects(b.service.download({ ...stranger, jobId: started.id, audit }), { code: 'REPORT_PDF_JOB_NOT_FOUND' });
});

test('Redis down: the job still runs and is served by the process that started it', async () => {
  const redis = new FakeRedis();
  redis.down = true;
  const a = apiProcess(redis);
  const started = await a.service.start({ ...owner, locale: 'vi' });
  await until(() => a.service.get({ ...owner, jobId: started.id }), (status) => status.phase === 'ready');
  assert.equal((await a.service.download({ ...owner, jobId: started.id, audit })).pdf.toString(), '%PDF-1.7 shared');
});

test('one API process (no directory): unchanged, nothing shared', async () => {
  const a = apiProcess(null);
  const started = await a.service.start({ ...owner, locale: 'vi' });
  await until(() => a.service.get({ ...owner, jobId: started.id }), (status) => status.phase === 'ready');
  assert.equal(a.state.renders, 1);
});
