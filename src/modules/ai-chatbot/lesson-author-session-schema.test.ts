import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../../../../supabase/manual_sql/20261002_2345_lesson_author_session_deletion_jobs.sql', import.meta.url), 'utf8');
const service = readFileSync(new URL('./lesson-author-session.service.ts', import.meta.url), 'utf8');
const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
const chatService = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
const controller = readFileSync(new URL('./lesson-author-session.controller.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./lesson-author-session-deletion.worker.ts', import.meta.url), 'utf8');
const executable = sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');

test('session deletion schema is additive, private and keeps terminal jobs after conversation purge', () => {
  assert.match(sql, /MANUAL INSTALLATION PENDING/);
  assert.match(sql, /Direct execution by Codex: Forbidden/);
  assert.match(executable.trim(), /^BEGIN;/);
  assert.match(executable.trim(), /COMMIT;$/);
  assert.equal((executable.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.match(executable, /CREATE TABLE IF NOT EXISTS public\.lesson_author_session_deletion_jobs/);
  assert.match(executable, /CREATE UNIQUE INDEX IF NOT EXISTS uq_la_session_delete_active/);
  assert.match(executable, /CREATE INDEX IF NOT EXISTS idx_la_session_delete_recovery/);
  assert.match(executable, /CREATE INDEX IF NOT EXISTS idx_la_session_delete_terminal_retention/);
  assert.match(executable, /REVOKE ALL ON TABLE public\.lesson_author_session_deletion_jobs FROM anon, authenticated/);
  assert.match(executable, /ALTER TABLE public\.lesson_author_session_deletion_jobs ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(executable, /conversation_id[^,\n]*REFERENCES/i);
  assert.doesNotMatch(executable, /DROP TABLE|TRUNCATE|DELETE FROM|UPDATE public\.|INSERT INTO public\./i);
});

test('worker deletes only the owned conversation while preserving applied course blocks', () => {
  assert.match(service, /DELETE FROM chat_conversations WHERE id=\$1::uuid AND tenant_id=\$2::uuid AND user_id=\$3::uuid AND course_id=\$4/);
  assert.match(service, /DELETE FROM lesson_author_blueprints/);
  assert.doesNotMatch(service, /DELETE FROM course_blocks|UPDATE course_blocks|INSERT INTO course_blocks/);
  assert.match(service, /applied_course_blocks_preserved/);
  assert.match(service, /lease_expires_at/);
  assert.match(service, /requeueLessonAuthorSessionDeletionJobs/);
  assert.match(service, /assertLessonAuthorSessionDeletionSchema/);
  assert.ok(worker.indexOf('assertLessonAuthorSessionDeletionSchema()') < worker.indexOf('consume(QUEUES.LESSON_AUTHOR_SESSION_DELETE'));
  assert.match(service, /ORDER BY c\.updated_at DESC,c\.id DESC/);
  assert.match(service, /\(c\.updated_at,c\.id\)<\(\$4::timestamptz,\$5::uuid\)/);
  assert.match(service, /c\.updated_at::text AS updated_at/);
  assert.doesNotMatch(service, /encodeCursor\(new Date\(last\.updated_at\)\.toISOString\(\)/);
});

test('dedicated course-scoped routes do not reuse the generic conversation delete boundary', () => {
  for (const path of ['/sessions\'', '/sessions/:conversationId\'', '/sessions/:conversationId/delete-impact', '/session-deletions/:jobId']) {
    assert.match(routes, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(routes, /checkPermission\('courses', 'can_edit'\)/);
  assert.match(chatService, /chat_conversations\.target <> 'lesson_author'/);
  assert.match(controller, /withLessonAuthorConversationLock/);
  assert.match(chatService, /pg_advisory_xact_lock\(hashtextextended\(\$1::text, 20261002\)\)/);
});
