// ═══════════════════════════════════════════════════════════════
// Course deletion, pure rules: which purge step a failure came from and the
// last_error text a failed job keeps, so the next failure is diagnosable
// without guessing (PostgreSQL code, table, constraint, context) and without
// row data: the error `detail` (key values) and SQL statement text are never
// copied. That text is for operators; the tenant API shows a plain message.
// ═══════════════════════════════════════════════════════════════

/** The steps of a deletion job, in the order a course job runs them. */
export type CourseDeletionStep =
  | 'storage_manifest'
  | 'mark_running'
  | 'assets'
  | 'ai_id_workspaces'
  | 'linked_rows'
  | 'blocks'
  | 'assignment_feedback_history'
  | 'backup_pii'
  | 'enrollments'
  | 'course'
  | 'block_subtree'
  | 'storage_drain';

/**
 * [Vietnamese, English] of what the tenant API shows for a job that failed
 * at least once. The detailed last_error (step, SQLSTATE, table, constraint,
 * function) names the internal schema: it stays in the job row and the
 * server log, for operators only.
 */
export const DELETION_JOB_PUBLIC_ERRORS = {
  retrying: [
    'Việc xóa chưa hoàn tất. Hệ thống sẽ tự thử lại.',
    'The deletion is not finished yet. It will be retried automatically.',
  ],
  failed: [
    'Việc xóa không thành công sau nhiều lần thử. Quản trị viên cần cho chạy lại.',
    'The deletion did not succeed after several attempts. An administrator needs to run it again.',
  ],
} as const;

/** The plain message the tenant API returns in place of last_error (null while the job has no error). */
export function publicDeletionJobError(lastError: string | null, isTerminal: boolean, locale: 'vi' | 'en'): string | null {
  if (!lastError) return null;
  const [vi, en] = DELETION_JOB_PUBLIC_ERRORS[isTerminal ? 'failed' : 'retrying'];
  return locale === 'en' ? en : vi;
}

/** course_deletion_jobs.last_error keeps at most this many characters (unchanged limit). */
export const LAST_ERROR_MAX_LENGTH = 4000;

const WHERE_MAX_LENGTH = 300;

// The step travels with the error object itself: runDeletionJob rethrows the
// original error (message and code unchanged) and the worker hands that same
// object to markJobRetryable.
const failedSteps = new WeakMap<object, CourseDeletionStep>();

/** Records the step an error was thrown in; the innermost step wins. */
export function tagDeletionStep(error: unknown, step: CourseDeletionStep): void {
  if (error !== null && typeof error === 'object' && !failedSteps.has(error)) failedSteps.set(error, step);
}

export function deletionStepOf(error: unknown): CourseDeletionStep | undefined {
  return error !== null && typeof error === 'object' ? failedSteps.get(error) : undefined;
}

/**
 * First line of a PostgreSQL error context (`where`). A "SQL statement" line
 * (for example the cascade query of a foreign key) is reduced to its verb and
 * the relation it names; a PL/pgSQL line (function, line, action) is kept.
 */
export function summarizeErrorContext(where: unknown): string | null {
  if (typeof where !== 'string') return null;
  const first = where.split('\n', 1)[0]?.trim() ?? '';
  if (!first) return null;
  const statement = /^SQL statement "([\s\S]*)"$/.exec(first);
  if (!statement) return first.slice(0, WHERE_MAX_LENGTH);
  const verb = /^\s*([A-Za-z]+)/.exec(statement[1])?.[1]?.toUpperCase() ?? 'SQL';
  const relation = /\b(?:FROM|UPDATE|INTO)\s+(?:ONLY\s+)?"?(\w+)"?\s*\.\s*"?(\w+)"?/i.exec(statement[1]);
  return relation ? `SQL statement ${verb} ${relation[1]}.${relation[2]}` : `SQL statement ${verb}`;
}

/**
 * The last_error of a failed job: the error message, then in brackets the
 * purge step, and for a PostgreSQL error its SQLSTATE, table, constraint and
 * context summary. A long message is cut so that the bracket always fits in
 * LAST_ERROR_MAX_LENGTH.
 */
export function describeDeletionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const facts: string[] = [];
  const step = deletionStepOf(error);
  if (step) facts.push(`step=${step}`);
  if (error !== null && typeof error === 'object') {
    const pg = error as { code?: unknown; table?: unknown; constraint?: unknown; where?: unknown };
    if (typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) facts.push(`pg=${pg.code}`);
    if (typeof pg.table === 'string' && pg.table) facts.push(`table=${pg.table}`);
    if (typeof pg.constraint === 'string' && pg.constraint) facts.push(`constraint=${pg.constraint}`);
    const context = summarizeErrorContext(pg.where);
    if (context) facts.push(`where=${context}`);
  }
  const suffix = facts.length > 0 ? ` [${facts.join('; ')}]`.slice(0, LAST_ERROR_MAX_LENGTH) : '';
  return message.slice(0, LAST_ERROR_MAX_LENGTH - suffix.length) + suffix;
}
