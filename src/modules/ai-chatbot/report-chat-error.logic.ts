// Errors of the admin report chat path. They are typed AppErrors with a
// localized message, so the generic chat error handling neither rewrites them
// into "Yêu cầu không hợp lệ" nor mistakes a report 403 for a Gemini File
// Search permission failure (which used to mark the bot KB store broken).

import { AppError } from '../../middleware/error-handler.js';
import { isGeminiPermissionDeniedError } from './gemini.service.js';

export const REPORT_FILTERS_INVALID_CODE = 'REPORT_FILTERS_INVALID';
export const REPORT_FILTER_DATE_INVALID_CODE = 'REPORT_FILTER_DATE_INVALID';
export const REPORT_FILTER_RANGE_INCOMPLETE_CODE = 'REPORT_FILTER_RANGE_INCOMPLETE';
export const REPORT_FILTER_RANGE_REVERSED_CODE = 'REPORT_FILTER_RANGE_REVERSED';
export const REPORT_FILTER_RANGE_TOO_LONG_CODE = 'REPORT_FILTER_RANGE_TOO_LONG';
export const REPORT_FILTER_UNIT_INVALID_CODE = 'REPORT_FILTER_UNIT_INVALID';
export const REPORT_PERMISSION_CHECK_FAILED_CODE = 'REPORT_PERMISSION_CHECK_FAILED';
export const REPORT_DATA_UNAVAILABLE_CODE = 'REPORT_DATA_UNAVAILABLE';

export type ReportChatErrorCode =
  | typeof REPORT_FILTERS_INVALID_CODE
  | typeof REPORT_FILTER_DATE_INVALID_CODE
  | typeof REPORT_FILTER_RANGE_INCOMPLETE_CODE
  | typeof REPORT_FILTER_RANGE_REVERSED_CODE
  | typeof REPORT_FILTER_RANGE_TOO_LONG_CODE
  | typeof REPORT_FILTER_UNIT_INVALID_CODE
  | typeof REPORT_PERMISSION_CHECK_FAILED_CODE
  | typeof REPORT_DATA_UNAVAILABLE_CODE;

export const REPORT_CHAT_ERRORS: Record<ReportChatErrorCode, readonly [status: number, vi: string, en: string]> = {
  REPORT_FILTERS_INVALID: [400, 'Bộ lọc báo cáo không hợp lệ.', 'The report filters are invalid.'],
  REPORT_FILTER_DATE_INVALID: [400, 'Ngày trong bộ lọc báo cáo không hợp lệ.', 'A date in the report filters is invalid.'],
  REPORT_FILTER_RANGE_INCOMPLETE: [400, 'Hãy chọn cả ngày bắt đầu và ngày kết thúc.', 'Choose both a start date and an end date.'],
  REPORT_FILTER_RANGE_REVERSED: [400, 'Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.', 'The start date must be on or before the end date.'],
  REPORT_FILTER_RANGE_TOO_LONG: [400, 'Khoảng thời gian báo cáo tối đa là 366 ngày.', 'A report period can be at most 366 days.'],
  REPORT_FILTER_UNIT_INVALID: [400, 'Đơn vị trong bộ lọc báo cáo không hợp lệ.', 'A unit in the report filters is invalid.'],
  REPORT_PERMISSION_CHECK_FAILED: [500, 'Chưa thể kiểm tra quyền xem báo cáo. Vui lòng thử lại.', 'Your report access could not be checked. Please try again.'],
  REPORT_DATA_UNAVAILABLE: [503, 'Chưa thể tải số liệu báo cáo lúc này. Vui lòng thử lại sau.', 'Report data is not available right now. Please try again later.'],
};

export class ReportChatError extends AppError {
  constructor(public readonly reportCode: ReportChatErrorCode, locale: 'vi' | 'en') {
    const [status, vi, en] = REPORT_CHAT_ERRORS[reportCode];
    super(locale === 'en' ? en : vi, status, reportCode);
    this.name = 'ReportChatError';
  }
}

export function isReportChatError(error: unknown): error is ReportChatError {
  return error instanceof ReportChatError;
}

export function reportChatErrorBody(code: ReportChatErrorCode, locale: 'vi' | 'en'): { status: number; body: { success: false; message: string; code: ReportChatErrorCode } } {
  const [status, vi, en] = REPORT_CHAT_ERRORS[code];
  return { status, body: { success: false, message: locale === 'en' ? en : vi, code } };
}

/** Codes attached to the plain `{ status, message, code }` objects thrown by the report scope/date helpers. */
export type ReportDomainErrorCode =
  | 'REPORT_SCOPE_FORBIDDEN'
  | 'REPORT_SCOPE_REQUIRED'
  | 'REPORT_SCOPE_INVALID'
  | 'REPORT_RANGE_INVALID';

const REPORT_DOMAIN_ERROR_CODES: readonly ReportDomainErrorCode[] = [
  'REPORT_SCOPE_FORBIDDEN',
  'REPORT_SCOPE_REQUIRED',
  'REPORT_SCOPE_INVALID',
  'REPORT_RANGE_INVALID',
];

function isReportDomainErrorCode(value: unknown): value is ReportDomainErrorCode {
  return REPORT_DOMAIN_ERROR_CODES.some((code) => code === value);
}

export function readReportDomainErrorCode(error: unknown): ReportDomainErrorCode | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return isReportDomainErrorCode(code) ? code : null;
}

/**
 * Only a Gemini PERMISSION_DENIED raised by the File Search chat path may mark
 * the bot KB store as broken. Report errors (including report 403s) never do.
 */
export function isKbStorePermissionFailure(error: unknown): boolean {
  return !isReportChatError(error)
    && readReportDomainErrorCode(error) === null
    && isGeminiPermissionDeniedError(error);
}
