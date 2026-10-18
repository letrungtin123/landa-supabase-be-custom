import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';

/** Chapter storage contract only; not a replacement for component/source validators. */
export const CHAPTER_CHECKPOINT_VERSION = 1;
export const CHAPTER_CHECKPOINT_MAX_UNITS = 512;
export const CHAPTER_CHECKPOINT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type ChapterCheckpointErrorCode =
  | 'CHAPTER_CHECKPOINT_NOT_FOUND' | 'CHAPTER_CHECKPOINT_CONTRACT_INVALID'
  | 'CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED' | 'CHAPTER_CHECKPOINT_LEASE_LOST'
  | 'CHAPTER_CHECKPOINT_ALREADY_DISPATCHED' | 'CHAPTER_CHECKPOINT_ALREADY_COMMITTED'
  | 'CHAPTER_CHECKPOINT_INCOMPLETE' | 'CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED'
  | 'CHAPTER_CHECKPOINT_PAYLOAD_INVALID';

export class ChapterCheckpointError extends Error {
  constructor(readonly code: ChapterCheckpointErrorCode) { super(code); this.name = 'ChapterCheckpointError'; }
}

export interface ChapterCheckpointOwner {
  tenantId: string;
  conversationId: string;
  userId: string;
  courseId: string;
}

export interface ChapterUnitContract {
  index: number;
  lesson_index: number;
  unit_index: number;
  contract_hash: string;
  evidence_hash: string;
}

export interface ChapterCheckpointSnapshot {
  request_hash: string;
  blueprint_hash: string;
  source_snapshot_hash: string;
  course_outline_hash: string;
  runtime_config_hash: string;
}

export interface ChapterDraftRow extends ChapterCheckpointSnapshot {
  [key: string]: unknown;
  id: string;
  tenant_id: string;
  conversation_id: string;
  requested_by: string;
  course_id: string;
  blueprint_id: string;
  chapter_index: number;
  contract_version: 1;
  total_units: number;
  unit_contracts: ChapterUnitContract[];
  status: 'open' | 'ready' | 'failed' | 'canceled';
  result_job_id: string | null;
  expires_at: Date;
}

export interface ChapterAttemptRow {
  [key: string]: unknown;
  id: string;
  draft_id: string;
  tenant_id: string;
  course_id: string;
  correlation_id: string;
  lease_token: string;
  lease_expires_at: Date;
  deadline_at: Date;
  status: 'running' | 'completed' | 'timed_out' | 'outcome_unknown' | 'failed';
  dispatch_started_at: Date | null;
  in_flight_unit_index: number | null;
  accounting_state: 'reserved' | 'settled' | 'pending_reconciliation';
  external_failure_code: string | null;
}

/** Private normalized unit, never part of the public status response. */
export interface ChapterUnitPayload { [key: string]: unknown; components: unknown[] }
export interface ChapterUnitIdentity {
  [key: string]: unknown;
  draft_id: string;
  tenant_id: string;
  course_id: string;
  unit_index: number;
  contract_hash: string;
  evidence_hash: string;
}
export interface ChapterUnitRow extends ChapterUnitIdentity {
  attempt_id: string;
  payload_hash: string;
  validation_contract: string;
  payload: ChapterUnitPayload;
}

const HASH = /^[0-9a-f]{64}$/;
export function assertChapterUnitInventory(contracts: readonly ChapterUnitContract[]): void {
  if (!contracts.length || contracts.length > CHAPTER_CHECKPOINT_MAX_UNITS) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
  }
  const coordinates = new Set<string>();
  for (const [index, c] of contracts.entries()) {
    const coordinate = `${c.lesson_index}:${c.unit_index}`;
    if (c.index !== index || !Number.isSafeInteger(c.lesson_index) || c.lesson_index < 0
      || !Number.isSafeInteger(c.unit_index) || c.unit_index < 0
      || !HASH.test(c.contract_hash) || !HASH.test(c.evidence_hash) || coordinates.has(coordinate)
      || Object.keys(c).sort().join(',') !== 'contract_hash,evidence_hash,index,lesson_index,unit_index') {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    }
    coordinates.add(coordinate);
  }
}

export function assertChapterSnapshot(draft: ChapterDraftRow, current: ChapterCheckpointSnapshot): void {
  for (const field of ['request_hash', 'blueprint_hash', 'source_snapshot_hash',
    'course_outline_hash', 'runtime_config_hash'] as const) {
    if (!HASH.test(current[field]) || current[field] !== draft[field]) {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
    }
  }
}

