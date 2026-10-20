import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { hasControlCharacter, workspaceApplyLocation, workspacePlainTitle,
  type WorkspaceApplyLocation } from './lesson-author-workspace-apply-reason.logic.js';
import { workspaceObligationObjectives } from './lesson-author-workspace-author-notes.logic.js';
import type { WorkspaceContent } from './lesson-author-workspace.logic.js';
import { isUuid } from '../../../utils/uuid.js';

/**
 * "Chờ duyệt": the assessment questions an AI ID run held back for the author
 * (open ASSESSMENT_SOURCE_CHECK_REQUIRED obligations). The author marks each
 * one as checked. The DB guard allows exactly one transition, open ->
 * resolved, and only while the run is needs_action:
 * - `valid_assessment`: an existing question (a content_ready Problem
 *   component of the same lesson, at its current revision) checks it;
 * - `approved_replan`: the author approved going without the planned question
 *   (they leave it out or write it themselves).
 */
export const WORKSPACE_REVIEW_REQUIRED_CODE = 'ASSESSMENT_REVIEW_REQUIRED';
export const WORKSPACE_REVIEW_DECISIONS = ['valid_assessment', 'approved_replan'] as const;
export type WorkspaceReviewDecision = typeof WORKSPACE_REVIEW_DECISIONS[number];
export const WORKSPACE_REVIEW_RESOLUTION_CONTRACT = 'lesson-author-assessment-review-resolution-v1';
/** Same bound as the author notes list of a run; `has_more` tells when it is cut. */
export const WORKSPACE_REVIEW_LIST_LIMIT = 200;
export const WORKSPACE_REVIEW_NOTE_MAX = 1_000;
/** Component types that can carry a single-choice check. */
export const WORKSPACE_REVIEW_ASSESSMENT_COMPONENT_TYPES: readonly string[] = ['problem'];

export type WorkspaceReviewCode = 'WORKSPACE_REVIEW_FORBIDDEN' | 'WORKSPACE_REVIEW_NOT_FOUND'
  | 'WORKSPACE_REVIEW_ITEM_NOT_FOUND' | 'WORKSPACE_REVIEW_STATE_INVALID' | 'WORKSPACE_REVIEW_ALREADY_RESOLVED'
  | 'WORKSPACE_REVIEW_COMPONENT_INVALID' | 'WORKSPACE_REVIEW_UNAVAILABLE';
export class WorkspaceReviewError extends Error {
  constructor(readonly code: WorkspaceReviewCode) { super(code); this.name = 'WorkspaceReviewError'; }
}

export interface WorkspaceReviewCandidate {
  node_id: string;
  /** 1-based position of the content inside its lesson. */
  number: number;
  title: string | null;
}
export interface WorkspaceReviewItem {
  obligation_id: string;
  status: 'open' | 'resolved';
  decision: WorkspaceReviewDecision | null;
  resolved_at: string | null;
  /** Chapter / section / lesson the held question belongs to (ordinal + title). */
  location: WorkspaceApplyLocation | null;
  required_kind: string;
  reason: string;
  /** What to check against the source: the lesson objectives the question was meant to test. */
  learning_objectives: string[];
  evidence_fact_count: number;
  /** Existing questions of the same lesson that may already check it (for `valid_assessment`). */
  candidate_components: WorkspaceReviewCandidate[];
}
export interface WorkspaceReviewList {
  workspace_id: string;
  /** True while the run waits for this review (status needs_action, ASSESSMENT_REVIEW_REQUIRED). */
  review_required: boolean;
  total_count: number;
  open_count: number;
  resolved_count: number;
  has_more: boolean;
  items: WorkspaceReviewItem[];
}

type Revision = { content: WorkspaceContent; content_hash: string } | null;
export interface WorkspaceReviewObligationRow {
  obligation_id: string;
  status: string;
  resolution_kind: string | null;
  resolved_at: string | Date | null;
  unit_path: string;
  required_kind: string;
  reason: string;
  learning_objective_refs: readonly string[];
  evidence_fact_count: number;
  /** Verified current revisions (null when missing or when the hash does not verify). */
  chapter: Revision;
  lesson: Revision;
  unit: Revision;
}
export interface WorkspaceReviewCandidateRow {
  node_id: string;
  canonical_path: string;
  content: WorkspaceContent | null;
}

const UNIT_PATH = /^chapter_[1-9][0-9]*\.lesson_[1-9][0-9]*\.unit_[1-9][0-9]*$/;
const COMPONENT_PATH = /^(chapter_[1-9][0-9]*\.lesson_[1-9][0-9]*\.unit_[1-9][0-9]*)\.component_([1-9][0-9]*)$/;

const isDecision = (value: unknown): value is WorkspaceReviewDecision =>
  (WORKSPACE_REVIEW_DECISIONS as readonly unknown[]).includes(value);

const title = (content: WorkspaceContent | null): string | null => workspacePlainTitle(content?.title);

