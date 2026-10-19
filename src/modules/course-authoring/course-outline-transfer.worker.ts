// The poll loop of the course outline transfer worker. Its PM2 entry point,
// src/workers/course-outline-transfer.worker.ts, checks the enabled flag,
// starts the heartbeat, runs this loop and stops it on SIGINT / SIGTERM.
//
// Each turn waits for the transfer schema, then processes at most one due job
// (course-outline-transfer-job.service.ts) and sleeps: 250 ms after a job,
// the poll interval when none was due. A turn that throws (the claim, or the
// mark of a failed attempt, could not reach the database) is logged and the
// loop tries again after the poll interval instead of ending the process. A
// job whose failed attempt could not be marked keeps its lease, and the claim
// takes it again once that lease has expired. stop() ends a sleep at once; a
// turn already running finishes first.

import { errorKind } from '../../utils/best-effort.js';

const PAUSE_AFTER_JOB_MS = 250;

export interface CourseOutlineTransferWorkerLoopOptions {
  pollIntervalMs: number;
  /** False while the approved manual SQL migration is missing; never throws. */
  isSchemaReady(): Promise<boolean>;
  /** Claims and processes one due job; false when none was due. */
  processNextJob(): Promise<boolean>;
}

export interface CourseOutlineTransferWorkerLoop {
  /** Runs until stop(). */
  run(): Promise<void>;
  stop(): void;
}

export function createCourseOutlineTransferWorkerLoop(
  options: CourseOutlineTransferWorkerLoopOptions,
): CourseOutlineTransferWorkerLoop {
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

  async function tryProcessNextJob(): Promise<boolean> {
    try {
      return await options.processNextJob();
    } catch (error) {
      // The kind only (e.g. "Error:ECONNREFUSED"): a database error's message
      // or detail can carry row values.
      console.error(
        `[CourseOutlineTransferWorker] Could not claim a transfer job or record its failed attempt (${errorKind(error)}); trying again in ${options.pollIntervalMs} ms.`,
      );
      return false;
    }
  }

  return {
    async run() {
      while (!stopping) {
        if (!await options.isSchemaReady()) {
          if (!schemaWarningShown) {
            console.warn('[CourseOutlineTransferWorker] Waiting for the approved manual SQL migration. No transfer job was changed.');
            schemaWarningShown = true;
          }
          await sleep(options.pollIntervalMs);
          continue;
        }
        schemaWarningShown = false;
        const handled = await tryProcessNextJob();
        await sleep(handled ? PAUSE_AFTER_JOB_MS : options.pollIntervalMs);
      }
    },
    stop() {
      stopping = true;
      wake?.();
    },
  };
}