export function assertChapterUnitPayload(payload: ChapterUnitPayload): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Array.isArray(payload.components) || !payload.components.length) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_PAYLOAD_INVALID');
  }
  // Conservatively account for PostgreSQL JSONB textual separators. SQL applies its
  // own byte guard too. Reject unsupported JS values instead of silently dropping.
  let encoded: string;
  try {
    encoded = JSON.stringify(payload, (_key, value: unknown) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
        || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error();
      return value;
    }, 1);
  } catch { throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_PAYLOAD_INVALID'); }
  if (Buffer.byteLength(encoded, 'utf8') > CHAPTER_CHECKPOINT_MAX_PAYLOAD_BYTES) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_PAYLOAD_INVALID');
  }
}

/** Bounded metadata check for dispatch; do not reread all content for every unit. */
export function assertChapterCheckpointIndex(draft: ChapterDraftRow, rows: readonly ChapterUnitIdentity[]): void {
  assertChapterUnitInventory(draft.unit_contracts);
  if (draft.contract_version !== CHAPTER_CHECKPOINT_VERSION || draft.total_units !== draft.unit_contracts.length) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
  }
  const seen = new Set<number>();
  for (const row of rows) {
    const expected = draft.unit_contracts[row.unit_index];
    if (!Number.isSafeInteger(row.unit_index) || !expected || seen.has(row.unit_index)
      || row.draft_id !== draft.id || row.tenant_id !== draft.tenant_id || row.course_id !== draft.course_id
      || row.contract_hash !== expected.contract_hash || row.evidence_hash !== expected.evidence_hash) {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    }
    seen.add(row.unit_index);
  }
}

/** Identity/integrity only. Cached units still require current Node acceptance checks. */
export function assertChapterCheckpoints(draft: ChapterDraftRow, rows: readonly ChapterUnitRow[]): void {
  assertChapterCheckpointIndex(draft, rows);
  for (const row of rows) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(row.validation_contract)) {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    }
    assertChapterUnitPayload(row.payload);
    if (generationSnapshotHash(row.payload) !== row.payload_hash) {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_PAYLOAD_INVALID');
    }
  }
}

export function chapterAttemptMatches(draft: ChapterDraftRow, attempt: ChapterAttemptRow): boolean {
  return attempt.draft_id === draft.id && attempt.tenant_id === draft.tenant_id && attempt.course_id === draft.course_id;
}

/** No auto-requeue policy. Recovery must persist an ended state before offering resume. */
export function chapterAttemptExpiry(attempt: ChapterAttemptRow, databaseNow: Date): 'none' | 'timed_out' | 'outcome_unknown' {
  if (attempt.status !== 'running' || (attempt.lease_expires_at > databaseNow && attempt.deadline_at > databaseNow)) return 'none';
  return attempt.dispatch_started_at === null ? 'timed_out' : 'outcome_unknown';
}

export function assertChapterResume(draft: ChapterDraftRow, latest: ChapterAttemptRow, previousAttemptId: string, databaseNow: Date): void {
  if (!chapterAttemptMatches(draft, latest) || draft.status !== 'open' || draft.expires_at <= databaseNow
    || latest.id !== previousAttemptId || !['timed_out', 'outcome_unknown'].includes(latest.status)) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED');
  }
}

/** Must be called only after owner authorization. Never expose progress for running attempts. */
export function chapterCheckpointStatus(draft: ChapterDraftRow, latest: ChapterAttemptRow | null,
  completedUnits: number, databaseNow: Date) {
  if (!Number.isSafeInteger(completedUnits) || completedUnits < 0 || completedUnits > draft.total_units
    || (latest && !chapterAttemptMatches(draft, latest))) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
  }
  const interrupted = draft.status === 'open' && draft.expires_at > databaseNow && latest !== null
    && ['timed_out', 'outcome_unknown'].includes(latest.status);
  return {
    draft_id: draft.id,
    attempt_id: latest?.id ?? null,
    correlation_id: latest?.correlation_id ?? null,
    status: draft.status === 'open' ? latest?.status ?? 'open' : draft.status,
    proposal_job_id: draft.status === 'ready' ? draft.result_job_id : null,
    interruption: interrupted ? {
      completed_units: completedUnits, total_units: draft.total_units,
      can_continue: true, previous_attempt_id: latest.id,
      usage_pending_reconciliation: latest.accounting_state === 'pending_reconciliation',
    } : null,
  };
}
