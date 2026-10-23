import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELETION_JOB_PUBLIC_ERRORS,
  LAST_ERROR_MAX_LENGTH,
  deletionStepOf,
  describeDeletionError,
  publicDeletionJobError,
  summarizeErrorContext,
  tagDeletionStep,
} from './course-deletion.logic.js';

/** An error shaped like the ones pg raises (message plus the server fields). */
function pgError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

test('last_error carries the step, SQLSTATE, table, constraint and the first line of the context', () => {
  const error = pgError('V2 completion receipt is immutable', {
    code: '23514',
    where: 'PL/pgSQL function guard_lesson_author_workspace_v2_completion() line 6 at RAISE\n'
      + 'SQL statement "DELETE FROM ONLY "public"."lesson_author_workspace_v2_completion_receipts" WHERE $1 OPERATOR(pg_catalog.=) "run_id""',
  });
  tagDeletionStep(error, 'linked_rows');
  assert.equal(
    describeDeletionError(error),
    'V2 completion receipt is immutable [step=linked_rows; pg=23514; '
      + 'where=PL/pgSQL function guard_lesson_author_workspace_v2_completion() line 6 at RAISE]',
  );
});

test('a cascade statement in the context is reduced to its verb and relation: no SQL text', () => {
  const error = pgError('canceling statement due to statement timeout', {
    code: '57014',
    where: 'SQL statement "DELETE FROM ONLY "public"."block_completions" WHERE $1 OPERATOR(pg_catalog.=) "block_id""',
  });
  tagDeletionStep(error, 'blocks');
  const text = describeDeletionError(error);
  assert.equal(
    text,
    'canceling statement due to statement timeout [step=blocks; pg=57014; where=SQL statement DELETE public.block_completions]',
  );
  assert.doesNotMatch(text, /OPERATOR|\$1/);
});

test('table and constraint are kept, the detail with row values never is', () => {
  const error = pgError('update or delete on table "course_assignments" violates foreign key constraint', {
    code: '23503',
    table: 'assignment_files',
    constraint: 'assignment_files_assignment_id_fkey',
    detail: 'Key (id)=(5b0d...) is still referenced from table "assignment_files".',
    schema: 'public',
  });
  const text = describeDeletionError(error);
  assert.match(text, /\[pg=23503; table=assignment_files; constraint=assignment_files_assignment_id_fkey\]$/);
  assert.doesNotMatch(text, /Key \(id\)/);
});

test('an error without PostgreSQL fields or step keeps its plain message', () => {
  assert.equal(describeDeletionError(new Error('storage down')), 'storage down');
  assert.equal(describeDeletionError('RabbitMQ retry limit reached; DB sweeper will retry'),
    'RabbitMQ retry limit reached; DB sweeper will retry');
  // Not a SQLSTATE: ignored (for example a Node error code).
  assert.equal(describeDeletionError(pgError('connect failed', { code: 'ECONNREFUSED' })), 'connect failed');
});

test('a long message is cut so the diagnostic bracket always fits', () => {
  const error = pgError('x'.repeat(5000), { code: '57014', table: 'course_blocks' });
  tagDeletionStep(error, 'blocks');
  const text = describeDeletionError(error);
  assert.equal(text.length, LAST_ERROR_MAX_LENGTH);
  assert.ok(text.endsWith(' [step=blocks; pg=57014; table=course_blocks]'));
  assert.equal(describeDeletionError(new Error('y'.repeat(5000))).length, LAST_ERROR_MAX_LENGTH);
});

test('the innermost step wins and a primitive cannot be tagged', () => {
  const error = new Error('boom');
  tagDeletionStep(error, 'enrollments');
  tagDeletionStep(error, 'course');
  assert.equal(deletionStepOf(error), 'enrollments');
  tagDeletionStep('boom', 'course');
  assert.equal(deletionStepOf('boom'), undefined);
  assert.equal(deletionStepOf(null), undefined);
});

test('context summary handles empty, PL/pgSQL and unrecognised statement lines', () => {
  assert.equal(summarizeErrorContext(undefined), null);
  assert.equal(summarizeErrorContext(''), null);
  assert.equal(summarizeErrorContext('PL/pgSQL function f() line 2 at RAISE'), 'PL/pgSQL function f() line 2 at RAISE');
  assert.equal(summarizeErrorContext('SQL statement "SELECT 1"'), 'SQL statement SELECT');
  assert.equal(
    summarizeErrorContext('SQL statement "UPDATE ONLY "public"."ai_token_reservations" SET "conversation_id" = NULL WHERE $1 = "conversation_id""'),
    'SQL statement UPDATE public.ai_token_reservations',
  );
  assert.equal(summarizeErrorContext('x'.repeat(500))!.length, 300);
});

test('the tenant sees a plain message per state and language, never the diagnostic', () => {
  const diagnostic = 'Course x is being deleted [step=blocks; pg=23503; table=course_blocks]';
  assert.equal(publicDeletionJobError(null, false, 'vi'), null);
  assert.equal(publicDeletionJobError('', true, 'en'), null);
  assert.equal(publicDeletionJobError(diagnostic, false, 'vi'), DELETION_JOB_PUBLIC_ERRORS.retrying[0]);
  assert.equal(publicDeletionJobError(diagnostic, false, 'en'), DELETION_JOB_PUBLIC_ERRORS.retrying[1]);
  assert.equal(publicDeletionJobError(diagnostic, true, 'vi'), DELETION_JOB_PUBLIC_ERRORS.failed[0]);
  assert.equal(publicDeletionJobError(diagnostic, true, 'en'), DELETION_JOB_PUBLIC_ERRORS.failed[1]);
  // Plain words for non-technical users: no codes, brackets or technical tokens.
  for (const message of Object.values(DELETION_JOB_PUBLIC_ERRORS).flat()) {
    assert.doesNotMatch(message, /\d{3,}|\[|=|_|job|SQL|pg\b|lease|course_/i, message);
  }
});
