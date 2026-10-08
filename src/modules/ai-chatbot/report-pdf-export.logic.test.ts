import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReportPdfJobId,
  buildReportPdfRateLimitKeys,
  buildReportPdfStorageKey,
  getReportPdfExportPhaseIndex,
  isReportPdfExportTerminal,
  resolveReportPdfJobLocale,
} from './report-pdf-export.logic.js';
import { createReportPdfExportService, type ReportPdfExportDeps } from './report-pdf-export.service.js';
import type { ReportPdfArtifactStore } from './report-pdf-artifact.service.js';
import { createReportPdfAiNarrativeWriter, type ReportPdfAiNarrativeDeps } from './report-pdf-narrative.service.js';
import { consumeReportPdfExportAllowance } from './report-pdf-rate-limit.service.js';
import { buildReportInsights } from './report-insights.logic.js';
import { buildRuleBasedReportNarrative } from './report-pdf-narrative.logic.js';
import { vietnameseReportFixture } from './report-pdf.fixture.js';
import type { TransactionalAuditEntry } from '../../middleware/audit-log.js';
import type { TenantAiRuntimeSettings } from './ai-engine.types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const actor = { userId: USER, tenantId: TENANT, role: 'staff' as const };
const reference = { conversationId: CONVERSATION, assistantMessageId: MESSAGE };
const audit = { requestId: 'req-1', ipAddress: '127.0.0.1', username: 'manager' };

function memoryStore(options: { failPut?: boolean } = {}): ReportPdfArtifactStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    exists: async (path) => objects.has(path),
    put: async (path, pdf) => { if (options.failPut) throw Object.assign(new Error('quota'), { code: 'TENANT_DATA_LIMIT_REACHED' }); objects.set(path, pdf); },
    get: async (path) => { const value = objects.get(path); if (!value) throw new Error('missing'); return value; },
  };
}

function harness(overrides: Partial<ReportPdfExportDeps> & { allowed?: boolean; scopeChanged?: boolean } = {}) {
  const fixture = vietnameseReportFixture();
  const state = { allowed: overrides.allowed ?? true, scopeChanged: overrides.scopeChanged ?? false, renders: 0, audits: [] as TransactionalAuditEntry[], logs: [] as Record<string, unknown>[] };
  const store = memoryStore();
  const deps: ReportPdfExportDeps = {
    permissionChecker: async () => state.allowed,
    loadSnapshot: async () => ({ snapshot: fixture.snapshot, question: 'Báo cáo tháng 7', locale: 'vi' }),
    enforceScope: async () => (state.scopeChanged
      ? { groupId: 'other-group', subgroupId: undefined, teamId: undefined, allowedGroupIds: null }
      : { groupId: fixture.snapshot.scope.groupId, subgroupId: fixture.snapshot.scope.subgroupId, teamId: fixture.snapshot.scope.teamId, allowedGroupIds: null }) as never,
    loadNarrative: async () => ({ narrative: fixture.storedNarrative, locale: 'vi', snapshotHash: fixture.snapshotHash }),
    loadBranding: async () => ({ name: 'Công ty Dược phẩm An Khang', logoDataUri: null }),
    renderer: () => ({
      measure: async () => ({}),
      render: async () => { state.renders += 1; return { pdf: Buffer.from('%PDF-1.7 test'), pageCount: 8, overflow: [], durationMs: 5 }; },
    }),
    aiWriter: () => undefined,
    store: () => store,
    audit: async (entry) => { state.audits.push(entry); },
    rateLimit: async () => ({ allowed: true, scope: null, retryAfterSeconds: 0 }),
    log: (event) => { state.logs.push(event); },
    ...overrides,
  };
  return { service: createReportPdfExportService(deps), deps, state, store, fixture };
}

async function waitForTerminal(service: ReturnType<typeof harness>['service'], jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await service.get({ ...actor, ...reference, jobId });
    if (status.phase === 'ready' || status.phase === 'failed') return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('job did not finish');
}

const rejectsWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('orders export phases without treating in-flight phases as complete', () => {
  assert.ok(getReportPdfExportPhaseIndex('validating') < getReportPdfExportPhaseIndex('narrative'));
  assert.ok(getReportPdfExportPhaseIndex('narrative') < getReportPdfExportPhaseIndex('rendering'));
  assert.ok(getReportPdfExportPhaseIndex('rendering') < getReportPdfExportPhaseIndex('ready'));
  assert.equal(isReportPdfExportTerminal('rendering'), false);
  assert.equal(isReportPdfExportTerminal('ready'), true);
  assert.equal(isReportPdfExportTerminal('failed'), true);
});

test('derives tenant-prefixed deterministic storage keys and job ids', () => {
  const key = buildReportPdfStorageKey({ tenantId: TENANT, ...reference, snapshotHash: 'abc', locale: 'vi', templateVersion: '3.0.0' });
  assert.match(key, new RegExp(`^${TENANT}/report-exports/${CONVERSATION}/${MESSAGE}/vi-[0-9a-f]{40}\\.pdf$`));
  assert.equal(key, buildReportPdfStorageKey({ tenantId: TENANT, ...reference, snapshotHash: 'abc', locale: 'vi', templateVersion: '3.0.0' }));
  assert.notEqual(key, buildReportPdfStorageKey({ tenantId: TENANT, ...reference, snapshotHash: 'abd', locale: 'vi', templateVersion: '3.0.0' }));
  assert.notEqual(key, buildReportPdfStorageKey({ tenantId: TENANT, ...reference, snapshotHash: 'abc', locale: 'en', templateVersion: '3.0.0' }));
  assert.notEqual(key, buildReportPdfStorageKey({ tenantId: TENANT, ...reference, snapshotHash: 'abc', locale: 'vi', templateVersion: '3.0.1' }));
  const id = buildReportPdfJobId({ tenantId: TENANT, userId: USER, ...reference, locale: 'en', templateVersion: '3.0.0' });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(resolveReportPdfJobLocale(id, { tenantId: TENANT, userId: USER, ...reference, templateVersion: '3.0.0' }), 'en');
  assert.equal(resolveReportPdfJobLocale(id, { tenantId: TENANT, userId: 'someone-else', ...reference, templateVersion: '3.0.0' }), null);
});

test('denies start, status, download and synchronous export when permission was revoked', async () => {
  const { service } = harness({ allowed: false });
  await assert.rejects(() => service.start({ ...actor, ...reference, locale: 'vi' }), rejectsWith('REPORT_PDF_PERMISSION_DENIED'));
  await assert.rejects(() => service.get({ ...actor, ...reference, jobId: MESSAGE }), rejectsWith('REPORT_PDF_PERMISSION_DENIED'));
  await assert.rejects(() => service.download({ ...actor, ...reference, jobId: MESSAGE, audit }), rejectsWith('REPORT_PDF_PERMISSION_DENIED'));
  await assert.rejects(() => service.exportNow({ ...actor, ...reference, locale: 'vi', audit }), rejectsWith('REPORT_PDF_PERMISSION_DENIED'));
});

test('renders, stores under the tenant prefix, and audits each delivered download', async () => {
  const { service, state, store } = harness();
  const job = await service.start({ ...actor, ...reference, locale: 'en' });
  assert.equal(job.locale, 'en');
  const ready = await waitForTerminal(service, job.id);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.fileName, 'learning-performance-report_cong-ty-duoc-pham-an-khang_2026-07-01_to_2026-07-31.pdf');
  assert.equal(store.objects.size, 1);
  assert.ok([...store.objects.keys()][0].startsWith(`${TENANT}/report-exports/`));
  const download = await service.download({ ...actor, ...reference, jobId: job.id, audit });
  assert.equal(download.pdf.toString(), '%PDF-1.7 test');
  assert.equal(state.audits.length, 1);
  assert.deepEqual({ ...state.audits[0], event: undefined }, {
    tenantId: TENANT, actorId: USER, actorUsername: 'manager', action: 'CREATE', entityType: 'report_pdf', entityId: MESSAGE,
    entityName: download.fileName, ipAddress: '127.0.0.1', event: undefined,
  });
  assert.deepEqual(state.audits[0].event, { code: 'report.pdf.exported', context: { file_name: download.fileName, file_size_bytes: download.pdf.byteLength } });
  assert.ok(state.logs.some((event) => event.event === 'report_pdf_rendered' && event.narrative === 'rules'));
});

