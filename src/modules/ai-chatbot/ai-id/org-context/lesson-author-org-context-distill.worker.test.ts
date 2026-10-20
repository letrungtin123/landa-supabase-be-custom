import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiUsage } from '../../ai-platform/ai-engine.types.js';
import { BilledAiCallError, type MeteredAiCall, type MeteredAiResult } from '../../ai-platform/ai-metered-call.service.js';
import { RagServiceError, type RagOrgContextDistillRequest } from '../../ai-platform/ai-rag-client.service.js';
import { emptyOrgContextProfile, orgContextProfileHash } from '../contracts/lesson-author-org-context.contract.js';
import { createOrgContextDistillWorker, type OrgContextDistillDiagnostic } from './lesson-author-org-context-distill.worker.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = uuid(1), KB = uuid(2), DOCS = [uuid(3), uuid(4)];
const PROFILE = { ...emptyOrgContextProfile(), organization_summary: 'Công ty   mẫu.', products_services: ['Máy in', ''] };
const ANSWER = { profile: PROFILE, source_document_ids: [DOCS[0]], source_chars: 2_000, truncated: false,
  usage: { inputTokens: 900, outputTokens: 300, embeddingTokens: 0, totalTokens: 1_200 }, usage_complete: true,
  provider_calls: 3 };

/** Fake state row + AI points ledger around the worker; `ai` decides each AI call. */
function fixture(options: { attempts?: number; documents?: string[]; engine?: string; leaseLost?: boolean;
  ai?: (request: RagOrgContextDistillRequest, signal: AbortSignal) => Promise<unknown> } = {}) {
  const state = { finished: [] as Array<{ status: string; code: string }>, succeeded: [] as number[], versions: [] as unknown[],
    exhausted: 0, claims: 0 };
  const metered: Array<{ call: MeteredAiCall; usage: AiUsage | null; billed: AiUsage | null; released: boolean }> = [];
  const requests: RagOrgContextDistillRequest[] = [];
  const reports: OrgContextDistillDiagnostic[] = [];
  const worker = createOrgContextDistillWorker({
    distill: {
      failExhaustedLeases: async () => { state.exhausted++; return 0; },
      claim: async (token, leaseMs) => {
        state.claims++;
        assert.equal(leaseMs, 660_000, 'lease = call timeout + 60 s');
        return state.claims > 1 ? null : { tenant_id: TENANT, locale: 'en', requested_by: uuid(5),
          attempts: options.attempts ?? 1, lease_token: token };
      },
      lockLease: async () => !options.leaseLost,
      finishSucceeded: async (_tenant, _token, version) => { state.succeeded.push(version); return true; },
      finishFailed: async (_tenant, _token, status, code) => { state.finished.push({ status, code }); return true; },
    },
    repository: {
      contextKbId: async () => KB,
      learnedDocuments: async (_tenant: string, _kb: string, limit: number) => {
        assert.equal(limit, 50);
        return (options.documents ?? DOCS).map(id => ({ id, size_bytes: 3_000 }));
      },
      insertVersion: async (_tenant: string, input: unknown) => { state.versions.push(input); return 7; },
    } as never,
    transaction: work => work(),
    settings: () => ({ timeout_ms: 600_000, max_source_chars: 1_500_000 }),
    tenantFilter: () => ({ clause: '', params: [] }),
    runtime: async () => ({ engine: options.engine ?? 'self_built_rag', model: 'gemini-3.8-flash', providerKey: true }),
    // withMeteredAiCall's contract: settle the returned usage, the billed usage of a BilledAiCallError, or release.
    metered: async <T>(call: MeteredAiCall, run: () => Promise<MeteredAiResult<T>>) => {
      const entry = { call, usage: null as AiUsage | null, billed: null as AiUsage | null, released: false };
      metered.push(entry);
      try {
        const result = await run();
        entry.usage = result.usage;
        return result.value;
      } catch (error) {
        if (error instanceof BilledAiCallError) { entry.billed = error.usage; throw error.cause; }
        entry.released = true;
        throw error;
      }
    },
    callAi: async (request, execution) => {
      requests.push(request);
      assert.equal(execution.timeoutMs, 600_000);
      return options.ai ? options.ai(request, execution.signal) : structuredClone(ANSWER);
    },
    id: () => uuid(9),
    report: record => reports.push(record),
  });
  return { worker, state, metered, requests, reports };
}

const signal = () => new AbortController().signal;

