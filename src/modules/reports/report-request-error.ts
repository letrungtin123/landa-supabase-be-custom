import { AppError } from '../../middleware/error-handler.js';

/**
 * A report request the caller can correct: a scope outside the tenant or the
 * actor's groups (report-access.service.ts), a date range, a stored report
 * snapshot that is missing or altered (report-chat.service.ts).
 *
 * An AppError, so the Reports routes answer its status, message and code.
 * These errors used to be thrown as plain `{ status, message, code }` objects
 * and keep those three fields (`status` equals `statusCode`); the readers keep
 * their behavior: report chat reads `code` (readReportDomainErrorCode), and
 * the PDF export maps the status as before (getReportPdfExportError, where 409
 * is an altered snapshot).
 */
export class ReportRequestError extends AppError {
  /** The HTTP status under the name the plain objects used. */
  readonly status: number;

  constructor(message: string, statusCode: number, code?: string) {
    super(message, statusCode, code);
    this.name = 'ReportRequestError';
    this.status = statusCode;
  }
}
