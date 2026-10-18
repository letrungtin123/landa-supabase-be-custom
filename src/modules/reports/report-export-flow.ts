// ═══════════════════════════════════════════════════════════════
// Report Excel exports: bounded memory whatever the client's speed
//
// ExcelJS's streaming WorkbookWriter hands each sheet's XML to its zip
// (archiver) through a StreamBuf that ignores backpressure: archiver puts it
// in a PassThrough whose buffer grows without limit while the zip waits for
// its output. Piped straight to a slow client, the whole uncompressed file
// ended up in memory. Two pieces bound it:
//
// 1. trackWorkbookBacklog() gives each sheet that PassThrough itself (the
//    one archiver would create: archiver-utils normalizeInputSource), so the
//    XML handed over but not yet zipped is visible; the cursor sheets call
//    waitForWorkbookRoom() before each batch and wait while it is above
//    WORKBOOK_BACKLOG_LIMIT_BYTES. Same bytes in the same order: the zip is
//    unchanged.
// 2. spoolReportExport() writes the zip to a temp file and sends that file
//    to the client as it grows, at the client's pace (write() / 'drain').
//    The zip only waits for the local disk, so the export's database
//    snapshot ends as soon as the file is generated, exactly as before;
//    a slow or paused download holds a file, not memory or a connection.
//    When the client leaves, the export stops (the same signal as the
//    controller's), and the temp file is removed in every outcome.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { ReportsSnapshotAbortedError, throwIfReportsAborted } from '../../config/reports-database.js';

/** Sheet XML handed to the zip and not compressed yet, above which the next batch waits. */
export const WORKBOOK_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;
export const REPORT_EXPORT_SPOOL_DIR = path.join(os.tmpdir(), 'landa-report-exports');
/** Older than any export still being generated or downloaded: crash residue. */
export const REPORT_EXPORT_SPOOL_MAX_AGE_MS = 12 * 60 * 60_000;
const SPOOL_HIGH_WATER_MARK = 1024 * 1024;
const SEND_CHUNK_BYTES = 64 * 1024;

// ── 1. Sheet backlog ──

interface ZipAppender {
  append(source: unknown, data: unknown): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

interface WorkbookBacklog {
  bytes(): number;
  waitBelow(limit: number, signal?: AbortSignal): Promise<void>;
}

const backlogs = new WeakMap<object, WorkbookBacklog>();

/** A stream archiver cannot read directly (ExcelJS StreamBuf): it wraps those in a PassThrough. */
function isLegacyStream(source: unknown): source is { pipe(destination: Writable): unknown } {
  return typeof source === 'object' && source !== null
    && typeof (source as { pipe?: unknown }).pipe === 'function'
    && !(source as { _readableState?: unknown })._readableState;
}

/**
 * Follows the sheet XML of `workbook` (an ExcelJS stream WorkbookWriter)
 * that its zip has not read yet. Call it right after creating the writer,
 * before any sheet is added.
 */
export function trackWorkbookBacklog(workbook: object): void {
  const zip = (workbook as { zip?: ZipAppender }).zip;
  if (!zip || typeof zip.append !== 'function' || typeof zip.on !== 'function') {
    throw new Error('ExcelJS WorkbookWriter without its zip: the export cannot follow its backlog');
  }
  const entries = new Set<PassThrough>();
  const waiters = new Set<() => void>();
  let zipError: Error | null = null;
  const wake = () => { for (const resume of [...waiters]) resume(); };
  zip.on('error', (error) => { zipError = error; wake(); });

  const append = zip.append.bind(zip);
  zip.append = (source: unknown, data: unknown) => {
    if (!isLegacyStream(source)) return append(source, data);
    const entry = new PassThrough();
    source.pipe(entry);
    entries.add(entry);
    const done = () => { entries.delete(entry); wake(); };
    entry.on('drain', wake);
    entry.once('end', done);
    entry.once('close', done);
    entry.once('error', done);
    return append(entry, data);
  };

  const bytes = () => {
    let total = 0;
    for (const entry of entries) total += entry.writableLength + entry.readableLength;
    return total;
  };
  backlogs.set(workbook, {
    bytes,
    async waitBelow(limit, signal) {
      while (bytes() > limit) {
        throwIfReportsAborted(signal);
        if (zipError) throw zipError;
        await new Promise<void>((resolve) => {
          const resume = () => {
            waiters.delete(resume);
            signal?.removeEventListener('abort', resume);
            resolve();
          };
          waiters.add(resume);
          signal?.addEventListener('abort', resume, { once: true });
        });
      }
      throwIfReportsAborted(signal);
    },
  });
}

/** Sheet XML of the workbook not zipped yet (0 for a workbook that is not tracked). */
export function workbookBacklogBytes(workbook: object): number {
  return backlogs.get(workbook)?.bytes() ?? 0;
}

/** Waits until the workbook's zip has caught up enough for the next batch of rows. */
export async function waitForWorkbookRoom(workbook: object, signal?: AbortSignal, limitBytes = WORKBOOK_BACKLOG_LIMIT_BYTES): Promise<void> {
  const backlog = backlogs.get(workbook);
  if (!backlog) throw new Error('waitForWorkbookRoom() needs trackWorkbookBacklog() on the workbook first');
  await backlog.waitBelow(limitBytes, signal);
}

// ── 2. Spool file, sent as it grows ──

function waitForEvent(emitters: Array<[NodeJS.EventEmitter, string]>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      for (const [emitter, event] of emitters) emitter.removeListener(event, done);
      resolve();
    };
    for (const [emitter, event] of emitters) emitter.once(event, done);
  });
}

