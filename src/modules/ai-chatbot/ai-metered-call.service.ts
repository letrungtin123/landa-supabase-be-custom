// One provider call made directly by the backend, inside the tenant AI quota:
// reserve the most the call can cost (prompt estimate + output cap, thinking
// included), run it, finalize with the provider's own usage (an estimate only
// when the provider returned none) and release the reservation when the call
// failed before an answer. Every direct Gemini call outside a chat turn's own
// reservation goes through here so the ledger sees all spend.
import type { AiChatTarget, AiOperation, AiUsage, TenantAiRuntimeSettings } from './ai-engine.types.js';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import {
  estimateTokensFromText,
  finalizeTenantAiTokens,
  normalizeAiUsage,
  releaseTenantAiTokenReservation,
  reserveTenantAiTokens,
} from './ai-token-quota.service.js';

export interface MeteredAiCall {
  tenantId: string;
  userId: string | null;
  conversationId: string | null;
  target: AiChatTarget;
  operation: AiOperation;
  model: string;
  /** Ledger label of the feature (e.g. report_chat_router, video_transcription). */
  feature: string;
  /** Prompt texts, for the reservation estimate and the fallback when the provider reports no usage. */
  promptParts: ReadonlyArray<string | null | undefined>;
  /** Input tokens the prompt texts do not show (an audio file, an uploaded document). */
  extraInputTokens?: number;
  /** The provider's output cap for this call, thinking included. */
  maxOutputTokens: number;
  /** A call that can outlast the reservation lifetime (a long audio file): the reservation is never
   * expired by the sweeper, only finalized or released here. */
  longRunning?: boolean;
}

/**
 * Thrown by a call that reached the provider (and was billed) but whose
 * answer is unusable: the wrapper settles the provider usage, then rethrows
 * `cause`, so failed-but-billed calls still count against the budget.
 */
export class BilledAiCallError extends Error {
  constructor(readonly usage: AiUsage, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'BilledAiCallError';
  }
}

export interface MeteredAiResult<T> {
  value: T;
  usage: AiUsage | null;
  /** Answer text, used only to estimate output when usage is null. */
  outputText?: string;
}

export interface MeteredAiDeps {
  settings: (tenantId: string) => Promise<TenantAiRuntimeSettings>;
  reserve: typeof reserveTenantAiTokens;
  finalize: typeof finalizeTenantAiTokens;
  release: typeof releaseTenantAiTokenReservation;
}

export const defaultMeteredAiDeps: MeteredAiDeps = {
  settings: getTenantAiRuntimeSettings,
  reserve: reserveTenantAiTokens,
  finalize: finalizeTenantAiTokens,
  release: releaseTenantAiTokenReservation,
};

export async function withMeteredAiCall<T>(
  call: MeteredAiCall,
  run: () => Promise<MeteredAiResult<T>>,
  deps: MeteredAiDeps = defaultMeteredAiDeps,
): Promise<T> {
  const settings = await deps.settings(call.tenantId);
  const inputTokens = estimateTokensFromText(...call.promptParts) + Math.max(0, Math.ceil(call.extraInputTokens ?? 0));
  const outputTokens = Math.max(1, Math.ceil(call.maxOutputTokens));
  const grant = await deps.reserve({
    tenantId: call.tenantId,
    userId: call.userId,
    conversationId: call.conversationId,
    target: call.target,
    engine: settings.activeEngine,
    provider: settings.provider,
    model: call.model,
    operation: call.operation,
    minimumTokens: inputTokens + outputTokens,
    maximumTokens: inputTokens + outputTokens,
    budget: { inputTokens, outputTokens, maxOutputTokens: outputTokens,
      metadata: { budget_version: 2, operation: call.operation, feature: call.feature,
        ...(call.longRunning ? { durable_generation: true } : {}) } },
  });
  let result: MeteredAiResult<T>;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof BilledAiCallError) {
      await deps.finalize({
        reservationId: grant.id, tenantId: call.tenantId, usage: normalizeAiUsage(error.usage),
        source: { service: 'backend_direct', usage_source: 'provider' }, metadata: { feature: call.feature, failed_after_billing: true },
      }).catch(() => deps.release(grant.id, call.tenantId).catch(() => undefined));
      throw error.cause;
    }
    await deps.release(grant.id, call.tenantId).catch(() => undefined);
    throw error;
  }
  const usage = result.usage ?? (() => {
    const output = estimateTokensFromText(result.outputText);
    return { inputTokens, outputTokens: output, embeddingTokens: 0, totalTokens: inputTokens + output };
  })();
  try {
    await deps.finalize({
      reservationId: grant.id,
      tenantId: call.tenantId,
      usage: normalizeAiUsage(usage),
      source: { service: 'backend_direct', usage_source: result.usage ? 'provider' : 'local_estimate' },
      metadata: { feature: call.feature },
    });
  } catch (error) {
    // The answer was paid for and is kept; the unsettled reservation stays visible for reconciliation.
    console.error('[AI Metering] Failed to finalize a provider call', {
      tenant_id: call.tenantId, reservation_id: grant.id, feature: call.feature,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result.value;
}
