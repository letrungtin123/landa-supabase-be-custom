import type { ChapterAttemptRow, ChapterDraftRow, ChapterUnitPayload, ChapterUnitRow } from './lesson-author-chapter-checkpoint.logic.js';
import { ChapterCheckpointError, assertChapterCheckpoints } from './lesson-author-chapter-checkpoint.logic.js';
import type { ChapterExecutionFailure } from './lesson-author-chapter-checkpoint.repository.js';
import type { RagChapterFinalResponse, RagChapterUnitResponse } from './lesson-author-chapter-rag-contract.logic.js';

export class ChapterWorkflowTimeout extends Error { readonly code = 'CHAPTER_WORKFLOW_TIMEOUT'; }

/** Caller supplies a code only from the authenticated Python transport error. */
export function chapterExternalFailureCode(pythonCode: unknown, timeout: boolean): string {
  return timeout || pythonCode === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : 'LESSON_VALIDATION_FAILED';
}

export function chapterFailureMessage(locale: 'vi' | 'en', timeout: boolean, externalCode: string): string {
  if (timeout) return locale === 'en'
    ? 'Chapter drafting was interrupted. Your completed units are saved; you can continue.'
    : 'Soạn chương bị gián đoạn. Các unit đã hoàn tất được lưu; bạn có thể tiếp tục.';
  if (externalCode === 'PROVIDER_ERROR') return locale === 'en'
    ? 'The AI service could not complete chapter generation. No course changes were applied.'
    : 'Dịch vụ AI chưa thể hoàn tất soạn chương. Chưa có thay đổi nào được áp dụng vào khóa học.';
  return locale === 'en' ? 'Chapter content did not pass validation. No course changes were applied.'
    : 'Nội dung chương chưa vượt qua kiểm tra. Chưa có thay đổi nào được áp dụng vào khóa học.';
}
export interface ChapterRunDependencies {
  revalidate(): Promise<void>;
  validateUnit(unit: ChapterUnitPayload, index: number): Promise<void>;
  renew(): Promise<void>;
  markDispatched(index: number): Promise<void>;
  markFinalValidation(): Promise<void>;
  generate(index: number, signal: AbortSignal, remainingMs: number): Promise<RagChapterUnitResponse>;
  commit(index: number, unit: ChapterUnitPayload): Promise<void>;
  validateChapter(units: Array<{unit_index: number; unit: ChapterUnitPayload}>, signal: AbortSignal, remainingMs: number): Promise<RagChapterFinalResponse>;
  publish(result: RagChapterFinalResponse, accounting: ChapterUsageLedger): Promise<void>;
  interrupt(failure: ChapterExecutionFailure, timeout: boolean, accounting: ChapterUsageLedger): Promise<void>;
  classify(error: unknown): ChapterExecutionFailure & { timeout: boolean; leaseLost?: boolean };
  report(event: Record<string, unknown>): void;
  now?: () => number;
  heartbeatMs?: number;
}
export interface ChapterUsageLedger {
  complete: boolean;
  dispatched: boolean;
  inputTokens: number; outputTokens: number; embeddingTokens: number; totalTokens: number;
}

/** Awaited request runner, not a requeue worker. DB leases fence all late writes.
 * Never race a DB commit against cancellation: wait for its definitive result.
 */