test('keeps working after a restart: status and download are served from storage', async () => {
  const first = harness();
  const job = await first.service.start({ ...actor, ...reference, locale: 'vi' });
  await waitForTerminal(first.service, job.id);
  const restarted = harness({ store: () => first.store });
  const status = await restarted.service.get({ ...actor, ...reference, jobId: job.id });
  assert.deepEqual([status.phase, status.locale], ['ready', 'vi']);
  const download = await restarted.service.download({ ...actor, ...reference, jobId: job.id, audit });
  assert.equal(download.pdf.toString(), '%PDF-1.7 test');
  assert.equal(restarted.state.audits.length, 1);
  const again = await restarted.service.start({ ...actor, ...reference, locale: 'vi' });
  await waitForTerminal(restarted.service, again.id);
  assert.equal(restarted.state.renders, 0, 'a stored PDF is reused instead of rendering again');
});

test('re-enforces the report scope before rendering and before serving bytes', async () => {
  const denied = harness({ scopeChanged: true });
  const job = await denied.service.start({ ...actor, ...reference, locale: 'vi' });
  const status = await waitForTerminal(denied.service, job.id).catch((error) => ({ phase: 'failed', errorCode: (error as { code: string }).code }));
  assert.equal(status.errorCode, 'REPORT_PDF_SCOPE_DENIED');
  assert.equal(denied.state.renders, 0);

  const ok = harness();
  const ready = await ok.service.start({ ...actor, ...reference, locale: 'vi' });
  await waitForTerminal(ok.service, ready.id);
  const revoked = harness({ scopeChanged: true, store: () => ok.store });
  await assert.rejects(() => revoked.service.download({ ...actor, ...reference, jobId: ready.id, audit }), rejectsWith('REPORT_PDF_SCOPE_DENIED'));
  assert.equal(revoked.state.audits.length, 0);
});

test('a learner_plus without any group never passes the scope re-check as tenant-wide', async () => {
  const fixture = vietnameseReportFixture();
  const tenantWide = { ...fixture.snapshot, scope: { groupId: undefined, subgroupId: undefined, teamId: undefined } };
  // enforceReportScope answers a zero-group learner_plus with all-undefined ids, i.e. the ids of a tenant-wide snapshot.
  const noGroups = async () => ({ groupId: undefined, subgroupId: undefined, teamId: undefined, allowedGroupIds: [] as string[] });
  const staff = async () => ({ groupId: undefined, subgroupId: undefined, teamId: undefined, allowedGroupIds: null });
  const ok = harness({ enforceScope: staff, loadSnapshot: async () => ({ snapshot: tenantWide, question: 'Báo cáo', locale: 'vi' }) });
  const ready = await ok.service.start({ ...actor, ...reference, locale: 'vi' });
  assert.equal((await waitForTerminal(ok.service, ready.id)).phase, 'ready');

  const demoted = harness({ enforceScope: noGroups, loadSnapshot: async () => ({ snapshot: tenantWide, question: 'Báo cáo', locale: 'vi' }), store: () => ok.store });
  await assert.rejects(() => demoted.service.download({ ...actor, ...reference, jobId: ready.id, audit }), rejectsWith('REPORT_PDF_SCOPE_DENIED'));
  await assert.rejects(() => demoted.service.exportNow({ ...actor, ...reference, locale: 'vi', audit }), rejectsWith('REPORT_PDF_SCOPE_DENIED'));
  const fresh = harness({ enforceScope: noGroups, loadSnapshot: async () => ({ snapshot: tenantWide, question: 'Báo cáo', locale: 'vi' }), store: () => null });
  const job = await fresh.service.start({ ...actor, ...reference, locale: 'en' });
  assert.equal((await waitForTerminal(fresh.service, job.id)).errorCode, 'REPORT_PDF_SCOPE_DENIED');
  assert.equal(demoted.state.renders + fresh.state.renders, 0);
  assert.equal(demoted.state.audits.length, 0);
});

