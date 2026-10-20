/**
 * Safe failure diagnostics for the V2 worker telemetry. Everything returned
 * here is a fixed token, a canonical workspace path or a source location of
 * this code base: never an error message, content, fact text or provider output.
 */

const STAGE = /^[a-z][a-z0-9_]{0,79}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const CANONICAL_PATH = /^chapter_[1-9][0-9]{0,4}(?:\.lesson_[1-9][0-9]{0,4}(?:\.unit_[1-9][0-9]{0,4}(?:\.component_[1-9][0-9]{0,4})?)?)?$/;
// "at fn (D:\app\dist\modules\x.js:12:5)", "at file:///app/src/x.ts:12:5", "at async D:\app\src\x.ts:12:5"
const FRAME_LOCATION = /(?:\(|\s)(?:file:\/\/\/?)?([^()\s]+?):(\d{1,7}):\d{1,7}\)?\s*$/;
const ROOT = /(?:^|\/)(?:src|dist)\/((?:modules|platform|config|middleware|utils|workers|scripts)\/[A-Za-z0-9_./-]{1,200})$/;
const SITE = /^[A-Za-z0-9_./-]{1,200}:\d{1,7}$/;
const MAX_FRAMES = 40;

/**
 * Top stack frame that belongs to this application, as "<path under src|dist>:<line>".
 * Node internals and node_modules frames are skipped; the first stack line
 * (the error message) is never read.
 */
export function orchestrationV2ErrorSite(error: unknown): string | null {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : null;
  if (!stack) return null;
  // V8 starts the stack with "<name>: <message>"; a multi-line message must
  // never be mistaken for frames, so skip exactly its lines first.
  const headerLines = String(error instanceof Error ? error.message : '').split('\n').length;
  const frames = stack.split('\n').slice(headerLines).map(line => line.trim())
    .filter(line => line.startsWith('at ')).slice(0, MAX_FRAMES);
  for (const frame of frames) {
    if (frame.includes('node_modules') || frame.includes('node:') || frame.includes(' (native)')) continue;
    const location = FRAME_LOCATION.exec(frame);
    if (!location) continue;
    const file = location[1]!.replaceAll('\\', '/');
    const relative = ROOT.exec(file)?.[1];
    const site = relative ? `${relative}:${location[2]}` : null;
    if (site && SITE.test(site)) return site;
  }
  return null;
}

/** Tag the step an error escaped from; the first (innermost) tag wins. */
export function tagOrchestrationV2Stage(error: unknown, stage: string): void {
  if (!STAGE.test(stage) || !error || typeof error !== 'object'
    || typeof (error as { orchestration_stage?: unknown }).orchestration_stage === 'string') return;
  try {
    Object.defineProperty(error, 'orchestration_stage', { value: stage, enumerable: true });
  } catch {
    // Some third-party errors may be frozen. Preserve the authoritative
    // error rather than replacing it only for telemetry metadata.
  }
}

/** Run one step and tag any error it throws with that step, then rethrow it unchanged. */
export async function atOrchestrationV2Stage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    tagOrchestrationV2Stage(error, stage);
    throw error;
  }
}

/**
 * How a finished run ended, for success reporting. A run whose content is all
 * written but whose held assessment questions wait for the author
 * (ASSESSMENT_REVIEW_REQUIRED) counts as completed, with review.
 */
export type OrchestrationV2RunOutcome = 'completed' | 'completed_with_review';
export const ORCHESTRATION_V2_RUN_OUTCOMES: readonly OrchestrationV2RunOutcome[] = ['completed', 'completed_with_review'];

/** `run_outcome` field of the finalizer's success event; nothing for any other task. */
export function orchestrationV2RunOutcomeFields(taskKind: string, result: unknown): Record<string, OrchestrationV2RunOutcome> {
  return taskKind === 'finalize_course' && ORCHESTRATION_V2_RUN_OUTCOMES.includes(result as OrchestrationV2RunOutcome)
    ? { run_outcome: result as OrchestrationV2RunOutcome } : {};
}

/** Chapter validation diagnosis (`chapter_evidence`) as two safe log fields. */
export function orchestrationV2ChapterEvidenceFields(error: object): Record<string, string> {
  const diagnosis = (error as { chapter_evidence?: unknown }).chapter_evidence;
  if (!diagnosis || typeof diagnosis !== 'object') return {};
  const { reason, path } = diagnosis as { reason?: unknown; path?: unknown };
  if (typeof reason !== 'string' || !REASON.test(reason)) return {};
  return { chapter_reason: reason,
    ...(typeof path === 'string' && CANONICAL_PATH.test(path) ? { chapter_reason_path: path } : {}) };
}
