import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// P3: an Excel export respects backpressure. The sheet XML waiting for the
// zip is bounded, the zip goes to a temp file that is sent at the client's
// pace, and the file is the same whatever the client's speed. No database:
// the reports pool is faked.

const ExcelJS = (await import('exceljs')).default;
const pg = await import('pg');
const flow = await import('./report-export-flow.js');
const { ReportsSnapshotAbortedError } = await import('../../config/reports-database.js');
const exportService = await import('./reports-export.service.js');
const { pool: mainPool } = await import('../../config/database.js');
const { endReportsPool } = await import('../../config/reports-database.js');

test.after(async () => {
  await endReportsPool();
  await mainPool.end();
});

function scratchDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'landa-report-flow-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A client whose reads are held until `flow(true)`; `paced` reads one chunk per tick. */
function heldClient(options: { paced?: boolean } = {}) {
  const chunks: Buffer[] = [];
  const held: Array<() => void> = [];
  let flowing = false;
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      if (flowing && !options.paced) setImmediate(callback);
      else held.push(callback);
    },
  });
  let timer: NodeJS.Timeout | undefined;
  return {
    sink,
    bytes: () => Buffer.concat(chunks),
    flow(on: boolean) {
      flowing = on;
      if (!on) return;
      if (options.paced) {
        timer = setInterval(() => held.shift()?.(), 1);
      } else {
        for (const callback of held.splice(0)) callback();
      }
    },
    stop: () => clearInterval(timer),
  };
}

function addBatch(sheet: { addRow(values: unknown[]): { commit(): void } }, batch: number, rows: number): void {
  for (let i = 0; i < rows; i++) {
    // Random text: the zip cannot shrink it, so its output fills up as soon as the client stops reading.
    sheet.addRow([`user-${batch}-${i}`, randomBytes(150).toString('base64'), i, batch * rows + i]).commit();
  }
}

/**
 * Adds batches until XML waits for the zip. The zip chain itself (archiver
 * keeps up to 1 MB on each side) first absorbs a few MB of compressed output.
 */
async function fillUntilBacklog(workbook: object, sheet: Parameters<typeof addBatch>[0], limit: number, nextBatch: () => number): Promise<void> {
  for (let round = 0; ; round++) {
    assert.ok(round < 200, 'the backlog builds up while the client reads nothing');
    addBatch(sheet, nextBatch(), 1_000);
    await delay(20);
    if (flow.workbookBacklogBytes(workbook) <= limit) continue;
    await delay(100); // the zip has taken all it can: the backlog stays
    if (flow.workbookBacklogBytes(workbook) > limit) return;
  }
}

test('the next batch waits while the sheet XML the zip has not read is above the limit', async () => {
  const client = heldClient();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: client.sink, useStyles: true, useSharedStrings: false });
  flow.trackWorkbookBacklog(workbook);
  const sheet = workbook.addWorksheet('Rows');
  const limit = 512 * 1024;
  let batch = 0;
  await fillUntilBacklog(workbook, sheet, limit, () => batch++);
  const waiting = flow.waitForWorkbookRoom(workbook, undefined, limit);
  const early = await Promise.race([waiting.then(() => 'resumed'), delay(150).then(() => 'still waiting')]);
  assert.equal(early, 'still waiting', 'the client reads nothing, so the export waits');

  client.flow(true);
  await waiting;
  assert.ok(flow.workbookBacklogBytes(workbook) <= limit);
  let largest = 0;
  for (let more = 0; more < 6; more++) {
    await flow.waitForWorkbookRoom(workbook, undefined, limit);
    addBatch(sheet, batch++, 1_000);
    largest = Math.max(largest, flow.workbookBacklogBytes(workbook));
  }
  const oneBatch = 1_000 * 400;
  assert.ok(largest <= limit + oneBatch, `backlog ${largest} stays within the limit plus one batch`);
  sheet.commit();
  await workbook.commit();
  assert.equal(client.bytes().subarray(0, 2).toString('latin1'), 'PK', 'a complete zip');
});