class ReportExportSpool extends Writable {
  /** Bytes on disk: everything below this offset can be sent. */
  private size = 0;
  private complete = false;
  private failure: Error | null = null;

  constructor(private readonly handle: FileHandle, readonly filePath: string) {
    super({ highWaterMark: SPOOL_HIGH_WATER_MARK });
    // Recorded for the sender; the writer (archiver, ExcelJS) sees it too.
    this.on('error', (error) => {
      this.failure = error;
      this.emit('grew');
    });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.append(chunk).then(() => callback(), callback);
  }

  override _writev(chunks: Array<{ chunk: Buffer }>, callback: (error?: Error | null) => void): void {
    this.append(Buffer.concat(chunks.map((item) => item.chunk))).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.complete = true;
    this.emit('grew');
    callback();
  }

  private async append(data: Buffer): Promise<void> {
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await this.handle.write(data, written, data.length - written, this.size + written);
      written += bytesWritten;
    }
    this.size += written;
    this.emit('grew');
  }

  /**
   * Sends the file to `destination` as it grows, respecting its
   * backpressure, then ends it. Rejects with ReportsSnapshotAbortedError
   * when the destination closes first, or with the spool's failure.
   */
  async sendTo(destination: Writable): Promise<void> {
    let gone = false;
    const markGone = () => { gone = true; };
    destination.once('close', markGone);
    destination.once('error', markGone);
    try {
      let offset = 0;
      for (;;) {
        if (gone || destination.destroyed) throw new ReportsSnapshotAbortedError();
        if (this.failure) throw this.failure;
        if (offset < this.size) {
          const length = Math.min(SEND_CHUNK_BYTES, this.size - offset);
          const chunk = Buffer.allocUnsafe(length);
          const { bytesRead } = await this.handle.read(chunk, 0, length, offset);
          if (bytesRead !== length) throw new Error('Report export spool: short read');
          offset += length;
          if (!destination.write(chunk)) await waitForEvent([[destination, 'drain'], [destination, 'close'], [destination, 'error']]);
          continue;
        }
        if (this.complete) break;
        await waitForEvent([[this, 'grew'], [destination, 'close'], [destination, 'error']]);
      }
      if (gone || destination.destroyed) throw new ReportsSnapshotAbortedError();
      const finished = waitForEvent([[destination, 'finish'], [destination, 'close'], [destination, 'error']]);
      destination.end();
      await finished;
      if (!destination.writableFinished) throw new ReportsSnapshotAbortedError();
    } finally {
      destination.removeListener('close', markGone);
      destination.removeListener('error', markGone);
    }
  }

  async dispose(): Promise<void> {
    if (!this.destroyed) this.destroy();
    await this.handle.close().catch(() => undefined); // the unlink below reports a leftover spool file
    await fs.unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') console.warn(JSON.stringify({ event: 'report_export_spool_cleanup_failed', code: error.code ?? null }));
    });
  }
}

async function openReportExportSpool(directory: string): Promise<ReportExportSpool> {
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${Date.now()}-${randomUUID()}.xlsx.part`);
  return new ReportExportSpool(await fs.open(filePath, 'wx+', 0o600), filePath);
}

/**
 * Runs `generate` with a sink (the temp file) and a signal that aborts when
 * `signal` does or when `destination` goes away, while the file is sent to
 * `destination`. Resolves once the whole file reached the destination.
 */
export async function spoolReportExport(
  destination: Writable,
  signal: AbortSignal | undefined,
  generate: (sink: Writable, signal: AbortSignal) => Promise<void>,
  options: { directory?: string } = {},
): Promise<void> {
  const spool = await openReportExportSpool(options.directory ?? REPORT_EXPORT_SPOOL_DIR);
  const sendingStopped = new AbortController();
  const exportSignal = signal ? AbortSignal.any([signal, sendingStopped.signal]) : sendingStopped.signal;
  // Settles with the sending failure (or null); generation stops as soon as sending does.
  const sending = spool.sendTo(destination).then(() => null, (error: unknown) => {
    sendingStopped.abort();
    return { error };
  });

  let generation: { error: unknown } | null = null;
  try {
    await generate(spool, exportSignal);
  } catch (error) {
    generation = { error };
    spool.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  const sent = await sending;
  await spool.dispose();
  if (generation) {
    // Stopped because sending failed (a full disk, say): report that cause, not the stop.
    if (generation.error instanceof ReportsSnapshotAbortedError && sent && !(sent.error instanceof ReportsSnapshotAbortedError)) {
      throw sent.error;
    }
    throw generation.error;
  }
  if (sent) throw sent.error;
}

/** Removes spool files a crashed process left behind (older than REPORT_EXPORT_SPOOL_MAX_AGE_MS). */
export async function cleanupStaleReportExportSpools(options: { minAgeMs?: number; directory?: string; now?: () => number } = {}): Promise<number> {
  const directory = options.directory ?? REPORT_EXPORT_SPOOL_DIR;
  const cutoff = (options.now ?? Date.now)() - (options.minAgeMs ?? REPORT_EXPORT_SPOOL_MAX_AGE_MS);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    console.warn('[ReportsExport] Cannot list stale export files:', (error as Error).message);
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith('.xlsx.part')) continue;
    const filePath = path.join(directory, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      await fs.unlink(filePath);
      deleted += 1;
    } catch {
      continue; // Gone or still open: the next start tries again.
    }
  }
  if (deleted > 0) console.log(`[ReportsExport] Removed ${deleted} stale export file(s)`);
  return deleted;
}