test('a draft: the request is exactly the AI route\'s, the profile is stored normalised and the points settled', async () => {
  const f = fixture();
  assert.equal(await f.worker.tick(signal()), 'succeeded');
  assert.deepEqual(f.requests, [{ tenant_id: TENANT, kb_id: KB, document_ids: DOCS, locale: 'en', max_source_chars: 1_500_000,
    model: 'gemini-3.8-flash', correlation_id: uuid(9) }]);
  const stored = { ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu.', products_services: ['Máy in'] };
  assert.deepEqual(f.state.versions, [{ origin: 'ai_draft', profile: stored, profileHash: orgContextProfileHash(stored),
    charCount: [...'Công ty mẫu.'].length + 'Máy in'.length, createdBy: uuid(5), sourceDocumentIds: [DOCS[0]],
    sourceChars: 2_000, sourceTruncated: false }]);
  assert.deepEqual(f.state.succeeded, [7]);
  const [entry] = f.metered;
  assert.deepEqual({ ...entry!.call, promptParts: undefined }, { tenantId: TENANT, userId: uuid(5), conversationId: null,
    target: 'lesson_author', operation: 'lesson_author', model: 'gemini-3.8-flash', feature: 'ai_id_org_context',
    promptParts: undefined, extraInputTokens: Math.ceil(6_000 / 3) + 20_000, maxOutputTokens: 65_536, longRunning: true });
  assert.deepEqual(entry!.usage, ANSWER.usage);
  assert.equal(f.reports[0]!.outcome, 'succeeded');
  assert.equal(f.reports[0]!.provider_calls, 3);
  assert.equal(await f.worker.tick(signal()), 'idle');
});

test('incomplete usage is charged at least the points the draft held', async () => {
  const f = fixture({ ai: async () => ({ ...structuredClone(ANSWER), usage_complete: false }) });
  assert.equal(await f.worker.tick(signal()), 'succeeded');
  assert.deepEqual(f.metered[0]!.usage, { inputTokens: 22_000, outputTokens: 65_536, embeddingTokens: 0,
    totalTokens: 87_536 });
});

test('a retryable failure is queued again once, then fails for good; points are released', async () => {
  const busy = () => new RagServiceError('busy', 503, 'SERVICE_BUSY');
  const first = fixture({ ai: async () => { throw busy(); } });
  assert.equal(await first.worker.tick(signal()), 'queued');
  assert.deepEqual(first.state.finished, [{ status: 'queued', code: 'SERVICE_BUSY' }]);
  assert.equal(first.metered[0]!.released, true);
  const second = fixture({ attempts: 2, ai: async () => { throw busy(); } });
  assert.equal(await second.worker.tick(signal()), 'failed');
  assert.deepEqual(second.state.finished, [{ status: 'failed', code: 'SERVICE_BUSY' }]);
  const invalidOutput = fixture({ ai: async () => { throw new RagServiceError('bad', 503, 'ORG_CONTEXT_DISTILL_OUTPUT_INVALID'); } });
  assert.equal(await invalidOutput.worker.tick(signal()), 'queued', 'an unusable AI answer is tried once more');
});

test('non-retryable codes fail at once; a billed failure is settled with its usage', async () => {
  for (const code of ['ORG_CONTEXT_NO_LEARNED_SOURCE', 'REQUEST_VALIDATION_FAILED', 'AI_PROVIDER_AUTH_REJECTED',
    'AI_CREDIT_LIMIT_REACHED']) {
    const f = fixture({ ai: async () => { throw new RagServiceError('x', 409, code); } });
    assert.equal(await f.worker.tick(signal()), 'failed', code);
    assert.deepEqual(f.state.finished, [{ status: 'failed', code }]);
  }
  const billed = fixture({ ai: async () => { throw new RagServiceError('x', 503, 'AI_PROVIDER_UNAVAILABLE',
    { inputTokens: 40, outputTokens: 2 }); } });
  assert.equal(await billed.worker.tick(signal()), 'queued');
  assert.deepEqual(billed.metered[0]!.billed, { inputTokens: 40, outputTokens: 2, embeddingTokens: 0, totalTokens: 42 });
  // An answer Node cannot read is billed with the usage it reported and is not retried.
  const unreadable = fixture({ ai: async () => ({ ...structuredClone(ANSWER), source_document_ids: [uuid(99)] }) });
  assert.equal(await unreadable.worker.tick(signal()), 'failed');
  assert.deepEqual(unreadable.state.finished, [{ status: 'failed', code: 'ORG_CONTEXT_DISTILL_RESPONSE_INVALID' }]);
  assert.deepEqual(unreadable.metered[0]!.billed, ANSWER.usage);
});

test('no learned document or an engine that cannot read fails without an AI call', async () => {
  const none = fixture({ documents: [] });
  assert.equal(await none.worker.tick(signal()), 'failed');
  assert.deepEqual(none.state.finished, [{ status: 'failed', code: 'ORG_CONTEXT_NO_LEARNED_DOCUMENTS' }]);
  assert.equal(none.metered.length, 0);
  const engine = fixture({ engine: 'gemini_file_search' });
  assert.equal(await engine.worker.tick(signal()), 'failed');
  assert.deepEqual(engine.state.finished, [{ status: 'failed', code: 'ORG_CONTEXT_NOT_READY' }]);
  assert.equal(engine.requests.length, 0);
});

test('a lease taken over meanwhile stores nothing; a shutdown interrupts and queues the draft again', async () => {
  const lost = fixture({ leaseLost: true });
  assert.equal(await lost.worker.tick(signal()), 'lost');
  assert.deepEqual([lost.state.versions.length, lost.state.succeeded.length], [0, 0]);
  const controller = new AbortController();
  const stopped = fixture({ ai: async (_request, aiSignal) => {
    controller.abort();
    assert.equal(aiSignal.aborted, true);
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  } });
  assert.equal(await stopped.worker.tick(controller.signal), 'queued');
  assert.deepEqual(stopped.state.finished, [{ status: 'queued', code: 'ORG_CONTEXT_DISTILL_INTERRUPTED' }]);
  assert.equal(stopped.metered[0]!.released, true);
  assert.equal(stopped.state.exhausted, 1, 'expired last-attempt leases are failed before each claim');
});
