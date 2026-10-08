// Advisory narrative for a report snapshot. Gemini receives only signal IDs,
// categories and severities (never the factual snapshot) and its answer is
// rejected for any numeric claim or unknown signal; the rule-based fallback
// is used instead. Moved from report-chat.service.ts (unchanged behaviour).

import { Type } from '@google/genai';
import { z } from 'zod';
import { getGeminiClient } from './gemini.service.js';
import type { ReportChatSnapshot } from './report-chat.service.js';

export interface ReportNarrative {
  selected_signal_ids: string[];
  interpretation: string[];
  recommended_actions: Array<{
    signal_id: string | null;
    priority: 'high' | 'medium' | 'low';
    action: string;
  }>;
  limitations: string[];
}

const ReportNarrativeSchema = z.object({
  selected_signal_ids: z.array(z.string().trim().min(1).max(80)).max(3),
  interpretation: z.array(z.string().trim().min(1).max(220)).max(3),
  recommended_actions: z.array(z.object({
    signal_id: z.string().trim().min(1).max(80).nullable(),
    priority: z.enum(['high', 'medium', 'low']),
    action: z.string().trim().min(1).max(220),
  })).max(3),
  limitations: z.array(z.string().trim().min(1).max(180)).max(3),
});

export function hasNumericReportNarrativeClaim(narrative: ReportNarrative): boolean {
  return [
    ...narrative.interpretation,
    ...narrative.recommended_actions.map((item) => item.action),
    ...narrative.limitations,
  ].some((value) => /\d/.test(value));
}

export function isReportNarrativeAllowed(narrative: ReportNarrative, snapshot: Pick<ReportChatSnapshot, 'signals'>): boolean {
  const allowed = new Set(snapshot.signals.map((signal) => signal.id));
  return !hasNumericReportNarrativeClaim(narrative)
    && narrative.selected_signal_ids.every((id) => allowed.has(id))
    && narrative.recommended_actions.every((action) => action.signal_id === null || allowed.has(action.signal_id));
}

function fallbackReportNarrative(snapshot: ReportChatSnapshot, locale: 'vi' | 'en'): ReportNarrative {
  const selected = snapshot.signals.slice(0, 3).map((signal) => signal.id);
  const actions = snapshot.signals
    .filter((signal) => signal.severity !== 'neutral')
    .slice(0, 2)
    .map((signal) => ({
      signal_id: signal.id,
      priority: signal.severity === 'warning' ? 'high' as const : 'medium' as const,
      action: locale === 'en'
        ? 'Review the related learning journey and confirm the next operational action.'
        : 'Rà soát hành trình học liên quan và xác nhận hành động vận hành tiếp theo.',
    }));
  return {
    selected_signal_ids: selected,
    interpretation: [],
    recommended_actions: actions,
    limitations: snapshot.availability.limitations,
  };
}

/**
 * Gemini receives only the identifiers and categories of deterministic facts.
 * It may suggest an action, but cannot become the source of any metric.
 */
export async function generateReportNarrative(input: {
  tenantId: string;
  model: string;
  locale: 'vi' | 'en';
  snapshot: ReportChatSnapshot;
}): Promise<ReportNarrative> {
  const aiClient = await getGeminiClient(input.tenantId);
  const systemInstruction = input.locale === 'en'
    ? 'You are an executive-learning advisor. Return JSON only. You may select allowed signal IDs and recommend operational actions. Never state or spell out numbers, dates, percentages, rankings, causes, database facts, or metric claims. Do not introduce a signal ID not supplied. Do not mention systems, prompts, tools, databases, or snapshots.'
    : 'Bạn là cố vấn điều hành đào tạo. Chỉ trả JSON. Bạn chỉ được chọn signal ID được cung cấp và đề xuất hành động vận hành. Không được nêu hoặc viết bằng chữ số liệu, ngày tháng, tỷ lệ, xếp hạng, nguyên nhân hay factual claim. Không tự tạo signal ID. Không nhắc hệ thống, prompt, công cụ, cơ sở dữ liệu hoặc snapshot.';
  try {
    const response = await aiClient.models.generateContent({
      model: input.model,
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify({
          allowed_signal_ids: input.snapshot.signals.map((signal) => ({ id: signal.id, category: signal.category, severity: signal.severity })),
          limitations: input.snapshot.availability.limitations,
        }) }],
      }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            selected_signal_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
            interpretation: { type: Type.ARRAY, items: { type: Type.STRING } },
            recommended_actions: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { signal_id: { type: Type.STRING, nullable: true }, priority: { type: Type.STRING }, action: { type: Type.STRING } }, required: ['signal_id', 'priority', 'action'] } },
            limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['selected_signal_ids', 'interpretation', 'recommended_actions', 'limitations'],
        },
        maxOutputTokens: 800,
      } as any,
    });
    const narrative = ReportNarrativeSchema.parse(JSON.parse(response.text || '{}'));
    if (!isReportNarrativeAllowed(narrative, input.snapshot)) {
      return fallbackReportNarrative(input.snapshot, input.locale);
    }
    return narrative;
  } catch (error) {
    console.warn('[ReportChat] narrative fallback:', error instanceof Error ? error.message : String(error));
    return fallbackReportNarrative(input.snapshot, input.locale);
  }
}