test('refuses to deliver bytes when the audit row cannot be written', async () => {
  const { service } = harness({ audit: async () => { throw new Error('db down'); } });
  const job = await service.start({ ...actor, ...reference, locale: 'vi' });
  await waitForTerminal(service, job.id);
  await assert.rejects(() => service.download({ ...actor, ...reference, jobId: job.id, audit }), rejectsWith('REPORT_PDF_AUDIT_FAILED'));
});

test('falls back to the in-memory artifact when storage rejects the upload', async () => {
  const failing = memoryStore({ failPut: true });
  const { service, state } = harness({ store: () => failing });
  const job = await service.start({ ...actor, ...reference, locale: 'vi' });
  assert.equal((await waitForTerminal(service, job.id)).phase, 'ready');
  const download = await service.download({ ...actor, ...reference, jobId: job.id, audit });
  assert.equal(download.pdf.toString(), '%PDF-1.7 test');
  assert.ok(state.logs.some((event) => event.event === 'report_pdf_storage_failed' && event.reason === 'TENANT_DATA_LIMIT_REACHED'));
});

test('without storage an unknown job id is not found after a restart', async () => {
  const { service } = harness({ store: () => null });
  const jobId = buildReportPdfJobId({ tenantId: TENANT, userId: USER, ...reference, locale: 'vi', templateVersion: '3.0.0' });
  await assert.rejects(() => service.get({ ...actor, ...reference, jobId }), rejectsWith('REPORT_PDF_JOB_NOT_FOUND'));
});

test('rate-limits new exports per user and per tenant', async () => {
  const limited = harness({ rateLimit: async () => ({ allowed: false, scope: 'user', retryAfterSeconds: 42 }) });
  await assert.rejects(() => limited.service.start({ ...actor, ...reference, locale: 'vi' }), (error: unknown) => (error as { code?: string; retryAfterSeconds?: number }).code === 'REPORT_PDF_RATE_LIMITED' && (error as { retryAfterSeconds?: number }).retryAfterSeconds === 42);

  const counts = new Map<string, number>();
  const counter = { incrementPair: async (userKey: string, tenantKey: string) => {
    counts.set(userKey, (counts.get(userKey) ?? 0) + 1);
    counts.set(tenantKey, (counts.get(tenantKey) ?? 0) + 1);
    return [counts.get(userKey)!, counts.get(tenantKey)!] as [number, number];
  } };
  const options = { counter, nowMs: 1_000_000, windowSeconds: 600, userLimit: 2, tenantLimit: 3 };
  assert.equal((await consumeReportPdfExportAllowance({ tenantId: TENANT, userId: 'a' }, options)).allowed, true);
  assert.equal((await consumeReportPdfExportAllowance({ tenantId: TENANT, userId: 'a' }, options)).allowed, true);
  assert.deepEqual(await consumeReportPdfExportAllowance({ tenantId: TENANT, userId: 'a' }, options), { allowed: false, scope: 'user', retryAfterSeconds: 200 });
  assert.equal((await consumeReportPdfExportAllowance({ tenantId: TENANT, userId: 'b' }, options)).scope, 'tenant');
  const logs: Record<string, unknown>[] = [];
  const open = await consumeReportPdfExportAllowance({ tenantId: TENANT, userId: 'c' }, { counter: { incrementPair: async () => null }, log: (event) => logs.push(event) });
  assert.equal(open.allowed, true, 'fails open when Redis is unavailable');
  assert.equal(logs[0].event, 'report_pdf_rate_limit_unavailable');
  const keys = buildReportPdfRateLimitKeys({ tenantId: TENANT, userId: USER, nowMs: 599_000, windowSeconds: 600 });
  assert.equal(keys.retryAfterSeconds, 1);
  assert.match(keys.user, new RegExp(`:${TENANT}:${USER}:0$`));
});

