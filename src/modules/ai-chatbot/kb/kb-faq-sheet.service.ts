// ═══════════════════════════════════════════════════════════════
// KB FAQ sheet reader — runs the workbook parse in a worker thread
//
// Parsing a 10 MB workbook takes seconds of synchronous CPU; on the event
// loop that froze every request of the process (and could miss RabbitMQ
// heartbeats). Each upload gets a worker with a memory limit and a deadline
// (KB_FAQ_SHEET_READ_*); at most KB_FAQ_SHEET_READ_CONCURRENCY run at once
// per process, the others wait their turn. A file over the size limit is
// refused before any parse.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { env } from '../../../config/env.js';
import { KbFaqSheetReadError, type FaqSheetSummary } from './kb-faq-sheet.logic.js';
import { MAX_FAQ_FILE_SIZE } from './kb.validator.js';

export interface FaqSheetReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxMemoryMb?: number;
  /** Injected in tests. */
  workerUrl?: URL;
}

const DEFAULT_WORKER_URL = new URL('./kb-faq-sheet.worker.js', import.meta.url);

let activeReads = 0;
const waitingReads: Array<() => void> = [];

async function acquireReadSlot(): Promise<void> {
  if (activeReads < env.KB_FAQ_SHEET_READ_CONCURRENCY) {
    activeReads += 1;
    return;
  }
  // The slot is handed over by releaseReadSlot(), already counted.
  await new Promise<void>((resolve) => waitingReads.push(resolve));
}

function releaseReadSlot(): void {
  const next = waitingReads.shift();
  if (next) next();
  else activeReads -= 1;
}

type WorkerReply = { ok: true; summary: FaqSheetSummary } | { ok: false; message: string };

function runWorker(filePath: string, options: Required<Omit<FaqSheetReadOptions, 'maxBytes'>>): Promise<FaqSheetSummary> {
  return new Promise<FaqSheetSummary>((resolve, reject) => {
    const worker = new Worker(options.workerUrl, {
      workerData: { filePath },
      resourceLimits: { maxOldGenerationSizeMb: options.maxMemoryMb },
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      void worker.terminate().catch(() => undefined); // the worker is discarded either way
    };
    const timer = setTimeout(() => finish(() => reject(new KbFaqSheetReadError('TOO_COMPLEX'))), options.timeoutMs);
    worker.once('message', (reply: WorkerReply) => finish(() => {
      if (reply.ok) resolve(reply.summary);
      else reject(new Error(reply.message));
    }));
    worker.once('error', (error: Error & { code?: string }) => finish(() => {
      reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new KbFaqSheetReadError('TOO_COMPLEX') : error);
    }));
    worker.once('exit', (code) => finish(() => reject(new Error(`FAQ sheet reader stopped (exit code ${code})`))));
  });
}

/** Reads the uploaded FAQ workbook in a worker thread and summarizes its first sheet. */
export async function readFaqSheetSummary(filePath: string, options: FaqSheetReadOptions = {}): Promise<FaqSheetSummary> {
  const stat = await fs.stat(filePath);
  if (stat.size > (options.maxBytes ?? MAX_FAQ_FILE_SIZE)) throw new KbFaqSheetReadError('TOO_LARGE');
  await acquireReadSlot();
  try {
    return await runWorker(filePath, {
      timeoutMs: options.timeoutMs ?? env.KB_FAQ_SHEET_READ_TIMEOUT_MS,
      maxMemoryMb: options.maxMemoryMb ?? env.KB_FAQ_SHEET_READ_MAX_MEMORY_MB,
      workerUrl: options.workerUrl ?? DEFAULT_WORKER_URL,
    });
  } finally {
    releaseReadSlot();
  }
}
