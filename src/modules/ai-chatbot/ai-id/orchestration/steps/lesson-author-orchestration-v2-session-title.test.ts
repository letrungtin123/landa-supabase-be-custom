import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import {
  LESSON_AUTHOR_DEFAULT_SESSION_TITLE, lessonAuthorSessionTitleFromCourseTitle,
} from '../../shared/lesson-author-session-title.logic.js';
import { adoptCourseTitleAsSessionTitle, thenAdoptSessionTitle } from './lesson-author-orchestration-v2-session-title.repository.js';

// C1: when the V2 course skeleton succeeds, the AI ID session (chat_conversations row) takes the AI course
// title, only while it still has the column default 'Cuộc hội thoại mới'.

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = { workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course-v1:test+1+2026' };

/** One conversation row: the UPDATE matches only while its title is the given default. */
function conversation(title: string) {
  const row = { title, updates: 0 };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      assert.match(sql, /^UPDATE chat_conversations c SET title=\$5,updated_at=clock_timestamp\(\)/);
      const [workspaceId, tenantId, courseId, expected, next] = params;
      const matches = workspaceId === target.workspace_id && tenantId === target.tenant_id
        && courseId === target.course_id && row.title === expected;
      if (matches) { row.title = String(next); row.updates += 1; }
      return { rows: (matches ? [{ id: uuid(9) }] : []) as unknown as T[], rowCount: matches ? 1 : 0 };
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
  assert.deepEqual(fresh.queries[0]!.params, [uuid(3), uuid(4), 'course-v1:test+1+2026', 'Cuộc hội thoại mới', 'An toàn lao động']);
  assert.match(fresh.queries[0]!.sql, /FROM lesson_author_workspaces w\s+WHERE w\.id=\$1::uuid AND w\.tenant_id=\$2::uuid AND w\.course_id=\$3/);
  assert.match(fresh.queries[0]!.sql, /c\.id=w\.conversation_id AND c\.tenant_id=w\.tenant_id AND c\.course_id=w\.course_id/);
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

test('the skeleton success hook names the session after the chapter fan-out, and not when the fan-out fails', async () => {
  const order: string[] = [];
  const session = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  const tx: GenerationJobSql = { query: async (sql, params) => { order.push('title'); return session.tx.query(sql, params); } };
  await thenAdoptSessionTitle(async () => { order.push('fan-out'); }, target, 'Course')(tx);
  assert.deepEqual(order, ['fan-out', 'title']);
  assert.equal(session.row.title, 'Course');

  const failing = conversation(LESSON_AUTHOR_DEFAULT_SESSION_TITLE);
  await assert.rejects(thenAdoptSessionTitle(async () => { throw new Error('fan-out failed'); }, target, 'Course')(failing.tx),
    /fan-out failed/);
  assert.equal(failing.queries.length, 0);
});