/** Unit path a component path belongs to, or null. */
export function workspaceReviewUnitPathOf(componentPath: string): string | null {
  return COMPONENT_PATH.exec(componentPath)?.[1] ?? null;
}

/** One list item. A row that does not validate is dropped (the list is advisory). */
export function workspaceReviewItem(row: WorkspaceReviewObligationRow,
  candidates: readonly WorkspaceReviewCandidateRow[]): WorkspaceReviewItem | null {
  if (!isUuid(row.obligation_id) || !UNIT_PATH.test(row.unit_path) || !['open', 'resolved'].includes(row.status)
    || (row.status === 'resolved') !== isDecision(row.resolution_kind)) return null;
  const resolvedAt = row.resolved_at === null ? null : new Date(row.resolved_at);
  if (row.status === 'resolved' && (!resolvedAt || !Number.isFinite(resolvedAt.getTime()))) return null;
  const [chapterPath, lessonPath] = [row.unit_path.split('.').slice(0, 1).join('.'), row.unit_path.split('.').slice(0, 2).join('.')];
  const node = (canonical_path: string, revision: Revision) => ({ canonical_path, baseline: null,
    current: revision ? { content: revision.content, content_hash: revision.content_hash } : null });
  const location = workspaceApplyLocation(row.unit_path, [node(chapterPath, row.chapter), node(lessonPath, row.lesson),
    node(row.unit_path, row.unit)]);
  return {
    obligation_id: row.obligation_id,
    status: row.status as WorkspaceReviewItem['status'],
    decision: row.status === 'resolved' ? row.resolution_kind as WorkspaceReviewDecision : null,
    resolved_at: row.status === 'resolved' ? resolvedAt!.toISOString() : null,
    location,
    required_kind: row.required_kind,
    reason: row.reason,
    learning_objectives: workspaceObligationObjectives(row.learning_objective_refs, row.lesson?.content ?? null),
    evidence_fact_count: Number.isSafeInteger(row.evidence_fact_count) && row.evidence_fact_count >= 0 ? row.evidence_fact_count : 0,
    candidate_components: candidates.flatMap(candidate => {
      const match = COMPONENT_PATH.exec(candidate.canonical_path);
      return match && match[1] === row.unit_path && isUuid(candidate.node_id)
        ? [{ node_id: candidate.node_id, number: Number(match[2]), title: title(candidate.content) }] : [];
    }).sort((a, b) => a.number - b.number),
  };
}

/** Evidence bound into `resolution_evidence_hash`: who decided what, by which operation. */
export interface WorkspaceReviewEvidence {
  obligation_id: string;
  planned_slot_key: string;
  decision: WorkspaceReviewDecision;
  resolved_node_id: string | null;
  resolved_node_revision: number | null;
  actor_id: string;
  operation_id: string;
  /** The optional note is bound by hash only; its text is not stored. */
  note: string | null;
}

export function workspaceReviewEvidenceHash(evidence: WorkspaceReviewEvidence): string {
  return orchestrationV2Hash({ contract: WORKSPACE_REVIEW_RESOLUTION_CONTRACT, obligation_id: evidence.obligation_id,
    planned_slot_key: evidence.planned_slot_key, decision: evidence.decision,
    resolved_node_id: evidence.resolved_node_id, resolved_node_revision: evidence.resolved_node_revision,
    actor_id: evidence.actor_id, operation_id: evidence.operation_id,
    note_hash: evidence.note === null ? null : orchestrationV2Hash(evidence.note) });
}

/** A component may resolve `valid_assessment` only inside the obligation's own lesson. */
export function workspaceReviewComponentAccepted(node: { kind: string; canonical_path: string; content_state: string;
  component_type: string | null; current_revision: number | null }, unitPath: string): boolean {
  return node.kind === 'component' && node.content_state === 'content_ready' && node.current_revision !== null
    && workspaceReviewUnitPathOf(node.canonical_path) === unitPath
    && WORKSPACE_REVIEW_ASSESSMENT_COMPONENT_TYPES.includes(node.component_type ?? '');
}

/** Normalized resolve request (the controller already checked the shape). */
export interface WorkspaceReviewResolveInput {
  decision: WorkspaceReviewDecision;
  component_node_id: string | null;
  note: string | null;
  operation_id: string;
}

/** Strict body reader: decision, operation_id, optional note, component only for valid_assessment. */
export function readWorkspaceReviewResolveBody(body: unknown): WorkspaceReviewResolveInput | null {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['decision', 'component_node_id', 'note', 'operation_id'].includes(key))
    || !isDecision(value.decision) || !isUuid(value.operation_id)) return null;
  const component = value.component_node_id ?? null;
  if (value.decision === 'valid_assessment' ? !isUuid(component) : component !== null) return null;
  const note = value.note === undefined || value.note === null ? null : value.note;
  if (note !== null && (typeof note !== 'string' || note.length > WORKSPACE_REVIEW_NOTE_MAX
    || hasControlCharacter(note, true))) return null;
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return { decision: value.decision, component_node_id: component as string | null,
    note: trimmed ? trimmed : null, operation_id: value.operation_id as string };
}
