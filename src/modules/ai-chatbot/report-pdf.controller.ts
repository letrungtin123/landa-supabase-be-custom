// HTTP handlers of the report PDF export. Input validated with zod; every
// error is mapped through [status, vi, en] in the request locale (X-UI-Locale).
// The PDF locale is body.locale when given, otherwise X-UI-Locale, default vi.
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getClientIp } from '../../middleware/audit-log.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import { normalizeReportPdfLocale, type ReportPdfLocale } from './report-pdf-i18n.js';
import {
  getReportPdfExportError,
  getReportPdfExportService,
  ReportPdfExportError,
  type ReportPdfExportErrorCode,
  type ReportPdfExportApi,
} from './report-pdf-export.service.js';

export const REPORT_PDF_ERRORS: Record<ReportPdfExportErrorCode, readonly [number, string, string]> = {
  REPORT_PDF_PERMISSION_DENIED: [403, 'Bạn không còn quyền xem Báo cáo tổng quan.', 'You no longer have permission to view the Summary report.'],
  REPORT_PDF_SCOPE_DENIED: [403, 'Bạn không còn quyền xuất phạm vi báo cáo này.', 'You are no longer allowed to export this report scope.'],
  REPORT_PDF_NOT_FOUND: [404, 'Không tìm thấy báo cáo để xuất PDF.', 'The report to export was not found.'],
  REPORT_PDF_SNAPSHOT_UNAVAILABLE: [409, 'Dữ liệu báo cáo không còn toàn vẹn nên không thể xuất PDF.', 'The report data failed its integrity check and cannot be exported.'],
  REPORT_PDF_INVALID_REQUEST: [400, 'Yêu cầu xuất PDF không hợp lệ.', 'The PDF export request is invalid.'],
  REPORT_PDF_JOB_NOT_FOUND: [404, 'Không tìm thấy tiến trình xuất báo cáo. Vui lòng xuất lại.', 'The export job was not found. Please export again.'],
  REPORT_PDF_NOT_READY: [409, 'PDF báo cáo chưa sẵn sàng để tải.', 'The report PDF is not ready to download yet.'],
  REPORT_PDF_QUEUE_FULL: [429, 'Hệ thống đang xử lý nhiều báo cáo. Vui lòng thử lại sau.', 'Too many reports are being processed. Please try again later.'],
  REPORT_PDF_RATE_LIMITED: [429, 'Bạn đã xuất nhiều báo cáo trong thời gian ngắn. Vui lòng thử lại sau.', 'You have exported many reports in a short time. Please try again later.'],
  REPORT_PDF_ARTIFACT_TOO_LARGE: [413, 'PDF báo cáo vượt quá dung lượng cho phép.', 'The report PDF exceeds the allowed size.'],
  REPORT_PDF_EXPORT_EXPIRED: [410, 'Tiến trình xuất đã hết hạn. Vui lòng xuất lại.', 'The export job expired. Please export again.'],
  REPORT_PDF_RENDERER_UNAVAILABLE: [503, 'Dịch vụ tạo PDF tạm thời không khả dụng. Vui lòng thử lại sau.', 'The PDF service is temporarily unavailable. Please try again later.'],
  REPORT_PDF_RENDER_TIMEOUT: [504, 'Tạo PDF quá thời gian cho phép. Vui lòng thử lại.', 'Generating the PDF took too long. Please try again.'],
  REPORT_PDF_RENDER_BUSY: [429, 'Dịch vụ tạo PDF đang bận. Vui lòng thử lại sau ít phút.', 'The PDF service is busy. Please try again in a few minutes.'],
  REPORT_PDF_STORAGE_FAILED: [503, 'Không thể lưu PDF báo cáo. Vui lòng thử lại sau.', 'The report PDF could not be stored. Please try again later.'],
  REPORT_PDF_AUDIT_FAILED: [503, 'Không thể ghi nhật ký xuất báo cáo nên chưa thể tải PDF. Vui lòng thử lại.', 'The export could not be recorded in the audit log, so the PDF was not delivered. Please try again.'],
  REPORT_PDF_EXPORT_FAILED: [500, 'Không thể xuất PDF báo cáo.', 'The report PDF could not be exported.'],
  REPORT_PDF_DEMO_SESSION: [403, 'Phiên demo không thể xuất báo cáo.', 'Demo sessions cannot export reports.'],
};

const Uuid = z.string().uuid();
const StartBodySchema = z.object({
  assistant_message_id: Uuid,
  locale: z.enum(['vi', 'en']).optional(),
}).passthrough();
const JobQuerySchema = z.object({ assistant_message_id: Uuid }).passthrough();

