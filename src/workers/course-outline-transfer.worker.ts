// Dedicated, resumable course-outline transfer worker. PostgreSQL claims one
// job with SKIP LOCKED, so a future second process cannot process it twice.
// The poll loop is modules/course-authoring/course-outline-transfer.worker.ts.

import { pool } from '../config/database.js';
import { logDatabaseConnectionHeadroom, ownDirectConnectionMax } from '../config/database-headroom.js';
import { env } from '../config/env.js';
import {
  isCourseOutlineTransferSchemaReady,
  processNextCourseOutlineTransferJob,
} from '../modules/course-authoring/course-outline-transfer.service.js';
import { createCourseOutlineTransferWorkerLoop } from '../modules/course-authoring/course-outline-transfer.worker.js';
import { startProcessHeartbeat } from '../modules/metrics/heartbeat.service.js';

let stopping = false;
const loop = createCourseOutlineTransferWorkerLoop({
  pollIntervalMs: env.COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS,
  isSchemaReady: isCourseOutlineTransferSchemaReady,
  processNextJob: processNextCourseOutlineTransferJob,
});

async function run(): Promise<void> {
  if (!env.COURSE_OUTLINE_TRANSFER_WORKER_ENABLED) {
    console.log('[CourseOutlineTransferWorker] Disabled by COURSE_OUTLINE_TRANSFER_WORKER_ENABLED=false.');
    return;
  }

  console.log(`[CourseOutlineTransferWorker] Started. environment=${env.NODE_ENV}`);
  startProcessHeartbeat({ role: 'course-outline-transfer-worker' });
  void logDatabaseConnectionHeadroom('course-outline-transfer-worker', ownDirectConnectionMax({ readsReports: false }));
  await loop.run();
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[CourseOutlineTransferWorker] ${signal} received; stopping after current operation.`);
  loop.stop();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

run().then(() => pool.end()).catch(async (error) => {
  console.error('[CourseOutlineTransferWorker] Fatal error:', error);
  await pool.end();
  process.exit(1);
});
