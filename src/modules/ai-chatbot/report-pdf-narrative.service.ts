// ═══════════════════════════════════════════════════════════════
// Gemini-written PDF narrative (behind REPORT_PDF_AI_NARRATIVE_ENABLED).
// Gemini receives only fact statements built from the snapshot, with course and
// unit names replaced by tokens. The answer is schema-checked and every number
// must match a cited fact; otherwise the caller keeps the rule-based narrative.
// Token usage goes through the tenant AI quota (reserve -> finalize/release).
// ═══════════════════════════════════════════════════════════════
import { env } from '../../config/env.js';
import type { AiUsage, TenantAiRuntimeSettings } from './ai-engine.types.js';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import {
  estimateTokensFromText,
  finalizeTenantAiTokens,
  releaseTenantAiTokenReservation,
  reserveTenantAiTokens,
} from './ai-token-quota.service.js';
import { getGeminiClient } from './gemini.service.js';
import type { ReportInsights } from './report-insights.logic.js';
import type { ReportPdfLocale } from './report-pdf-i18n.js';
import {
  buildReportPdfAiNarrativeRequest,
  toReportPdfAiNarrative,
  validateReportPdfNarrative,
  type ReportPdfNarrative,
} from './report-pdf-narrative.logic.js';

const MAX_OUTPUT_TOKENS = 1_600;
const MIN_OUTPUT_TOKENS = 500;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'OBJECT', properties: { text: { type: 'STRING' }, fact_ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['text', 'fact_ids'] },
    findings: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, fact_ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['text', 'fact_ids'] } },
    risks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, fact_ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['text', 'fact_ids'] } },
    recommendations: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, fact_ids: { type: 'ARRAY', items: { type: 'STRING' } }, priority: { type: 'STRING', enum: ['high', 'medium', 'low'] } }, required: ['text', 'fact_ids', 'priority'] } },
  },
  required: ['headline', 'findings', 'risks', 'recommendations'],
} as const;

export interface ReportPdfAiGenerateInput {
  tenantId: string;
  model: string;
  systemInstruction: string;
  payload: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ReportPdfAiNarrativeDeps {
  enabled: () => boolean;
  timeoutMs: number;
  getSettings: (tenantId: string) => Promise<TenantAiRuntimeSettings>;
  reserve: typeof reserveTenantAiTokens;
  finalize: typeof finalizeTenantAiTokens;
  release: typeof releaseTenantAiTokenReservation;
  generate: (input: ReportPdfAiGenerateInput) => Promise<{ text: string; usage: Partial<AiUsage> | null }>;
  log: (event: Record<string, unknown>) => void;
}

async function generateWithGemini(input: ReportPdfAiGenerateInput): Promise<{ text: string; usage: Partial<AiUsage> | null }> {
  const client = await getGeminiClient(input.tenantId);
  const response = await client.models.generateContent({
    model: input.model,
    contents: [{ role: 'user', parts: [{ text: input.payload }] }],
    config: {
      systemInstruction: input.systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: input.maxOutputTokens,
      temperature: 0.3,
      abortSignal: input.signal,
    },
  });
  const usage = response.usageMetadata;
  return {
    text: response.text ?? '',
    usage: usage ? {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      totalTokens: usage.totalTokenCount ?? undefined,
    } : null,
  };
}

export const defaultReportPdfAiNarrativeDeps: ReportPdfAiNarrativeDeps = {
  enabled: () => env.REPORT_PDF_AI_NARRATIVE_ENABLED,
  timeoutMs: env.REPORT_PDF_AI_NARRATIVE_TIMEOUT_MS,
  getSettings: (tenantId) => getTenantAiRuntimeSettings(tenantId),
  reserve: reserveTenantAiTokens,
  finalize: finalizeTenantAiTokens,
  release: releaseTenantAiTokenReservation,
  generate: generateWithGemini,
  log: (event) => console.info(`[ReportPdf] ${JSON.stringify(event)}`),
};

/**
 * Returns a writer for composeReportPdfDocument. It never throws: any failure
 * (disabled, no key, quota, timeout, invalid JSON, unverifiable number) yields
 * null so the deterministic narrative is used.
 */
export function createReportPdfAiNarrativeWriter(
  context: { tenantId: string; userId: string; conversationId: string; requestId: string },
  deps: ReportPdfAiNarrativeDeps = defaultReportPdfAiNarrativeDeps,
): (insights: ReportInsights, locale: ReportPdfLocale) => Promise<ReportPdfNarrative | null> {
  return async (insights, locale) => {
    if (!deps.enabled() || !insights.available) return null;
    const base = { event: 'report_pdf_ai_narrative', request_id: context.requestId, tenant_id: context.tenantId };
    const request = buildReportPdfAiNarrativeRequest(insights, locale);
    let reservationId: string | null = null;
    try {
      const settings = await deps.getSettings(context.tenantId);
      if (!settings.hasGoogleAiStudioKey) {
        deps.log({ ...base, outcome: 'skipped', reason: 'no_provider_key' });
        return null;
      }
      const inputTokens = estimateTokensFromText(request.systemInstruction, request.payload);
      const grant = await deps.reserve({
        tenantId: context.tenantId,
        userId: context.userId,
        conversationId: context.conversationId,
        target: 'admin',
        engine: settings.activeEngine,
        provider: settings.provider,
        model: settings.chatModel,
        operation: 'chat',
        minimumTokens: inputTokens + MIN_OUTPUT_TOKENS,
        maximumTokens: inputTokens + MAX_OUTPUT_TOKENS,
        budget: { inputTokens, outputTokens: MAX_OUTPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, metadata: { budget_version: 2, operation: 'chat', report_pdf: true } },
      });
      reservationId = grant.id;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
      let response: Awaited<ReturnType<ReportPdfAiNarrativeDeps['generate']>>;
      try {
        response = await deps.generate({
          tenantId: context.tenantId,
          model: settings.chatModel,
          systemInstruction: request.systemInstruction,
          payload: request.payload,
          maxOutputTokens: Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, grant.reservedTokens - inputTokens)),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const usedInput = response.usage?.inputTokens ?? inputTokens;
      const usedOutput = response.usage?.outputTokens ?? estimateTokensFromText(response.text);
      const usage: AiUsage = { inputTokens: usedInput, outputTokens: usedOutput, embeddingTokens: 0, totalTokens: response.usage?.totalTokens ?? usedInput + usedOutput };
      await deps.finalize({ reservationId, tenantId: context.tenantId, usage, metadata: { report_pdf: true } });
      reservationId = null;
      let parsed: unknown = null;
      try { parsed = JSON.parse(response.text); } catch { parsed = null; }
      const narrative = toReportPdfAiNarrative(parsed, insights);
      if (!narrative) {
        deps.log({ ...base, outcome: 'rejected', reason: 'schema' });
        return null;
      }
      const validation = validateReportPdfNarrative(narrative, insights, locale);
      if (!validation.ok) {
        // Issue codes only (they contain no narrative text or tenant data).
        deps.log({ ...base, outcome: 'rejected', reason: 'validation', issues: validation.issues.map((issue) => issue.split(':').slice(0, 2).join(':')).slice(0, 10) });
        return null;
      }
      deps.log({ ...base, outcome: 'accepted' });
      return narrative;
    } catch (error) {
      if (reservationId) await deps.release(reservationId, context.tenantId).catch(() => undefined);
      const code = (error as { code?: unknown })?.code;
      deps.log({ ...base, outcome: 'failed', reason: typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  };
}
