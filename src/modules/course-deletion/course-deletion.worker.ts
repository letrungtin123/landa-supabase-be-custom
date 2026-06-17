import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import {
  markJobFailed,
  markJobRetryable,
  requeuePendingDeletionJobs,
  runDeletionJob,
} from './course-deletion.service.js';

function parseJobId(data: Record<string, any>): string {
  const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : '';
  if (!jobId) throw new Error('Missing course deletion jobId');
  return jobId;
}

async function processCourseDeletionJob(data: Record<string, any>): Promise<void> {
  const jobId = parseJobId(data);
  try {
    await runDeletionJob(jobId);
  } catch (err) {
    await markJobRetryable(jobId, err).catch(() => {});
    throw err;
  }
}

export async function startCourseDeletionWorker(): Promise<void> {
  await consume(
    QUEUES.COURSE_DELETE,
    processCourseDeletionJob,
    async function onMaxRetry(_queue: string, rawMessage: string) {
      try {
        const parsed = JSON.parse(rawMessage) as Record<string, any>;
        const jobId = parseJobId(parsed);
        await markJobFailed(jobId, 'Max retries reached for course deletion job');
      } catch (err) {
        console.error('[CourseDeleteWorker] Max retry handler failed:', err);
      }
    },
  );

  await requeuePendingDeletionJobs().catch((err) => {
    console.error('[CourseDeleteWorker] Failed to requeue pending jobs:', err);
  });
}
