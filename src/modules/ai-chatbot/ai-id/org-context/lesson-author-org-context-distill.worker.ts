// Organization profile drafting worker (background process only, ORG_CONTEXT_SPEC §3): every poll it
// claims one tenant's queued draft (FOR UPDATE SKIP LOCKED, lease = call timeout + 60 s, attempts + 1),
// holds AI points for it (operation 'lesson_author'), asks the AI service to draft the profile from the
// tenant's learned context documents, then stores the draft as the current version (origin ai_draft) and
// settles the points with the usage the AI service reports. A failure is retried once unless its code
// says a retry cannot help. Importing this module starts nothing.

import { randomUUID } from 'node:crypto';
import { query, withDatabaseTransaction } from '../../../../config/database.js';
import { env } from '../../../../config/env.js';
import { processLifecycle } from '../../../../config/process-lifecycle.js';
import { runtimeTenantSql } from '../../../../config/runtime-tenant-fence.js';
import type { AiUsage } from '../../ai-platform/ai-engine.types.js';
import {
  BilledAiCallError, withMeteredAiCall, type MeteredAiCall, type MeteredAiResult,
} from '../../ai-platform/ai-metered-call.service.js';
import { distillRagOrgContext, RagServiceError, type RagOrgContextDistillRequest } from '../../ai-platform/ai-rag-client.service.js';
import { getTenantAiRuntimeSettings } from '../../ai-platform/ai-settings.service.js';
import { normalizeAiUsage } from '../../ai-platform/ai-token-quota.service.js';
import {
  orgContextProfileCharCount, orgContextProfileHash, readOrgContextDistillResponse, type OrgContextDistillResponse,
} from '../contracts/lesson-author-org-context.contract.js';
import { resolveOrchestrationV2LessonAuthorModel } from '../orchestration/lesson-author-orchestration-v2-execution.config.js';
import {
  createOrgContextDistillRepository, type OrgContextDistillClaim, type OrgContextDistillRepository,
  type OrgContextTenantFilter,
} from './lesson-author-org-context-distill.repository.js';
import { createOrgContextRepository, type OrgContextRepository } from './lesson-author-org-context.repository.js';
import {
  ORG_CONTEXT_DISTILL_LEASE_MARGIN_MS, ORG_CONTEXT_DISTILL_MAX_DOCUMENTS, OrgContextError, orgContextDistillErrorCode,
  orgContextDistillFailureStatus, orgContextDistillTokenEstimate,
} from './lesson-author-org-context.logic.js';

export type OrgContextDistillOutcome = 'idle' | 'succeeded' | 'queued' | 'failed' | 'lost';

export interface OrgContextDistillWorkerSettings {
  timeout_ms: number;
  max_source_chars: number;
}

export interface OrgContextDistillDiagnostic {
  event: 'org_context_distill_finished' | 'org_context_distill_worker_failed';
  tenant_id: string | null;
  outcome: OrgContextDistillOutcome | 'error';
  attempts: number | null;
  error_code: string | null;
  source_documents: number | null;
  provider_calls: number | null;
  duration_ms: number;
}

export interface OrgContextDistillWorkerDependencies {
  distill: OrgContextDistillRepository;
  repository: OrgContextRepository;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  settings(): OrgContextDistillWorkerSettings;
  /** Claim predicates on `s.tenant_id` (runtime fence, feature allow-list) from the given parameter number on. */
  tenantFilter(firstParameter: number): OrgContextTenantFilter;
  /** The tenant's AI engine, models and provider key. */
  runtime(tenantId: string): Promise<{ engine: string; model: string; providerKey: boolean }>;
  metered<T>(call: MeteredAiCall, run: () => Promise<MeteredAiResult<T>>): Promise<T>;
  callAi(request: RagOrgContextDistillRequest, execution: { timeoutMs: number; signal: AbortSignal }): Promise<unknown>;
  id?: () => string;
  now?: () => number;
  report?(record: OrgContextDistillDiagnostic): void;
}

/** The usage a response or an AI service error reported (for billing a call whose answer is unusable). */
function reportedUsage(value: unknown): AiUsage | null {
  const usage = value && typeof value === 'object' ? (value as { usage?: unknown }).usage : undefined;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return normalizeAiUsage(usage as Partial<AiUsage>);
}