type Operation = 'export' | 'start' | 'status' | 'download';

function uiLocale(req: Request): ReportPdfLocale {
  return normalizeReportPdfLocale(req.get('X-UI-Locale')) ?? 'vi';
}

function sendPdf(res: Response, pdf: Buffer, fileName: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Content-Length', String(pdf.byteLength));
  res.setHeader('Cache-Control', 'no-store');
  res.send(pdf);
}

export function createReportPdfHandlers(service: () => ReportPdfExportApi = getReportPdfExportService) {
  function handler(operation: Operation, work: (req: Request, res: Response, context: { requestId: string; actor: { userId: string; tenantId: string; role: NonNullable<Request['user']>['role'] } }) => Promise<void>) {
    return async (req: Request, res: Response): Promise<void> => {
      const started = Date.now();
      const requestId = randomUUID();
      const locale = uiLocale(req);
      res.setHeader('X-Request-ID', requestId);
      res.setHeader('Cache-Control', 'no-store');
      const report = (status: number, code: string | null) => {
        console.info(`[ReportPdf] ${JSON.stringify({ event: 'report_pdf_request', operation, request_id: requestId, tenant_id: req.user?.tenantId ?? null, http_status: status, code, duration_ms: Date.now() - started })}`);
      };
      const reject = (error: ReportPdfExportError) => {
        const [status, vi, en] = REPORT_PDF_ERRORS[error.code] ?? REPORT_PDF_ERRORS.REPORT_PDF_EXPORT_FAILED;
        if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
        report(status, error.code);
        res.status(status).json({ success: false, code: error.code, message: locale === 'en' ? en : vi, request_id: requestId });
      };
      const user = req.user;
      if (!user?.tenantId) { reject(new ReportPdfExportError('Missing tenant', 403, 'REPORT_PDF_PERMISSION_DENIED')); return; }
      if (isDemoIframeSession(user)) { reject(new ReportPdfExportError('Demo session', 403, 'REPORT_PDF_DEMO_SESSION')); return; }
      if (!Uuid.safeParse(req.params.id).success || (req.params.jobId !== undefined && !Uuid.safeParse(req.params.jobId).success)) {
        reject(new ReportPdfExportError('Invalid ids', 400, 'REPORT_PDF_INVALID_REQUEST'));
        return;
      }
      try {
        await work(req, res, { requestId, actor: { userId: user.id, tenantId: user.tenantId, role: user.role } });
        report(res.statusCode, null);
      } catch (error) {
        reject(getReportPdfExportError(error));
      }
    };
  }

  const parseStart = (req: Request) => {
    const body = StartBodySchema.safeParse(req.body ?? {});
    if (!body.success) throw new ReportPdfExportError('Invalid body', 400, 'REPORT_PDF_INVALID_REQUEST');
    return { assistantMessageId: body.data.assistant_message_id, locale: body.data.locale ?? uiLocale(req) };
  };
  const parseJob = (req: Request) => {
    const query = JobQuerySchema.safeParse(req.query);
    if (!query.success) throw new ReportPdfExportError('Invalid query', 400, 'REPORT_PDF_INVALID_REQUEST');
    return { assistantMessageId: query.data.assistant_message_id, jobId: req.params.jobId };
  };
  const auditContext = (req: Request, requestId: string) => ({ requestId, ipAddress: getClientIp(req), username: req.user?.username });

  return {
    exportReportPdf: handler('export', async (req, res, { requestId, actor }) => {
      const input = parseStart(req);
      const result = await service().exportNow({ ...actor, conversationId: req.params.id, ...input, audit: auditContext(req, requestId) });
      sendPdf(res, result.pdf, result.fileName);
    }),
    startReportPdfJob: handler('start', async (req, res, { requestId, actor }) => {
      const input = parseStart(req);
      const job = await service().start({ ...actor, conversationId: req.params.id, ...input });
      res.status(202).json({ success: true, data: job, request_id: requestId });
    }),
    getReportPdfJob: handler('status', async (req, res, { requestId, actor }) => {
      const input = parseJob(req);
      const job = await service().get({ ...actor, conversationId: req.params.id, ...input });
      res.status(200).json({ success: true, data: job, request_id: requestId });
    }),
    downloadReportPdfJob: handler('download', async (req, res, { requestId, actor }) => {
      const input = parseJob(req);
      const result = await service().download({ ...actor, conversationId: req.params.id, ...input, audit: auditContext(req, requestId) });
      sendPdf(res, result.pdf, result.fileName);
    }),
  };
}

export const reportPdfHandlers = createReportPdfHandlers();
