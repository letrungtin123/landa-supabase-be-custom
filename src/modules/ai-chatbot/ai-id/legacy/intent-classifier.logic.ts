// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import {
  classifyLessonAuthorIntent,
  detectLessonAuthorInputLocale,
  type LessonAuthorIntentPlan,
  type LessonAuthorCreationContext,
} from '../shared/lesson-author-intent.logic.js';
import type { LessonAuthorIntent, IntentSignal, LessonAuthorOutlineMention } from './types.js';

interface IntentClassificationResult {
  intent: LessonAuthorIntent;
  operationPlan: LessonAuthorIntentPlan;
  signals: IntentSignal[];
  score: number;
  input_locale: ReturnType<typeof detectLessonAuthorInputLocale>;
}

export function classifyLessonAuthorIntentV2(
  userPrompt: string,
  outlineMentions: LessonAuthorOutlineMention[],
  mode: 'chat' | 'course_blueprint' | 'draft_lesson' | 'auto',
  mentionSource?: 'current' | 'editor_context' | 'carried_forward',
  creationContext?: LessonAuthorCreationContext,
): IntentClassificationResult {
  const operationPlan = classifyLessonAuthorIntent({
    message: userPrompt,
    mode,
    mention: outlineMentions[0] ?? null,
    carriedTarget: outlineMentions.length > 0,
    mentionSource,
    creationContext,
  });
  const signals: IntentSignal[] = operationPlan.signals.map((name) => ({
    name: name === 'delete_verb' ? 'delete_intent' : name,
    weight: name === 'delete_verb' ? -99 : 1,
    matched: true,
  }));
  const intent: LessonAuthorIntent = operationPlan.operation === 'course_blueprint'
    ? 'course_blueprint'
    : operationPlan.operation === 'answer' || operationPlan.operation === 'clarify'
      ? 'chat'
      : 'draft_lesson';
  return {
    intent,
    operationPlan,
    signals,
    score: intent === 'chat' ? -Math.round((1 - operationPlan.confidence) * 100) : Math.round(operationPlan.confidence * 100),
    input_locale: detectLessonAuthorInputLocale(userPrompt),
  };
}