export function createOrgContextDistillWorker(deps: OrgContextDistillWorkerDependencies) {
  const id = deps.id ?? randomUUID;
  const now = deps.now ?? Date.now;
  const report = (record: OrgContextDistillDiagnostic) => { try { deps.report?.(record); } catch { /* diagnostics never decide */ } };

  async function finishFailed(claim: OrgContextDistillClaim, error: unknown): Promise<'queued' | 'failed' | 'lost'> {
    const code = orgContextDistillErrorCode(error);
    const status = orgContextDistillFailureStatus(code, claim.attempts);
    return await deps.distill.finishFailed(claim.tenant_id, claim.lease_token, status, code) ? status : 'lost';
  }

  /** The AI call inside its AI points reservation; an answer that cannot be read is still billed. */
  async function draft(claim: OrgContextDistillClaim, kbId: string, documents: Array<{ id: string; size_bytes: number }>,
    signal: AbortSignal): Promise<OrgContextDistillResponse> {
    const runtime = await deps.runtime(claim.tenant_id);
    if (runtime.engine !== 'self_built_rag' || !runtime.providerKey) throw new OrgContextError('ORG_CONTEXT_NOT_READY');
    const settings = deps.settings();
    const estimate = orgContextDistillTokenEstimate(documents.reduce((sum, document) => sum + document.size_bytes, 0),
      settings.max_source_chars);
    const ids = documents.map(document => document.id);
    return deps.metered({
      tenantId: claim.tenant_id, userId: claim.requested_by, conversationId: null, target: 'lesson_author',
      operation: 'lesson_author', model: runtime.model, feature: 'ai_id_org_context', promptParts: [],
      extraInputTokens: estimate.inputTokens, maxOutputTokens: estimate.outputTokens, longRunning: true,
    }, async () => {
      let raw: unknown;
      try {
        raw = await deps.callAi({ tenant_id: claim.tenant_id, kb_id: kbId, document_ids: ids, locale: claim.locale,
          max_source_chars: settings.max_source_chars, model: runtime.model, correlation_id: claim.lease_token },
        { timeoutMs: settings.timeout_ms, signal });
      } catch (error) {
        if (error instanceof RagServiceError && error.usage) throw new BilledAiCallError(normalizeAiUsage(error.usage), error);
        throw error;
      }
      let response: OrgContextDistillResponse;
      try {
        response = readOrgContextDistillResponse(raw, ids);
      } catch (error) {
        const usage = reportedUsage(raw);
        if (usage) throw new BilledAiCallError(usage, error);
        throw error;
      }
      // Incomplete usage (an interrupted provider call) is charged at least the points it held.
      const usage = response.usage_complete ? response.usage : {
        inputTokens: Math.max(response.usage.inputTokens, estimate.inputTokens),
        outputTokens: Math.max(response.usage.outputTokens, estimate.outputTokens), embeddingTokens: response.usage.embeddingTokens,
        totalTokens: Math.max(response.usage.inputTokens, estimate.inputTokens)
          + Math.max(response.usage.outputTokens, estimate.outputTokens) + response.usage.embeddingTokens };
      return { value: response, usage };
    });
  }

  /** The draft becomes the current version, if this lease still owns the state row. */
  async function store(claim: OrgContextDistillClaim, response: OrgContextDistillResponse): Promise<'succeeded' | 'lost'> {
    return deps.transaction(async () => {
      if (!await deps.distill.lockLease(claim.tenant_id, claim.lease_token)) return 'lost';
      const version = await deps.repository.insertVersion(claim.tenant_id, { origin: 'ai_draft', profile: response.profile,
        profileHash: orgContextProfileHash(response.profile), charCount: orgContextProfileCharCount(response.profile),
        createdBy: claim.requested_by, sourceDocumentIds: response.source_document_ids, sourceChars: response.source_chars,
        sourceTruncated: response.truncated });
      return await deps.distill.finishSucceeded(claim.tenant_id, claim.lease_token, version) ? 'succeeded' : 'lost';
    });
  }

  /** Claims and runs at most one draft. */
  async function tick(signal: AbortSignal): Promise<OrgContextDistillOutcome> {
    const started = now();
    await deps.distill.failExhaustedLeases();
    const settings = deps.settings();
    const claim = await deps.distill.claim(id(), settings.timeout_ms + ORG_CONTEXT_DISTILL_LEASE_MARGIN_MS, deps.tenantFilter);
    if (!claim) return 'idle';
    let outcome: OrgContextDistillOutcome;
    let errorCode: string | null = null;
    let documents: Array<{ id: string; size_bytes: number }> = [];
    let providerCalls: number | null = null;
    try {
      const kbId = await deps.repository.contextKbId(claim.tenant_id);
      documents = kbId ? await deps.repository.learnedDocuments(claim.tenant_id, kbId, ORG_CONTEXT_DISTILL_MAX_DOCUMENTS) : [];
      if (!kbId || !documents.length) throw new OrgContextError('ORG_CONTEXT_NO_LEARNED_DOCUMENTS');
      const response = await draft(claim, kbId, documents, signal);
      providerCalls = response.provider_calls;
      outcome = await store(claim, response);
    } catch (error) {
      errorCode = orgContextDistillErrorCode(signal.aborted ? { code: 'ORG_CONTEXT_DISTILL_INTERRUPTED' } : error);
      outcome = await finishFailed(claim, signal.aborted ? { code: 'ORG_CONTEXT_DISTILL_INTERRUPTED' } : error);
    }
    report({ event: 'org_context_distill_finished', tenant_id: claim.tenant_id, outcome, attempts: claim.attempts,
      error_code: errorCode, source_documents: documents.length, provider_calls: providerCalls, duration_ms: now() - started });
    return outcome;
  }

  return { tick };
}