test('waiting for room stops when the client goes away', async () => {
  const client = heldClient();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: client.sink, useStyles: true, useSharedStrings: false });
  flow.trackWorkbookBacklog(workbook);
  const sheet = workbook.addWorksheet('Rows');
  await fillUntilBacklog(workbook, sheet, 256 * 1024, () => 0);
  const gone = new AbortController();
  setTimeout(() => gone.abort(), 50);
  await assert.rejects(flow.waitForWorkbookRoom(workbook, gone.signal, 256 * 1024), ReportsSnapshotAbortedError);
});

async function generateBytes(sink: Writable, total: number, onChunk?: (sent: number) => Promise<void> | void): Promise<Buffer> {
  const all: Buffer[] = [];
  for (let sent = 0; sent < total; sent += 64 * 1024) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, total - sent), sent % 251);
    all.push(chunk);
    if (!sink.write(chunk)) await new Promise((resolve) => sink.once('drain', resolve));
    await onChunk?.(sent);
  }
  await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return Buffer.concat(all);
}

test('the file is generated at disk speed and sent at the client\'s pace, byte for byte', async (t) => {
  const dir = scratchDir(t);
  const client = heldClient({ paced: true });
  client.flow(true);
  let generated: Buffer = Buffer.alloc(0);
  let receivedWhenGenerated = -1;
  await flow.spoolReportExport(client.sink, undefined, async (sink) => {
    generated = await generateBytes(sink, 3 * 1024 * 1024 + 123);
    receivedWhenGenerated = client.bytes().length;
  }, { directory: dir });
  client.stop();
  assert.ok(client.bytes().equals(generated));
  assert.ok(client.sink.writableFinished, 'the client stream is ended');
  assert.ok(receivedWhenGenerated < generated.length, 'the generation did not wait for the slow client');
  assert.deepEqual(readdirSync(dir), [], 'the temp file is removed');
});

test('a client that leaves stops the generation and the temp file is removed', async (t) => {
  const dir = scratchDir(t);
  let received = 0;
  const client = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > 200 * 1024) this.destroy();
      callback();
    },
  });
  let generationSignal: AbortSignal | null = null;
  await assert.rejects(flow.spoolReportExport(client, undefined, async (sink, signal) => {
    generationSignal = signal;
    await generateBytes(sink, 50 * 1024 * 1024, async () => {
      await delay(1);
      if (signal.aborted) throw new ReportsSnapshotAbortedError();
    });
  }, { directory: dir }), ReportsSnapshotAbortedError);
  assert.equal(generationSignal!.aborted, true, 'the generation was told to stop');
  assert.deepEqual(readdirSync(dir), []);
});

test('a failed generation keeps its error, leaves the client stream open for the caller, removes the file', async (t) => {
  const dir = scratchDir(t);
  const client = new PassThrough();
  client.resume();
  await assert.rejects(flow.spoolReportExport(client, undefined, async (sink) => {
    sink.write(Buffer.alloc(100 * 1024, 7));
    await delay(20);
    throw new Error('SHEET_QUERY_FAILED');
  }, { directory: dir }), /SHEET_QUERY_FAILED/);
  assert.equal(client.writableEnded, false, 'the controller destroys it (headers may be sent)');
  assert.deepEqual(readdirSync(dir), []);
});

test('only spool files older than the limit are swept', async (t) => {
  const dir = scratchDir(t);
  const old = path.join(dir, '1-old.xlsx.part');
  const fresh = path.join(dir, '2-fresh.xlsx.part');
  const other = path.join(dir, 'keep.txt');
  for (const file of [old, fresh, other]) writeFileSync(file, 'x');
  const past = new Date(Date.now() - flow.REPORT_EXPORT_SPOOL_MAX_AGE_MS - 60_000);
  utimesSync(old, past, past);
  utimesSync(other, past, past);
  assert.equal(await flow.cleanupStaleReportExportSpools({ directory: dir }), 1);
  assert.deepEqual(readdirSync(dir).sort(), ['2-fresh.xlsx.part', 'keep.txt']);
  assert.equal(await flow.cleanupStaleReportExportSpools({ directory: path.join(dir, 'missing') }), 0);
});

// ── The whole export: the same file for a fast and a slow client ──

