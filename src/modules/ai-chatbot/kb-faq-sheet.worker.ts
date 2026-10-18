// ═══════════════════════════════════════════════════════════════
// KB FAQ sheet worker — parses one uploaded workbook off the event loop
//
// Started per upload by kb-faq-sheet.service.ts with the temp file path; it
// posts one message ({ ok, summary } or { ok: false, message }) and exits.
// A parse error is sent back with its message, so the request fails exactly
// as it did when the workbook was parsed on the main thread.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import { summarizeFaqSheet } from './kb-faq-sheet.logic.js';

const { filePath } = workerData as { filePath: string };

try {
  const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const rows = sheetName ? XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]) : null;
  parentPort!.postMessage({ ok: true, summary: summarizeFaqSheet(sheetName, rows) });
} catch (error) {
  parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
