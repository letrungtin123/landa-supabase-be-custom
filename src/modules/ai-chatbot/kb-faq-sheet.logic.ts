// ═══════════════════════════════════════════════════════════════
// KB FAQ sheet — what an uploaded FAQ workbook says (pure, no I/O)
//
// The workbook is parsed in a worker thread (kb-faq-sheet.worker.ts); only
// this small summary crosses back to the event loop, where stageFaqSource
// turns it into the same answers as before.
// ═══════════════════════════════════════════════════════════════

export type FaqSheetSummary =
  | { kind: 'no_sheet' }
  | { kind: 'empty' }
  | { kind: 'bad_template'; headers: string[] }
  | { kind: 'ok'; rowCount: number; emptyRows: number };

/** `rows` are XLSX.utils.sheet_to_json(<first sheet>) of the workbook. */
export function summarizeFaqSheet(
  sheetName: string | undefined,
  rows: ReadonlyArray<Record<string, unknown>> | null,
): FaqSheetSummary {
  if (!sheetName || rows === null) return { kind: 'no_sheet' };
  if (rows.length === 0) return { kind: 'empty' };
  const headers = Object.keys(rows[0]);
  const qKey = headers.find(h => h.trim().toLowerCase() === 'question');
  const aKey = headers.find(h => h.trim().toLowerCase() === 'answer');
  if (!qKey || !aKey) return { kind: 'bad_template', headers };
  const emptyRows = rows.filter(row => !String(row[qKey] || '').trim() || !String(row[aKey] || '').trim()).length;
  return { kind: 'ok', rowCount: rows.length, emptyRows };
}

export type KbFaqSheetReadErrorCode = 'TOO_LARGE' | 'TOO_COMPLEX';

export const KB_FAQ_SHEET_READ_CODE_PREFIX = 'KB_FAQ_SHEET_';

/** [HTTP status, Vietnamese, English]. */
export const KB_FAQ_SHEET_READ_ERRORS: Record<KbFaqSheetReadErrorCode, readonly [number, string, string]> = {
  TOO_LARGE: [413, 'Tệp FAQ quá lớn để đọc. Vui lòng chọn tệp nhỏ hơn.', 'The FAQ file is too large to read. Choose a smaller file.'],
  TOO_COMPLEX: [
    422,
    'Không đọc được tệp FAQ trong thời gian cho phép. Vui lòng chia tệp thành nhiều tệp nhỏ hơn rồi tải lên lại.',
    'The FAQ file could not be read in the allowed time. Split it into smaller files and upload them again.',
  ],
};

/** The FAQ workbook could not be read within the size, time or memory limit. */
export class KbFaqSheetReadError extends Error {
  constructor(public readonly code: KbFaqSheetReadErrorCode) {
    super(`FAQ sheet read refused: ${code}`);
    this.name = 'KbFaqSheetReadError';
  }
}
