import { Buffer } from 'node:buffer';
import type { OrchestrationV2ChapterReceipt } from './lesson-author-orchestration-v2-chapter.logic.js';
import {
  orchestrationV2Hash,
  sealOrchestrationV2PersistedManifest,
  type OrchestrationV2PersistedManifest,
  type OrchestrationV2PersistedTask,
} from './lesson-author-orchestration-v2.logic.js';

export const ORCHESTRATION_V2_COURSE_CONTRACT = 'orchestration-course-finalization-v2';

export interface OrchestrationV2FinalizationTask extends OrchestrationV2PersistedTask {
  status: 'running' | 'succeeded';
  result_hash: string | null;
  validation_contract: string | null;
}

export interface OrchestrationV2CompletionReceiptV2 {
  contract: 'lesson-author-course-completion-v2';
  manifest_hash: string;
  task_count: number;
  admitted_fact_count: number;
  allocated_fact_count: number;
  covered_fact_count: number;
  duplicate_fact_count: 0;
  unresolved_fact_count: 0;
  chapter_receipt_count: number;
  checks: { tasks: 'PASS'; allocation: 'PASS'; coverage: 'PASS'; duplicates: 'PASS'; chapters: 'PASS' };
  receipt_hash: string;
}

export interface OrchestrationV2CourseFinalization {
  contract: typeof ORCHESTRATION_V2_COURSE_CONTRACT;
  completion: OrchestrationV2CompletionReceiptV2;
  chapter_receipt_hashes: string[];
  course_artifact_hash: string;
}

export class OrchestrationV2FinalizationError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_FINALIZATION_INPUT_INVALID'
    | 'ORCHESTRATION_V2_FINALIZATION_INCOMPLETE'
    | 'ORCHESTRATION_V2_FINALIZATION_TOO_LARGE') {
    super(code);
    this.name = 'OrchestrationV2FinalizationError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const fail = (code: OrchestrationV2FinalizationError['code']): never => {
  throw new OrchestrationV2FinalizationError(code);
};

/** Seal final all-task/all-fact evidence without a provider call. */
export function finalizeOrchestrationV2Course(input: {
  source_snapshot_hash: string;
  expected_manifest_hash: string;
  admitted_fact_count: number;
  assembly_hash: string;
  inventory_hash: string;
  tasks: readonly OrchestrationV2FinalizationTask[];
  chapter_receipts: readonly Readonly<OrchestrationV2ChapterReceipt>[];
}): Readonly<OrchestrationV2CourseFinalization> {
  if (!HASH.test(input.source_snapshot_hash) || !HASH.test(input.expected_manifest_hash)
    || !HASH.test(input.assembly_hash) || !HASH.test(input.inventory_hash)
    || !Number.isSafeInteger(input.admitted_fact_count) || input.admitted_fact_count < 1
    || !Array.isArray(input.tasks) || !Array.isArray(input.chapter_receipts)) {
    fail('ORCHESTRATION_V2_FINALIZATION_INPUT_INVALID');
  }
  const manifestTasks = input.tasks.map(({ status: _status, result_hash: _result, validation_contract: _contract, ...task }) => task);
  let manifest: Readonly<OrchestrationV2PersistedManifest>;
  try {
    manifest = sealOrchestrationV2PersistedManifest({ source_snapshot_hash: input.source_snapshot_hash,
      tasks: manifestTasks });
  } catch { return fail('ORCHESTRATION_V2_FINALIZATION_INPUT_INVALID'); }
  if (manifest.manifest_hash !== input.expected_manifest_hash) fail('ORCHESTRATION_V2_FINALIZATION_INPUT_INVALID');
  const finalizers = input.tasks.filter(task => task.kind === 'finalize_course');
  const chapterTasks = input.tasks.filter(task => task.kind === 'validate_chapter');
  if (finalizers.length !== 1 || finalizers[0]!.status !== 'running'
    || finalizers[0]!.result_hash !== null || finalizers[0]!.validation_contract !== null
    || input.tasks.some(task => task.kind !== 'finalize_course' && task.status !== 'succeeded')
    || chapterTasks.length !== input.chapter_receipts.length || chapterTasks.length < 1) {
    fail('ORCHESTRATION_V2_FINALIZATION_INCOMPLETE');
  }
  const receiptsByChapter = new Map(input.chapter_receipts.map(receipt => [receipt.chapter_key, receipt]));
  if (receiptsByChapter.size !== input.chapter_receipts.length) fail('ORCHESTRATION_V2_FINALIZATION_INCOMPLETE');
  const receiptHashes: string[] = [];
  let allocated = 0, covered = 0;
  for (const task of chapterTasks) {
    const receipt = task.chapter_key ? receiptsByChapter.get(task.chapter_key) : undefined;
    const receiptBase = receipt ? (({ receipt_hash: _hash, ...base }) => base)(receipt) : null;
    if (!receipt || receipt.contract !== 'orchestration-chapter-receipt-v2'
      || receipt.source_snapshot_hash !== input.source_snapshot_hash
      || receipt.assembly_hash !== input.assembly_hash || receipt.inventory_hash !== input.inventory_hash
      || task.node_id !== receipt.chapter_node_id || task.result_hash !== receipt.receipt_hash
      || task.validation_contract !== receipt.contract || !HASH.test(receipt.receipt_hash)
      || orchestrationV2Hash(receiptBase) !== receipt.receipt_hash
      || receipt.admitted_fact_count !== receipt.allocated_fact_count
      || receipt.admitted_fact_count !== receipt.covered_fact_count
      || receipt.duplicate_fact_count !== 0 || receipt.unresolved_fact_count !== 0) {
      fail('ORCHESTRATION_V2_FINALIZATION_INCOMPLETE');
    }
    const acceptedReceipt = receipt!;
    allocated += acceptedReceipt.allocated_fact_count; covered += acceptedReceipt.covered_fact_count;
    if (!Number.isSafeInteger(allocated) || !Number.isSafeInteger(covered)) {
      fail('ORCHESTRATION_V2_FINALIZATION_INCOMPLETE');
    }
    receiptHashes.push(acceptedReceipt.receipt_hash);
  }
  if (allocated !== input.admitted_fact_count || covered !== input.admitted_fact_count) {
    fail('ORCHESTRATION_V2_FINALIZATION_INCOMPLETE');
  }
  const completionBase = { contract: 'lesson-author-course-completion-v2' as const,
    manifest_hash: manifest.manifest_hash, task_count: manifest.tasks.length,
    admitted_fact_count: input.admitted_fact_count, allocated_fact_count: allocated,
    covered_fact_count: covered, duplicate_fact_count: 0 as const, unresolved_fact_count: 0 as const,
    chapter_receipt_count: receiptHashes.length, checks: { tasks: 'PASS' as const,
      allocation: 'PASS' as const, coverage: 'PASS' as const, duplicates: 'PASS' as const,
      chapters: 'PASS' as const } };
  const completion = { ...completionBase, receipt_hash: orchestrationV2Hash(completionBase) };
  const artifactBase = { contract: ORCHESTRATION_V2_COURSE_CONTRACT as typeof ORCHESTRATION_V2_COURSE_CONTRACT, completion,
    chapter_receipt_hashes: receiptHashes };
  if (Buffer.byteLength(JSON.stringify(artifactBase), 'utf8') > MAX_ARTIFACT_BYTES) {
    fail('ORCHESTRATION_V2_FINALIZATION_TOO_LARGE');
  }
  return Object.freeze({ ...artifactBase, course_artifact_hash: orchestrationV2Hash(artifactBase) });
}