// --- Production loop (background process) --------------------------------------------------------
function productionTenantFilter(firstParameter: number): OrgContextTenantFilter {
  const fence = runtimeTenantSql('s.tenant_id', firstParameter);
  const allowlist = env.LESSON_AUTHOR_ORG_CONTEXT_TENANT_ALLOWLIST;
  if (!allowlist.length) return fence;
  return { clause: `${fence.clause} AND s.tenant_id = ANY($${firstParameter + fence.params.length}::uuid[])`,
    params: [...fence.params, [...allowlist]] };
}

let worker: ReturnType<typeof createOrgContextDistillWorker> | null = null;
let draining: Promise<void> | null = null;
let abort: AbortController | null = null;

function productionWorker(): ReturnType<typeof createOrgContextDistillWorker> {
  worker ??= createOrgContextDistillWorker({
    distill: createOrgContextDistillRepository({ query }),
    repository: createOrgContextRepository({ query }),
    transaction: work => withDatabaseTransaction(() => work()),
    settings: () => ({ timeout_ms: env.LESSON_AUTHOR_ORG_CONTEXT_DISTILL_TIMEOUT_MS,
      max_source_chars: env.LESSON_AUTHOR_ORG_CONTEXT_DISTILL_MAX_SOURCE_CHARS }),
    tenantFilter: productionTenantFilter,
    runtime: async tenantId => {
      const settings = await getTenantAiRuntimeSettings(tenantId);
      return { engine: settings.activeEngine, model: resolveOrchestrationV2LessonAuthorModel(settings.lessonAuthorModel),
        providerKey: settings.hasGoogleAiStudioKey };
    },
    metered: (call, run) => withMeteredAiCall(call, run),
    callAi: distillRagOrgContext,
    report: record => {
      const line = '[LessonAuthorOrgContextDistill] ' + JSON.stringify(record);
      if (record.outcome === 'failed' || record.outcome === 'error') console.warn(line); else console.info(line);
    },
  });
  return worker;
}

async function drain(signal: AbortSignal): Promise<void> {
  const started = Date.now();
  try {
    while (!signal.aborted && await productionWorker().tick(signal) !== 'idle') { /* next claim */ }
  } catch (error) {
    // The loop itself failed (database down); the next poll tries again. Logged with its code only.
    console.warn('[LessonAuthorOrgContextDistill] ' + JSON.stringify({ event: 'org_context_distill_worker_failed',
      tenant_id: null, outcome: 'error', attempts: null, error_code: orgContextDistillErrorCode(error),
      source_documents: null, provider_calls: null, duration_ms: Date.now() - started } satisfies OrgContextDistillDiagnostic));
  }
}

/** Starts the poller (LESSON_AUTHOR_ORG_CONTEXT_DISTILL_POLL_MS); one draft at a time in this process. */
export function startOrgContextDistillWorker(): NodeJS.Timeout {
  abort ??= new AbortController();
  const signal = abort.signal;
  return setInterval(() => {
    if (draining || signal.aborted || processLifecycle.isShuttingDown()) return;
    draining = drain(signal).finally(() => { draining = null; });
  }, env.LESSON_AUTHOR_ORG_CONTEXT_DISTILL_POLL_MS);
}

/** Shutdown: an in-flight AI call is aborted (its reservation released, the draft queued again) and awaited. */
export async function stopOrgContextDistillWorker(): Promise<void> {
  abort?.abort();
  await draining;
}
