import { QUEUES } from '../../config/rabbitmq/index.js';
import { env } from '../../config/env.js';
import {
  markJobRetryable,
  requeuePendingDeletionJobs,
  runDeletionJob,
} from './course-deletion.service.js';
import { consumeJobWakeUps, startJobPoller } from '../../platform/job-runner/index.js';
import { swallowAndLog } from '../../utils/best-effort.js';

export async function startCourseDeletionWorker(): Promise<void> {
  await consumeJobWakeUps({
    queue: QUEUES.COURSE_DELETE,
    logPrefix: '[CourseDeleteWorker]',
    prefetch: 1,
    // The job row carries its own retry backoff (next_attempt_at).
    retryBackoff: false,
    run: runDeletionJob,
    onRunFailed: (jobId, err) => markJobRetryable(jobId, err).catch(swallowAndLog('course_deletion.retry_mark')),
    onRetriesExhausted: jobId => markJobRetryable(jobId, 'RabbitMQ retry limit reached; DB sweeper will retry'),
    requiredJobId: {
      missingJobIdMessage: 'Missing course deletion jobId',
      onRetriesExhaustedError: (err) => {
        console.error('[CourseDeleteWorker] Max retry handler failed:', err);
      },
    },
  });

  await requeuePendingDeletionJobs().catch((err) => {
    console.error('[CourseDeleteWorker] Failed to requeue pending jobs:', err);
  });

  startJobPoller({
    intervalMs: env.DELETION_REQUEUE_INTERVAL_MS,
    tick: () => requeuePendingDeletionJobs(),
    onError: (error) => {
      console.error('[CourseDeleteWorker] Periodic requeue failed:', error);
    },
  });
}
