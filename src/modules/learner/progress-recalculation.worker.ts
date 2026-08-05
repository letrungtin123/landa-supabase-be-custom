import { consume } from '../../config/rabbitmq/consumer.js';
import { QUEUES } from '../../config/rabbitmq/index.js';
import { env } from '../../config/env.js';
import {
  markCourseProgressRecalculationJobFailed,
  markCourseProgressRecalculationJobRetryable,
  requeuePendingCourseProgressRecalculationJobs,
  runCourseProgressRecalculationJob,
} from './progress-recalculation-job.service.js';

interface CourseProgressRecalculationMessage {
  [key: string]: unknown;
  jobId?: unknown;
}

const getJobId = (message: CourseProgressRecalculationMessage): string | null => {
  return typeof message.jobId === 'string' && message.jobId.trim() ? message.jobId.trim() : null;
};

const getJobIdFromRawMessage = (rawMessage: string): string | null => {
  try {
    return getJobId(JSON.parse(rawMessage));
  } catch {
    return null;
  }
};

export async function startCourseProgressRecalculationWorker(): Promise<void> {
  if (!env.COURSE_PROGRESS_RECALC_WORKER_ENABLED) {
    console.log('[course-progress-recalculation] Worker disabled');
    return;
  }

  await consume(
    QUEUES.COURSE_PROGRESS_RECALC,
    async (message: CourseProgressRecalculationMessage) => {
      const jobId = getJobId(message);
      if (!jobId) {
        console.warn('[course-progress-recalculation] Ignoring message without jobId');
        return;
      }

      try {
        await runCourseProgressRecalculationJob(jobId);
      } catch (error) {
        await markCourseProgressRecalculationJobRetryable(jobId, error);
        throw error;
      }
    },
    async (_queue: string, rawMessage: string) => {
      const jobId = getJobIdFromRawMessage(rawMessage);
      if (!jobId) return;
      await markCourseProgressRecalculationJobFailed(jobId, new Error('Max retries reached'));
    },
    {
      prefetch: env.COURSE_PROGRESS_RECALC_RABBIT_PREFETCH,
    },
  );

  await requeuePendingCourseProgressRecalculationJobs();

  if (env.COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS > 0) {
    setInterval(() => {
      requeuePendingCourseProgressRecalculationJobs().catch((error) => {
        console.error('[course-progress-recalculation] Poller failed', error);
      });
    }, env.COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS).unref();
  }
}

