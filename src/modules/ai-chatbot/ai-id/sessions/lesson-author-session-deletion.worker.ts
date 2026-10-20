import { QUEUES } from '../../../../config/rabbitmq/index.js';
import { env } from '../../../../config/env.js';
import {
  assertLessonAuthorSessionDeletionSchema,
  markLessonAuthorSessionDeletionRetryable,
  requeueLessonAuthorSessionDeletionJobs,
  runLessonAuthorSessionDeletion,
} from './lesson-author-session.service.js';
import { consumeJobWakeUps, startJobPoller } from '../../../../platform/job-runner/index.js';
import { swallowAndLog } from '../../../../utils/best-effort.js';

export async function startLessonAuthorSessionDeletionWorker(): Promise<void> {
  await assertLessonAuthorSessionDeletionSchema();
  await consumeJobWakeUps({
    queue: QUEUES.LESSON_AUTHOR_SESSION_DELETE,
    logPrefix: '[LessonAuthorSessionDelete]',
    prefetch: 1,
    // The job row carries its own retry backoff (next_attempt_at).
    retryBackoff: false,
    run: runLessonAuthorSessionDeletion,
    onRunFailed: (jobId, error) =>
      markLessonAuthorSessionDeletionRetryable(jobId, error).catch(swallowAndLog('lesson_author.session_deletion_retry_mark')),
    onRetriesExhausted: jobId =>
      markLessonAuthorSessionDeletionRetryable(jobId, 'RabbitMQ retry limit reached; database recovery will continue'),
    requiredJobId: {
      missingJobIdMessage: 'Missing lesson author session deletion jobId',
      onRetriesExhaustedError: error => console.error('[LessonAuthorSessionDelete] max retry handler failed', error),
    },
  });
  await requeueLessonAuthorSessionDeletionJobs().catch(error => console.error('[LessonAuthorSessionDelete] startup recovery failed', error));
  startJobPoller({
    intervalMs: env.DELETION_REQUEUE_INTERVAL_MS,
    tick: () => requeueLessonAuthorSessionDeletionJobs(),
    onError: error => console.error('[LessonAuthorSessionDelete] recovery failed', error),
  });
}