test('the AI narrative writer accounts tokens and only returns validated narratives', async () => {
  const fixture = vietnameseReportFixture();
  const insights = buildReportInsights(fixture.snapshot);
  const rules = buildRuleBasedReportNarrative(insights, 'vi');
  const toAi = (headline: string) => JSON.stringify({
    headline: { text: headline, fact_ids: rules.headline.factIds },
    findings: rules.findings.map((item) => ({ text: item.text, fact_ids: item.factIds })),
    risks: rules.risks.map((item) => ({ text: item.text, fact_ids: item.factIds })),
    recommendations: rules.recommendations.map((item) => ({ text: item.text, fact_ids: item.factIds, priority: item.priority })),
  });
  const calls = { reserve: 0, finalize: 0, release: 0, generate: 0 };
  const logs: Record<string, unknown>[] = [];
  const deps = (generateText: () => Promise<string>, enabled = true): ReportPdfAiNarrativeDeps => ({
    enabled: () => enabled,
    timeoutMs: 1_000,
    getSettings: async () => ({ hasGoogleAiStudioKey: true, activeEngine: 'gemini_file_search', provider: 'google_ai_studio', chatModel: 'test-model' }) as TenantAiRuntimeSettings,
    reserve: async () => { calls.reserve += 1; return { id: 'reservation', reservedTokens: 20_000, minimumTokens: 1, maximumTokens: 20_000, remainingTokens: null, isPartialGrant: false }; },
    finalize: async () => { calls.finalize += 1; },
    release: async () => { calls.release += 1; },
    generate: async () => { calls.generate += 1; return { text: await generateText(), usage: { inputTokens: 900, outputTokens: 300 } }; },
    log: (event) => logs.push(event),
  });
  const context = { tenantId: TENANT, userId: USER, conversationId: CONVERSATION, requestId: 'req' };

  assert.equal(await createReportPdfAiNarrativeWriter(context, deps(async () => '{}', false))(insights, 'vi'), null);
  assert.equal(calls.reserve, 0, 'disabled flag makes no AI call');

  const accepted = await createReportPdfAiNarrativeWriter(context, deps(async () => toAi('Kỳ báo cáo có 315 lượt ghi danh và tỉ lệ hoàn thành 61,8%.')))(insights, 'vi');
  assert.equal(accepted?.source, 'ai');
  assert.equal(calls.finalize, 1);

  const rejected = await createReportPdfAiNarrativeWriter(context, deps(async () => toAi('Kỳ báo cáo có 320 lượt ghi danh.')))(insights, 'vi');
  assert.equal(rejected, null, 'a number that is not in the cited facts rejects the AI narrative');
  assert.equal(calls.finalize, 2, 'tokens are still accounted');
  assert.ok(logs.some((event) => event.outcome === 'rejected' && event.reason === 'validation'));

  const failed = await createReportPdfAiNarrativeWriter(context, deps(async () => { throw Object.assign(new Error('timeout'), { code: 'ABORT_ERR' }); }))(insights, 'vi');
  assert.equal(failed, null);
  assert.equal(calls.release, 1, 'the reservation is released when the provider call fails');
  assert.ok(!JSON.stringify(logs).includes('315 lượt'), 'narrative text is never logged');
});
