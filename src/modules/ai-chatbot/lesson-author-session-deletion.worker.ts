import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import { env } from '../../config/env.js';
import {
  assertLessonAuthorSessionDeletionSchema,
  markLessonAuthorSessionDeletionRetryable,
  requeueLessonAuthorSessionDeletionJobs,
  runLessonAuthorSessionDeletion,
} from './lesson-author-session.service.js';

function jobId(payload: Record<string, unknown>): string {
  const value = typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
  if (!value) throw new Error('Missing lesson author session deletion jobId');
  return value;
}

export async function startLessonAuthorSessionDeletionWorker(): Promise<void> {
  await assertLessonAuthorSessionDeletionSchema();
  await consume(QUEUES.LESSON_AUTHOR_SESSION_DELETE, async payload => {
    const id = jobId(payload);
    try { await runLessonAuthorSessionDeletion(id); }
    catch (error) { await markLessonAuthorSessionDeletionRetryable(id, error).catch(() => undefined); throw error; }
  }, async (_queue, raw) => {
    try { await markLessonAuthorSessionDeletionRetryable(jobId(JSON.parse(raw)), 'RabbitMQ retry limit reached; database recovery will continue'); }
    catch (error) { console.error('[LessonAuthorSessionDelete] max retry handler failed', error); }
  });
  await requeueLessonAuthorSessionDeletionJobs().catch(error => console.error('[LessonAuthorSessionDelete] startup recovery failed', error));
  setInterval(() => {
    void requeueLessonAuthorSessionDeletionJobs().catch(error => console.error('[LessonAuthorSessionDelete] recovery failed', error));
  }, env.DELETION_REQUEUE_INTERVAL_MS).unref();
}
