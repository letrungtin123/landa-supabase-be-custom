import { QUEUES } from '../../config/rabbitmq/index.js';
import { env } from '../../config/env.js';
import { consumeJobWakeUps, startJobPoller } from '../../platform/job-runner/index.js';
import {
  markCourseProgressRecalculationJobFailed,
  markCourseProgressRecalculationJobRetryable,
  requeuePendingCourseProgressRecalculationJobs,
  runCourseProgressRecalculationJob,
} from './progress-recalculation-job.service.js';

export async function startCourseProgressRecalculationWorker(): Promise<void> {
  if (!env.COURSE_PROGRESS_RECALC_WORKER_ENABLED) {
    console.log('[course-progress-recalculation] Worker disabled');
    return;
  }

  await consumeJobWakeUps({
    queue: QUEUES.COURSE_PROGRESS_RECALC,
    logPrefix: '[course-progress-recalculation]',
    prefetch: env.COURSE_PROGRESS_RECALC_RABBIT_PREFETCH,
    // A failed job goes straight back to 'queued' (no backoff in its row),
    // and after the last retry it is marked failed: wait between attempts
    // so a short database or broker blip does not fail it within ms.
    retryBackoff: true,
    run: runCourseProgressRecalculationJob,
    onRunFailed: markCourseProgressRecalculationJobRetryable,
    onRetriesExhausted: jobId => markCourseProgressRecalculationJobFailed(jobId, new Error('Max retries reached')),
  });

  await requeuePendingCourseProgressRecalculationJobs();

  startJobPoller({
    intervalMs: env.COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS,
    tick: () => requeuePendingCourseProgressRecalculationJobs(),
    onError: error => {
      console.error('[course-progress-recalculation] Poller failed', error);
    },
  });
}
