import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import { env } from '../../config/env.js';
import {
  markUserDeletionJobRetryable,
  requeuePendingUserDeletionJobs,
  runUserDeletionJob,
} from './user-deletion.service.js';

function getJobId(data: Record<string, unknown>): string {
  const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : '';
  if (!jobId) throw new Error('Missing user deletion jobId');
  return jobId;
}

export async function startUserDeletionWorker(): Promise<void> {
  await consume(
    QUEUES.USER_DELETE,
    async (data) => {
      const jobId = getJobId(data);
      try {
        await runUserDeletionJob(jobId);
      } catch (error) {
        await markUserDeletionJobRetryable(jobId, error).catch(() => undefined);
        throw error;
      }
    },
    async (_queue, raw) => {
      const jobId = getJobId(JSON.parse(raw) as Record<string, unknown>);
      await markUserDeletionJobRetryable(jobId, 'RabbitMQ retry limit reached; DB sweeper will retry');
    },
  );

  await requeuePendingUserDeletionJobs().catch((error) => {
    console.error('[UserDelete] Startup requeue failed:', error);
  });

  setInterval(() => {
    requeuePendingUserDeletionJobs().catch((error) => {
      console.error('[UserDelete] Periodic requeue failed:', error);
    });
  }, env.DELETION_REQUEUE_INTERVAL_MS).unref();
}
