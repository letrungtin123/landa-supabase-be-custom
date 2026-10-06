import { Buffer } from 'node:buffer';
import type { OrchestrationV2ChapterReceipt } from './lesson-author-orchestration-v2-chapter.logic.js';
import {
  orchestrationV2Hash,
  sealOrchestrationV2PersistedManifest,
  type OrchestrationV2PersistedManifest,
  type OrchestrationV2PersistedTask,
} from './lesson-author-orchestration-v2.logic.js';

export const ORCHESTRATION_V2_COURSE_CONTRACT = 'orchestration-course-finalization-v2';
export const ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT = 'orchestration-course-review-required-v1';

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

export interface OrchestrationV2AssessmentObligationEvidence {
  planned_slot_key: string;
  plan_revision_hash: string;
  status: 'open' | 'resolved';
  resolution_kind: 'valid_assessment' | 'approved_replan' | null;
  resolution_evidence_hash: string | null;
}

export interface OrchestrationV2ReviewRequiredReceiptV1 {
  contract: 'lesson-author-course-review-required-v1';
  manifest_hash: string;
  task_count: number;
  admitted_fact_count: number;
  allocated_fact_count: number;
  covered_fact_count: number;
  duplicate_fact_count: 0;
  unresolved_fact_count: 0;
  chapter_receipt_count: number;
  open_assessment_obligation_count: number;
  assessment_obligation_set_hash: string;
  checks: { tasks: 'PASS'; allocation: 'PASS'; coverage: 'PASS'; duplicates: 'PASS';
    chapters: 'PASS'; assessments: 'REVIEW_REQUIRED' };
  receipt_hash: string;
}

export interface OrchestrationV2ReadyCourseFinalization {
  contract: typeof ORCHESTRATION_V2_COURSE_CONTRACT;
  completion: OrchestrationV2CompletionReceiptV2;
  chapter_receipt_hashes: string[];
  course_artifact_hash: string;
}

export interface OrchestrationV2ReviewCourseFinalization {
  contract: typeof ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT;
  review: OrchestrationV2ReviewRequiredReceiptV1;
  chapter_receipt_hashes: string[];
  course_artifact_hash: string;
}

export type OrchestrationV2CourseFinalization =
  | OrchestrationV2ReadyCourseFinalization
  | OrchestrationV2ReviewCourseFinalization;

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
interface OrchestrationV2FinalizationInput {
  source_snapshot_hash: string;
  expected_manifest_hash: string;
  admitted_fact_count: number;
  assembly_hash: string;
  inventory_hash: string;
  tasks: readonly OrchestrationV2FinalizationTask[];
  chapter_receipts: readonly Readonly<OrchestrationV2ChapterReceipt>[];
  assessment_obligations?: readonly Readonly<OrchestrationV2AssessmentObligationEvidence>[];
}

export function finalizeOrchestrationV2Course(
  input: Omit<OrchestrationV2FinalizationInput, 'assessment_obligations'> & { assessment_obligations?: undefined },
): Readonly<OrchestrationV2ReadyCourseFinalization>;
export function finalizeOrchestrationV2Course(
  input: OrchestrationV2FinalizationInput,
): Readonly<OrchestrationV2CourseFinalization>;
export function finalizeOrchestrationV2Course(
  input: OrchestrationV2FinalizationInput,
): Readonly<OrchestrationV2CourseFinalization> {
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
  const obligations = [...(input.assessment_obligations ?? [])];
  if (new Set(obligations.map(item => item.planned_slot_key)).size !== obligations.length
    || obligations.some(item => !/^ao2_[a-f0-9]{32}$/.test(item.planned_slot_key)
      || item.plan_revision_hash !== input.assembly_hash
      || !['open', 'resolved'].includes(item.status)
      || (item.status === 'open' && (item.resolution_kind !== null || item.resolution_evidence_hash !== null))
      || (item.status === 'resolved' && (!item.resolution_kind
        || !item.resolution_evidence_hash || !HASH.test(item.resolution_evidence_hash))))) {
    fail('ORCHESTRATION_V2_FINALIZATION_INPUT_INVALID');
  }
  const openObligations = obligations.filter(item => item.status === 'open');
  if (openObligations.length) {
    const reviewBase = { contract: 'lesson-author-course-review-required-v1' as const,
      manifest_hash: manifest.manifest_hash, task_count: manifest.tasks.length,
      admitted_fact_count: input.admitted_fact_count, allocated_fact_count: allocated,
      covered_fact_count: covered, duplicate_fact_count: 0 as const, unresolved_fact_count: 0 as const,
      chapter_receipt_count: receiptHashes.length,
      open_assessment_obligation_count: openObligations.length,
      assessment_obligation_set_hash: orchestrationV2Hash(openObligations.map(item => ({
        planned_slot_key: item.planned_slot_key, plan_revision_hash: item.plan_revision_hash,
      }))),
      checks: { tasks: 'PASS' as const, allocation: 'PASS' as const, coverage: 'PASS' as const,
        duplicates: 'PASS' as const, chapters: 'PASS' as const, assessments: 'REVIEW_REQUIRED' as const } };
    const review = { ...reviewBase, receipt_hash: orchestrationV2Hash(reviewBase) };
    const artifactBase = { contract: ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT as typeof ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT,
      review, chapter_receipt_hashes: receiptHashes };
    if (Buffer.byteLength(JSON.stringify(artifactBase), 'utf8') > MAX_ARTIFACT_BYTES) {
      fail('ORCHESTRATION_V2_FINALIZATION_TOO_LARGE');
    }
    return Object.freeze({ ...artifactBase, course_artifact_hash: orchestrationV2Hash(artifactBase) });
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
