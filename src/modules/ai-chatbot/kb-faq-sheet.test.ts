import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as XLSX from 'xlsx';

// M6/T: an uploaded FAQ workbook is parsed in a worker thread with a size,
// time and memory limit; the answer is the one the former main-thread
// parse gave (same summary, same parse errors). No network, no database.

const { readFaqSheetSummary } = await import('./kb-faq-sheet.service.js');
const { KbFaqSheetReadError, KB_FAQ_SHEET_READ_ERRORS, summarizeFaqSheet } = await import('./kb-faq-sheet.logic.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'landa-faq-sheet-test-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let index = 0;

function writeWorkbook(rows: unknown[][]): string {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'FAQs');
  const file = path.join(dir, `faq-${index += 1}.xlsx`);
  writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}

function writeBytes(bytes: Buffer, ext = '.xlsx'): string {
  const file = path.join(dir, `raw-${index += 1}${ext}`);
  writeFileSync(file, bytes);
  return file;
}

/** The former stageFaqSource parse, verbatim, as the reference. */
function formerParse(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { error: 'File xlsx không có sheet nào' };
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);
  if (rows.length === 0) return { error: 'File xlsx trống, không có dữ liệu' };
  const headers = Object.keys(rows[0]);
  const qKey = headers.find(h => h.trim().toLowerCase() === 'question');
  const aKey = headers.find(h => h.trim().toLowerCase() === 'answer');
  if (!qKey || !aKey) return { error: `Cột hiện tại: ${headers.join(', ')}` };
  const emptyRows = rows.filter(row => !String(row[qKey] || '').trim() || !String(row[aKey] || '').trim()).length;
  return { rowCount: rows.length, emptyRows };
}

function asFormer(summary: Awaited<ReturnType<typeof readFaqSheetSummary>>) {
  if (summary.kind === 'no_sheet') return { error: 'File xlsx không có sheet nào' };
  if (summary.kind === 'empty') return { error: 'File xlsx trống, không có dữ liệu' };
  if (summary.kind === 'bad_template') return { error: `Cột hiện tại: ${summary.headers.join(', ')}` };
  return { rowCount: summary.rowCount, emptyRows: summary.emptyRows };
}

test('the worker gives the former answer for valid, partly empty, mis-labelled and empty sheets', async () => {
  const files = [
    writeWorkbook([['Question', 'Answer'], ['Giờ làm việc?', '8:00 - 17:00'], ['Nghỉ phép?', 'Xem quy định']]),
    writeWorkbook([[' question ', 'ANSWER '], ['Q1', ''], ['', 'A2'], ['Q3', 'A3'], [0, 1]]),
    writeWorkbook([['Câu hỏi', 'Trả lời'], ['Q', 'A']]),
    writeWorkbook([['Question', 'Answer']]),
    writeWorkbook([]),
    writeBytes(Buffer.from('Question,Answer\nQ,A\n'), '.xls'),
  ];
  for (const file of files) {
    assert.deepEqual(asFormer(await readFaqSheetSummary(file)), formerParse(readFileSync(file)), path.basename(file));
  }
});

test('a workbook the parser rejects fails with the same parser message', async () => {
  const corrupt = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 7)]);
  let former: string | null = null;
  try { formerParse(corrupt); } catch (error) { former = (error as Error).message; }
  const file = writeBytes(corrupt);
  if (former === null) {
    assert.deepEqual(asFormer(await readFaqSheetSummary(file)), formerParse(corrupt));
  } else {
    await assert.rejects(readFaqSheetSummary(file), (error: Error) => {
      assert.equal(error.message, former);
      assert.equal(error instanceof KbFaqSheetReadError, false, 'still an ordinary error (generic answer, as before)');
      return true;
    });
  }
});

test('a file over the size limit is refused before any parse', async () => {
  const file = writeWorkbook([['Question', 'Answer'], ['Q', 'A']]);
  await assert.rejects(readFaqSheetSummary(file, { maxBytes: 10 }), (error: unknown) =>
    error instanceof KbFaqSheetReadError && error.code === 'TOO_LARGE');
});

test('a parse past its deadline or its memory limit is stopped and refused', async () => {
  const file = writeWorkbook([['Question', 'Answer'], ['Q', 'A']]);
  const hanging = new URL('data:text/javascript,setInterval(() => {}, 1000);');
  const startedAt = Date.now();
  await assert.rejects(readFaqSheetSummary(file, { workerUrl: hanging, timeoutMs: 200 }), (error: unknown) =>
    error instanceof KbFaqSheetReadError && error.code === 'TOO_COMPLEX');
  assert.ok(Date.now() - startedAt < 5_000);

  const greedy = new URL('data:text/javascript,const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));');
  await assert.rejects(readFaqSheetSummary(file, { workerUrl: greedy, timeoutMs: 30_000, maxMemoryMb: 64 }), (error: unknown) =>
    error instanceof KbFaqSheetReadError && error.code === 'TOO_COMPLEX');
});

test('the event loop keeps running while a large workbook is parsed', async () => {
  const rows: unknown[][] = [['Question', 'Answer']];
  for (let i = 0; i < 40_000; i += 1) rows.push([`Question number ${i} about the company policy`, `Answer ${i} `.repeat(4)]);
  const file = writeWorkbook(rows);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const startedAt = Date.now();
  try {
    const summary = await readFaqSheetSummary(file, { maxBytes: 50 * 1024 * 1024 });
    assert.deepEqual(summary, { kind: 'ok', rowCount: 40_000, emptyRows: 0 });
  } finally {
    clearInterval(timer);
  }
  const elapsed = Date.now() - startedAt;
  // On the main thread the parse would have blocked every tick until it ended.
  assert.ok(ticks >= Math.min(10, Math.floor(elapsed / 50)), `ticks=${ticks} elapsed=${elapsed}ms`);
});

test('summary of a workbook without sheets, and plain bilingual refusal messages', () => {
  assert.deepEqual(summarizeFaqSheet(undefined, null), { kind: 'no_sheet' });
  for (const [status, vi, en] of Object.values(KB_FAQ_SHEET_READ_ERRORS)) {
    assert.ok(status >= 400 && status < 500);
    for (const message of [vi, en]) assert.doesNotMatch(message, /[A-Z]{2,}_[A-Z]/, 'no codes in the message');
  }
});
