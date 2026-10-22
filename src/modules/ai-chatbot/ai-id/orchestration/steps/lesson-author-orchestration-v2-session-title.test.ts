import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import {
  LESSON_AUTHOR_DEFAULT_SESSION_TITLE, lessonAuthorSessionTitleFromCourseTitle,
} from '../../shared/lesson-author-session-title.logic.js';
import {
  adoptCourseTitleAsSessionTitle, thenAdoptSessionTitle, type SessionTitleSkipped,
} from './lesson-author-orchestration-v2-session-title.repository.js';

// C1: when the V2 course skeleton succeeds, the AI ID session (chat_conversations row) takes the AI course title,
// only while it still has the column default 'Cuộc hội thoại mới'. The write never fails the skeleton success.

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = { workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course-v1:test+1+2026', run_id: uuid(2), task_id: uuid(1) };

/**
 * One conversation row and its owner. The UPDATE matches only while the title is the given default and the owner is
 * active without a deletion request (the precondition); `failWith` makes the UPDATE raise like a trigger would.
 */
function conversation(title: string, owner: { is_active?: boolean; deletion_requested?: boolean } = {},
  failWith?: Record<string, unknown>) {
  const row = { title, updates: 0 };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = (value: unknown[]) => ({ rows: value as T[], rowCount: value.length });
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) lesson_author_session_title$/.test(sql)) return rows([]);
      assert.match(sql, /^UPDATE chat_conversations c SET title=\$5,updated_at=clock_timestamp\(\)/);
      if (failWith) throw Object.assign(new Error('raised by a trigger'), failWith);
      const [workspaceId, tenantId, courseId, expected, next] = params;
      const matches = workspaceId === target.workspace_id && tenantId === target.tenant_id
        && courseId === target.course_id && row.title === expected
        && owner.is_active !== false && owner.deletion_requested !== true;
      if (matches) { row.title = String(next); row.updates += 1; }
      return rows(matches ? [{ id: uuid(9) }] : []);
    },
  };
  return { row, queries, tx };
}

test('the session title is the AI course title on one line, at most 200 characters, never a split character', () => {
  assert.equal(LESSON_AUTHOR_DEFAULT_SESSION_TITLE, 'Cuộc hội thoại mới');
  assert.equal(lessonAuthorSessionTitleFromCourseTitle('  Kỹ năng\n bán   hàng\tB2B '), 'Kỹ năng bán hàng B2B');
  // NFC: a decomposed Vietnamese title is stored composed, like a rename.
  assert.equal(lessonAuthorSessionTitleFromCourseTitle('Kỹ năng'), 'Kỹ năng'.normalize('NFC'));
  assert.equal(lessonAuthorSessionTitleFromCourseTitle(' \n\t '), null);
  assert.equal(lessonAuthorSessionTitleFromCourseTitle(''), null);
  assert.equal(lessonAuthorSessionTitleFromCourseTitle(undefined), null);
  assert.equal(lessonAuthorSessionTitleFromCourseTitle(42), null);
  const long = lessonAuthorSessionTitleFromCourseTitle('a'.repeat(199) + '😀' + 'b'.repeat(50))!;
  assert.equal(long, 'a'.repeat(199), 'the emoji pair would pass 200 UTF-16 units: cut before it');
  assert.equal(lessonAuthorSessionTitleFromCourseTitle('x'.repeat(199) + ' ' + 'y'.repeat(9)), 'x'.repeat(199));
  assert.equal(lessonAuthorSessionTitleFromCourseTitle('z'.repeat(500))!.length, 200);
});

