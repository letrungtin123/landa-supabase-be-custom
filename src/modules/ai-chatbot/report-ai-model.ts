import { ThinkingLevel, type ThinkingConfig } from '@google/genai';
import { env } from '../../config/env.js';

/**
 * Model and generation settings shared by the AI Report calls (question router,
 * chat narrative, PDF narrative). They use one platform model (REPORT_AI_MODEL,
 * default gemini-3.8-flash, the model AI ID already runs on) instead of the
 * tenant chat model, so report quality and cost are tuned in one place.
 *
 * Gemini 3.x models think before answering and count those thought tokens
 * against maxOutputTokens: a small visible-output cap (256 for the router, 800
 * or 1,600 for narratives) can be spent entirely on thinking and return
 * truncated JSON. Every call therefore adds a thinking headroom on top of the
 * visible output; Gemini 3.8 also gets a low thinking level and no temperature
 * (it rejects the legacy sampling parameters).
 */
export const REPORT_AI_THINKING_HEADROOM_TOKENS = 1_024;

export function resolveReportAiModel(tenantChatModel: string): string {
  return env.REPORT_AI_MODEL.trim() || tenantChatModel;
}

/** Same rule as the AI service (landa-ai-rag app/services/provider.py): only Gemini 3.8 gets the
 * thinking-level contract and no sampling parameters; other models keep their defaults. */
function isGemini38(model: string): boolean {
  return (model.trim().toLowerCase().split('/').pop() ?? '') === 'gemini-3.8-flash';
}

export interface ReportAiGenerationConfig {
  maxOutputTokens: number;
  temperature?: number;
  thinkingConfig?: ThinkingConfig;
}

export function reportAiGenerationConfig(model: string, visibleOutputTokens: number,
  options: { temperature?: number } = {}): ReportAiGenerationConfig {
  const config: ReportAiGenerationConfig = {
    maxOutputTokens: visibleOutputTokens + REPORT_AI_THINKING_HEADROOM_TOKENS,
  };
  if (isGemini38(model)) config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
  else if (options.temperature !== undefined) config.temperature = options.temperature;
  return config;
}