const learnerRows = Array.from({ length: 12_345 }, (_v, i) => ({
  user_id: `u-${i}`, username: `user${i}`, email: `user${i}@example.test`, full_name: i % 7 ? `Trần Thị ${i}` : null,
  group_names: `Công ty ${i % 3}`, subgroup_names: `Chi nhánh ${i % 5}`, team_names: i % 4 ? `Phòng ${i % 9}` : null,
  enrolled_courses: String(1 + (i % 6)), completed_courses: String(i % 3), incomplete_courses: String(1 + (i % 4)),
  completion_rate: i % 11 ? ((i * 37) % 10_000 / 100).toFixed(2) : null,
  last_completion_at: i % 3 ? new Date(Date.UTC(2026, i % 9, 1 + (i % 27), 3, i % 60)) : null, status: ['completed', 'learning', 'not_started'][i % 3],
}));
const enrollmentRows = Array.from({ length: 7_001 }, (_v, i) => ({
  enrollment_id: `e-${i}`, user_id: `u-${i}`, username: `user${i}`, email: `user${i}@example.test`, full_name: `Lê Văn ${i}`,
  group_names: `Công ty ${i % 3}`, subgroup_names: null, team_names: `Phòng ${i % 9}`, course_id: `c-${i % 12}`, course_name: `Khóa ${i % 12}`,
  enrolled_at: new Date(Date.UTC(2026, i % 9, 2, 1, i % 60)), completed_at: i % 2 ? new Date(Date.UTC(2026, 9, 3)) : null,
  is_completed: i % 2 === 1, progress: String((i * 13) % 100), status: ['completed', 'learning', 'not_started'][i % 3],
}));

function fakeSnapshotClient() {
  const cursors = new Map<string, { rows: unknown[]; offset: number }>();
  const answer = (rows: unknown[]) => ({ rows, rowCount: rows.length });
  return {
    async query(text: string) {
      if (text.includes('pg_backend_pid()')) return answer([{ pid: 4242 }]);
      const declare = /^DECLARE (\w+) NO SCROLL CURSOR FOR /.exec(text);
      if (declare) {
        cursors.set(declare[1], { rows: text.includes('GROUP BY su.user_id') ? learnerRows : enrollmentRows, offset: 0 });
        return answer([]);
      }
      const fetch = /^FETCH FORWARD (\d+) FROM (\w+)/.exec(text);
      if (fetch) {
        const cursor = cursors.get(fetch[2])!;
        const rows = cursor.rows.slice(cursor.offset, cursor.offset + Number(fetch[1]));
        cursor.offset += rows.length;
        await new Promise((resolve) => setImmediate(resolve));
        return answer(rows);
      }
      return answer([]); // BEGIN/COMMIT/CLOSE and the small sheets: no rows
    },
    release() {},
  };
}

test('a report export is the same file for a fast and a slow client', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T03:04:05.000Z') });
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => fakeSnapshotClient());
  const options = {
    tenantId: '11111111-1111-4111-8111-111111111111', year: 2099, scope: {},
    labels: { group: 'Công ty', subgroup: 'Chi nhánh', team: 'Phòng ban' }, exporterName: 'Flow test', locale: 'vi' as const,
  };
  const fast = new PassThrough();
  const fastChunks: Buffer[] = [];
  fast.on('data', (chunk: Buffer) => fastChunks.push(chunk));
  await exportService.streamReportExcel({ ...options, stream: fast });

  const slow = heldClient({ paced: true });
  slow.flow(true);
  await exportService.streamReportExcel({ ...options, stream: slow.sink });
  slow.stop();
  const file = Buffer.concat(fastChunks);
  assert.ok(file.length > 100_000);
  assert.ok(slow.bytes().equals(file), 'byte-identical');
});

test('a report export stops when its client leaves mid-file', async (t) => {
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => fakeSnapshotClient());
  t.mock.method(pg.default.Pool.prototype, 'query', async () => ({ rows: [], rowCount: 0 }));
  let received = 0;
  const client = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > 20_000) this.destroy();
      callback();
    },
  });
  await assert.rejects(exportService.streamReportExcel({
    tenantId: '11111111-1111-4111-8111-111111111111', year: 2099, scope: {},
    labels: { group: 'Công ty', subgroup: 'Chi nhánh', team: 'Phòng ban' }, exporterName: 'Flow test', locale: 'vi', stream: client,
  }), ReportsSnapshotAbortedError);
});