export async function runChapterCheckpoint(draft: ChapterDraftRow, attempt: ChapterAttemptRow,
  stored: readonly ChapterUnitRow[], deps: ChapterRunDependencies): Promise<'ready' | 'interrupted' | 'failed'> {
  const now = deps.now ?? Date.now;
  const started = now();
  const end = Math.min(started + 480_000, attempt.deadline_at.getTime() - 60_000);
  const controller = new AbortController();
  const ledger: ChapterUsageLedger = { complete: true, dispatched: false, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, totalTokens: 0 };
  let pending = false;
  let stage = 'chapter_checkpoint_prepare';
  const report = (event: string, extra: Record<string, unknown> = {}) => deps.report({ event,
    correlation_id: attempt.correlation_id, conversation_id: draft.conversation_id, draft_id: draft.id,
    attempt_id: attempt.id, failure_stage: stage, duration_ms: now()-started, ...extra });
  const remaining = () => {
    controller.signal.throwIfAborted();
    const ms = Math.floor(end-now());
    if (ms <= 0) throw new ChapterWorkflowTimeout();
    return ms;
  };
  const deadline = setTimeout(() => controller.abort(new ChapterWorkflowTimeout()), Math.max(0,end-now()));
  let renewal: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (renewal || controller.signal.aborted) return;
    renewal = deps.renew().catch(() => controller.abort(new ChapterCheckpointError('CHAPTER_CHECKPOINT_LEASE_LOST')))
      .finally(() => { renewal = null; });
  }, deps.heartbeatMs ?? 15_000);
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<never>((_,reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort',rejectAbort,{once:true});
  });
  void abort.catch(() => undefined);
  const wait = <T>(work: Promise<T>) => Promise.race([work,abort]);
  const account = (response: RagChapterUnitResponse | RagChapterFinalResponse) => {
    if (!response.usage_complete) ledger.complete = false;
    for (const key of ['inputTokens','outputTokens','embeddingTokens','totalTokens'] as const) {
      const amount = response.usage[key];
      if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) ledger[key] += amount;
      else ledger.complete = false;
    }
  };
  try {
    assertChapterCheckpoints(draft,stored);
    remaining();
    await wait(deps.revalidate());
    const units = stored.map(row => ({unit_index: row.unit_index,unit: structuredClone(row.payload)}));
    for (const row of units) { remaining(); await wait(deps.validateUnit(row.unit,row.unit_index)); }
    const done = new Set(units.map(row => row.unit_index));
    report('chapter_checkpoint_started',{reused_unit_count:done.size,total_units:draft.total_units});
    for (const contract of draft.unit_contracts) {
      if (done.has(contract.index)) continue;
      remaining();
      await wait(deps.revalidate());
      stage = 'chapter_unit_dispatch';
      await deps.markDispatched(contract.index);
      // Persisted dispatch marker means an exception before HTTP is still uncertain.
      ledger.dispatched = true; pending = true;
      remaining();
      report('chapter_unit_dispatched',{unit_index:contract.index,remaining_workflow_budget_ms:remaining()});
      const result = await wait(deps.generate(contract.index,controller.signal,remaining()));
      account(result); pending = false;
      if (result.unit_index !== contract.index) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
      stage = 'chapter_unit_acceptance';
      remaining();
      await wait(deps.validateUnit(result.unit,contract.index));
      remaining();
      await deps.commit(contract.index,result.unit);
      units.push({unit_index:contract.index,unit:result.unit});
      report('chapter_unit_committed',{unit_index:contract.index,completed_units:units.length,total_units:draft.total_units});
    }
    stage = 'chapter_final_validation';
    await wait(deps.revalidate());
    remaining();
    await deps.markFinalValidation();
    ledger.dispatched=true;
    // Final validation may retrieve/resolve evidence; its missing usage is not zero.
    pending = true;
    const result = await wait(deps.validateChapter(units.sort((a,b)=>a.unit_index-b.unit_index),controller.signal,remaining()));
    account(result); pending = false;
    stage = 'chapter_publication';
    remaining();
    await deps.publish(result,ledger);
    report('chapter_checkpoint_ready',{completed_units:units.length});
    return 'ready';
  } catch (error) {
    if (pending) ledger.complete = false;
    const failure = deps.classify(error);
    report('chapter_checkpoint_failed',{internal_failure_code:failure.internalCode,external_failure_code:failure.externalCode,
      failure_stage:failure.stage || stage,usage_complete:ledger.complete});
    if (!failure.leaseLost) await deps.interrupt(failure,failure.timeout,ledger);
    return failure.timeout || failure.leaseLost ? 'interrupted' : 'failed';
  } finally {
    clearTimeout(deadline); clearInterval(heartbeat);
    if (rejectAbort) controller.signal.removeEventListener('abort',rejectAbort);
    if (renewal) await renewal;
  }
}