test('a session with the default title takes the course title once; a renamed one is kept', async () => {
  const fresh = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  assert.equal(await adoptCourseTitleAsSessionTitle(fresh.tx, target, '  An toàn lao động  '), true);
  assert.equal(fresh.row.title, 'An toàn lao động');
  assert.deepEqual(fresh.queries.map(query => query.sql.split('\n')[0]), ['SAVEPOINT lesson_author_session_title',
    'UPDATE chat_conversations c SET title=$5,updated_at=clock_timestamp()', 'RELEASE SAVEPOINT lesson_author_session_title']);
  const update = fresh.queries[1]!;
  assert.deepEqual(update.params, [uuid(3), uuid(4), 'course-v1:test+1+2026', 'Cuộc hội thoại mới', 'An toàn lao động']);
  assert.match(update.sql, /FROM lesson_author_workspaces w, users u\s+WHERE w\.id=\$1::uuid AND w\.tenant_id=\$2::uuid AND w\.course_id=\$3/);
  assert.match(update.sql, /c\.id=w\.conversation_id AND c\.tenant_id=w\.tenant_id AND c\.course_id=w\.course_id/);
  // The precondition of the row's user deletion fence: an active owner without a deletion request.
  assert.match(update.sql, /u\.id=c\.user_id AND u\.is_active=true AND u\.deletion_requested_at IS NULL/);
  // Idempotent: a retried success or a later run of the session finds a title and changes nothing.
  assert.equal(await adoptCourseTitleAsSessionTitle(fresh.tx, target, 'Another course'), false);
  assert.equal(fresh.row.title, 'An toàn lao động');
  assert.equal(fresh.row.updates, 1);

  const renamed = conversation('Phiên của tôi');
  assert.equal(await adoptCourseTitleAsSessionTitle(renamed.tx, target, 'An toàn lao động'), false);
  assert.equal(renamed.row.title, 'Phiên của tôi');

  // Another tenant's workspace never matches.
  const other = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  assert.equal(await adoptCourseTitleAsSessionTitle(other.tx, { ...target, tenant_id: uuid(5) }, 'X'), false);
  assert.equal(other.row.title, LESSON_AUTHOR_DEFAULT_SESSION_TITLE);

  const empty = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  assert.equal(await adoptCourseTitleAsSessionTitle(empty.tx, target, '   '), false);
  assert.equal(empty.queries.length, 0, 'an empty course title writes nothing');
});

test('an inactive or deletion-requested owner keeps the default title and nothing fails', async () => {
  for (const owner of [{ is_active: false }, { deletion_requested: true }]) {
    const session = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE, owner);
    const reports: SessionTitleSkipped[] = [];
    assert.equal(await adoptCourseTitleAsSessionTitle(session.tx, target, 'Khoá học', event => reports.push(event)), false);
    assert.equal(session.row.title, LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
    assert.deepEqual(reports, []);
    assert.equal(session.queries.at(-1)!.sql, 'RELEASE SAVEPOINT lesson_author_session_title');
  }
});

test('any other failure of the write is rolled back alone and reported with its code, never thrown', async () => {
  for (const [error, code] of [[{ code: '23503' }, '23503'], [{ code: '55P03' }, '55P03'], [{}, 'SESSION_TITLE_WRITE_FAILED']] as const) {
    const session = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE, {}, error);
    const reports: SessionTitleSkipped[] = [];
    assert.equal(await adoptCourseTitleAsSessionTitle(session.tx, target, 'Khoá học', event => reports.push(event)), false);
    assert.deepEqual(session.queries.map(query => query.sql.split('\n')[0]), ['SAVEPOINT lesson_author_session_title',
      'UPDATE chat_conversations c SET title=$5,updated_at=clock_timestamp()', 'ROLLBACK TO SAVEPOINT lesson_author_session_title']);
    assert.deepEqual(reports, [{ event: 'session_title_skipped', tenant_id: uuid(4), workspace_id: uuid(3),
      run_id: uuid(2), task_id: uuid(1), code }]);
  }
  // The default report is a warning line (event and code only).
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { warnings.push(line); };
  try {
    await adoptCourseTitleAsSessionTitle(conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE, {}, { code: '23503' }).tx, target, 'X');
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^\[LessonAuthorOrchestrationV2\] \{"event":"session_title_skipped",.*"code":"23503"\}$/);
  // A broken connection (the rollback itself fails) loses the whole transaction anyway: that propagates.
  const broken: GenerationJobSql = { query: async (sql: string) => {
    if (sql.startsWith('SAVEPOINT')) return { rows: [], rowCount: 0 };
    throw Object.assign(new Error('connection lost'), { code: '08006' });
  } };
  await assert.rejects(adoptCourseTitleAsSessionTitle(broken, target, 'X', () => undefined), { code: '08006' });
});

test('the skeleton success hook names the session after the chapter fan-out, and not when the fan-out fails', async () => {
  const order: string[] = [];
  const session = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  const tx: GenerationJobSql = { query: async (sql, params) => {
    if (sql.startsWith('UPDATE')) order.push('title');
    return session.tx.query(sql, params);
  } };
  await thenAdoptSessionTitle(async () => { order.push('fan-out'); }, target, 'Course')(tx);
  assert.deepEqual(order, ['fan-out', 'title']);
  assert.equal(session.row.title, 'Course');

  const failing = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  await assert.rejects(thenAdoptSessionTitle(async () => { throw new Error('fan-out failed'); }, target, 'Course')(failing.tx),
    /fan-out failed/);
  assert.equal(failing.queries.length, 0);
});
