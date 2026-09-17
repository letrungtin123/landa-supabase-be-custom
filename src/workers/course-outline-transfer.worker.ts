// Dedicated, resumable course-outline transfer worker. PostgreSQL claims one
// job with SKIP LOCKED, so a future second process cannot process it twice.

import { pool } from '../config/database.js';
import { env } from '../config/env.js';
import {
  isCourseOutlineTransferSchemaReady,
  processNextCourseOutlineTransferJob,
} from '../modules/course-authoring/course-outline-transfer.service.js';

let stopping = false;
let wake: (() => void) | null = null;
let schemaWarningShown = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (wake === done) wake = null;
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    wake = done;
  });
}

async function run(): Promise<void> {
  if (!env.COURSE_OUTLINE_TRANSFER_WORKER_ENABLED) {
    console.log('[CourseOutlineTransferWorker] Disabled by COURSE_OUTLINE_TRANSFER_WORKER_ENABLED=false.');
    return;
  }

  console.log(`[CourseOutlineTransferWorker] Started. environment=${env.NODE_ENV}`);
  while (!stopping) {
    if (!await isCourseOutlineTransferSchemaReady()) {
      if (!schemaWarningShown) {
        console.warn('[CourseOutlineTransferWorker] Waiting for the approved manual SQL migration. No transfer job was changed.');
        schemaWarningShown = true;
      }
      await sleep(env.COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS);
      continue;
    }
    schemaWarningShown = false;
    const handled = await processNextCourseOutlineTransferJob();
    await sleep(handled ? 250 : env.COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS);
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[CourseOutlineTransferWorker] ${signal} received; stopping after current operation.`);
  wake?.();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

run().then(() => pool.end()).catch(async (error) => {
  console.error('[CourseOutlineTransferWorker] Fatal error:', error);
  await pool.end();
  process.exit(1);
});
