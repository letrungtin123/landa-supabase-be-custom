// HTTP of the AI ID organization context, base /api/ai-chatbot/chat/lesson-author/org-context
// (ORG_CONTEXT_SPEC §3). Mounted after authenticate → tenantContext → checkPermission('courses',
// 'can_edit') → lessonAuthorAuthor, like the AI ID source documents. Parses and bounds the input,
// calls the service, answers `{success, data}` or `{success:false, code, message, request_id, details?}`
// in the request locale (plain words, VI/EN).

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { fixMulterFilename } from '../../../../config/storage.js';
import { getClientIp } from '../../../../middleware/audit-log.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { isUuid } from '../../../../utils/uuid.js';
import {
  TENANT_DATA_LIMIT_REACHED_MESSAGE, TENANT_DATA_LIMIT_REACHED_SQLSTATE, TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../../../tenants/tenant-data-quota.constants.js';
import { AI_CREDIT_LIMIT_REACHED_CODE, AI_CREDIT_LIMIT_REACHED_MESSAGE } from '../../ai-platform/ai-token-quota.service.js';
import { createKbTempUpload, withKbTempUploadCleanup } from '../../kb/kb-upload-storage.js';
import { ALLOWED_KB_EXTENSIONS, MAX_KB_FILE_SIZE } from '../../kb/kb.validator.js';
import type { OrgContextProfileIssueReason } from '../contracts/lesson-author-org-context.contract.js';
import { lessonAuthorRequestLocale } from '../sessions/lesson-author-session-access.logic.js';
import { OrgContextError, type OrgContextErrorCode } from './lesson-author-org-context.logic.js';
import type { OrgContextActor, OrgContextService } from './lesson-author-org-context.service.js';

const MAX_MB = Math.floor(MAX_KB_FILE_SIZE / (1024 * 1024));
/** A raw profile larger than this is refused before it is normalised (the stored one is ≤ 32 KB). */
const RAW_PROFILE_MAX_BYTES = 262_144;

type Message = readonly [string, string];
/** `[HTTP status, Vietnamese, English]` per code; ORG_CONTEXT_FILE_INVALID and _PROFILE_INVALID vary below. */
export const ORG_CONTEXT_ERRORS: Readonly<Record<OrgContextErrorCode | 'TENANT_DATA_QUOTA_RECONCILING',
  readonly [number, string, string]>> = Object.freeze({
  ORG_CONTEXT_DISABLED: [404, 'Tính năng ngữ cảnh doanh nghiệp chưa được bật cho doanh nghiệp của bạn.',
    'Organization context is not turned on for your organization.'],
  ORG_CONTEXT_FILE_INVALID: [400, 'Hãy chọn một tệp tài liệu để tải lên.', 'Choose one document file to upload.'],
  ORG_CONTEXT_LIMIT_REACHED: [409, 'Tài liệu ngữ cảnh đã đạt dung lượng tối đa. Hãy xoá bớt tài liệu rồi thử lại.',
    'The context files have reached their size limit. Delete some files and try again.'],
  ORG_CONTEXT_NOT_DEPLOYED: [409, 'Trợ lý soạn khoá học chưa được bật cho doanh nghiệp của bạn. Vui lòng liên hệ quản trị viên.',
    'The course design assistant is not set up for your organization yet. Please contact your administrator.'],
  ORG_CONTEXT_NOT_READY: [409, 'Trợ lý soạn khoá học chưa sẵn sàng để đọc tài liệu. Vui lòng liên hệ quản trị viên.',
    'The course design assistant is not ready to read documents yet. Please contact your administrator.'],
  ORG_CONTEXT_REVISION_CONFLICT: [409, 'Hồ sơ vừa được người khác cập nhật. Hãy tải lại để xem bản mới.',
    'Someone else just updated the profile. Reload to see the latest version.'],
  ORG_CONTEXT_NO_LEARNED_DOCUMENTS: [409, 'Chưa có tài liệu nào được đọc xong. Hãy chờ tài liệu đọc xong rồi thử lại.',
    'No document has been read yet. Wait until a document is read, then try again.'],
  ORG_CONTEXT_DISTILL_RUNNING: [409, 'AI đang đọc tài liệu để cập nhật hồ sơ. Hãy chờ xong rồi thử lại.',
    'AI is reading the documents to update the profile. Wait until it finishes, then try again.'],
  ORG_CONTEXT_PROFILE_INVALID: [422, 'Hồ sơ gửi lên không đúng mẫu. Hãy tải lại trang rồi thử lại.',
    'The profile sent is not in the expected form. Reload the page and try again.'],
  ORG_CONTEXT_VERSION_NOT_FOUND: [404, 'Không tìm thấy phiên bản hồ sơ này.', 'This profile version was not found.'],
  ORG_CONTEXT_DOCUMENT_NOT_FOUND: [404, 'Không tìm thấy tài liệu này.', 'This document was not found.'],
  ORG_CONTEXT_INPUT_INVALID: [400, 'Yêu cầu không hợp lệ. Hãy tải lại trang rồi thử lại.',
    'The request is not valid. Reload the page and try again.'],
  KB_DOCUMENT_LEARNING: [409, 'Tài liệu đang được đọc nên chưa xoá được. Hãy thử lại khi đọc xong.',
    'The document is still being read and cannot be deleted yet. Try again when it is done.'],
  TENANT_DATA_LIMIT_REACHED: [409, TENANT_DATA_LIMIT_REACHED_MESSAGE,
    'Your organization has used all of its storage. Delete some data or ask your administrator for more space.'],
  TENANT_DATA_QUOTA_RECONCILING: [503, TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
    'The storage use of your organization is being updated. Please try again in a few minutes.'],
  AI_CREDIT_LIMIT_REACHED: [429, AI_CREDIT_LIMIT_REACHED_MESSAGE,
    'This month\'s AI points are used up. Contact your administrator to buy more points.'],
  ORG_CONTEXT_UNAVAILABLE: [503, 'Chưa thực hiện được. Vui lòng thử lại sau ít phút.',
    'This could not be done. Please try again in a few minutes.'],
});

const FILE_MESSAGES: Readonly<Record<'required' | 'type' | 'too_large', Message>> = Object.freeze({
  required: ['Hãy chọn một tệp tài liệu để tải lên.', 'Choose one document file to upload.'],
  type: ['Chỉ hỗ trợ tệp PDF, Word, PowerPoint, văn bản hoặc bảng CSV.',
    'Only PDF, Word, PowerPoint, text or CSV files are supported.'],
  too_large: [`Tệp quá lớn. Vui lòng chọn tệp tối đa ${MAX_MB} MB.`, `The file is too large. Choose a file of up to ${MAX_MB} MB.`],
});

/** ORG_CONTEXT_PROFILE_INVALID per reason; an `empty` profile (path `profile`) cannot be confirmed. */
const PROFILE_MESSAGES: Readonly<Record<OrgContextProfileIssueReason | 'empty_profile', Message>> = Object.freeze({
  too_long: ['Một mục trong hồ sơ dài quá giới hạn. Hãy rút gọn rồi lưu lại.',
    'An entry of the profile is longer than allowed. Shorten it and save again.'],
  too_many: ['Một phần của hồ sơ có quá nhiều mục. Hãy bớt mục rồi lưu lại.',
    'A part of the profile has too many entries. Remove some and save again.'],
  total_too_long: ['Hồ sơ dài quá 6.000 ký tự. Hãy rút gọn rồi lưu lại.',
    'The profile is longer than 6,000 characters. Shorten it and save again.'],
  empty: ['Một mục còn thiếu nội dung. Hãy điền đủ hoặc xoá mục đó.',
    'An entry is missing its text. Fill it in or remove the entry.'],
  empty_profile: ['Hồ sơ đang trống nên chưa xác nhận được. Hãy điền ít nhất một mục.',
    'The profile is empty, so it cannot be confirmed. Fill in at least one part.'],
  shape: ['Hồ sơ gửi lên không đúng mẫu. Hãy tải lại trang rồi thử lại.',
    'The profile sent is not in the expected form. Reload the page and try again.'],
});

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const distillBody = z.object({ expected_revision: revision, locale: z.enum(['vi', 'en']) }).strict();
const profileBody = z.object({ expected_revision: revision, profile: z.unknown(), confirm: z.boolean() }).strict();
const restoreBody = z.object({ expected_revision: revision, version: z.number().int().min(1).max(2_147_483_647) }).strict();
const VERSION_PARAM = /^[1-9][0-9]{0,9}$/;

export interface OrgContextDiagnostic {
  event: 'org_context_request_failed';
  action: string;
  request_id: string;
  tenant_id: string | null;
  error_code: string;
  http_status: number;
  internal_code: string | null;
}

export interface OrgContextHandlerDependencies {
  service: OrgContextService;
  report(record: OrgContextDiagnostic): void;
}

type Handler = (req: Request, res: Response) => Promise<void>;

function localeOf(req: Request): 'vi' | 'en' {
  return lessonAuthorRequestLocale(req.query.ui_locale, req.get('X-UI-Locale'));
}

function actorOf(req: Request): OrgContextActor {
  const user = req.user!;
  return { tenantId: user.tenantId!, userId: user.id, username: user.username, ipAddress: getClientIp(req) };
}

/** The domain code, status and message of any failure (unknown ones are logged as UNAVAILABLE). */
function describe(error: unknown, locale: 'vi' | 'en'): { code: string; status: number; message: string;
  details?: Record<string, unknown>; internal: string | null } {
  const pick = (code: keyof typeof ORG_CONTEXT_ERRORS, message?: Message, details?: Record<string, unknown>) => {
    const [status, vi, en] = ORG_CONTEXT_ERRORS[code];
    const text = message ?? [vi, en] as const;
    return { code, status, message: locale === 'en' ? text[1] : text[0], ...(details ? { details } : {}), internal: null };
  };
  if (error instanceof OrgContextError) {
    if (error.code === 'ORG_CONTEXT_FILE_INVALID') return pick(error.code, FILE_MESSAGES[error.variant ?? 'required']);
    if (error.code === 'ORG_CONTEXT_PROFILE_INVALID') {
      const reason = error.details?.reason as OrgContextProfileIssueReason;
      const key = reason === 'empty' && error.details?.path === 'profile' ? 'empty_profile' : reason;
      return pick(error.code, PROFILE_MESSAGES[key] ?? PROFILE_MESSAGES.shape,
        { path: error.details?.path, reason: error.details?.reason });
    }
    if (error.code === 'ORG_CONTEXT_LIMIT_REACHED') {
      return pick(error.code, undefined, { used_bytes: error.details?.used_bytes, limit_bytes: error.details?.limit_bytes });
    }
    return pick(error.code);
  }
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) return pick('TENANT_DATA_LIMIT_REACHED');
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) return pick('TENANT_DATA_QUOTA_RECONCILING');
  if (code === AI_CREDIT_LIMIT_REACHED_CODE) return pick('AI_CREDIT_LIMIT_REACHED');
  if (code === 'KB_DOCUMENT_LEARNING') return pick('KB_DOCUMENT_LEARNING');
  // A knowledge base being restored, deleted or moved to another AI engine refuses changes for now (409).
  if (error instanceof AppError && error.statusCode === 409 && !error.code) return pick('ORG_CONTEXT_NOT_READY');
  const internal = typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code
    : error instanceof Error ? error.name : 'UNKNOWN';
  return { ...pick('ORG_CONTEXT_UNAVAILABLE'), internal };
}

export function createOrgContextHandlers(deps: OrgContextHandlerDependencies) {
  function handle(action: string, run: (req: Request, res: Response, ok: (status: number, data: unknown) => void) => Promise<void>): Handler {
    return async (req, res) => {
      const requestId = randomUUID();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Request-ID', requestId);
      const ok = (status: number, data: unknown) => { res.status(status).json({ success: true, data, request_id: requestId }); };
      try {
        await run(req, res, ok);
      } catch (error) {
        const failure = describe(error, localeOf(req));
        if (failure.status >= 500) {
          try {
            deps.report({ event: 'org_context_request_failed', action, request_id: requestId,
              tenant_id: req.user?.tenantId ?? null, error_code: failure.code, http_status: failure.status,
              internal_code: failure.internal });
          } catch { /* telemetry never changes the response */ }
        }
        res.status(failure.status).json({ success: false, code: failure.code, message: failure.message,
          request_id: requestId, ...(failure.details ? { details: failure.details } : {}) });
      }
    };
  }

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new OrgContextError('ORG_CONTEXT_INPUT_INVALID');
    return parsed.data;
  };

  return {
    state: handle('state', async (req, _res, ok) => {
      ok(200, await deps.service.getState(req.user!.tenantId!));
    }),

    upload: withKbTempUploadCleanup(handle('upload', async (req, _res, ok) => {
      const file = req.file;
      if (!file || !file.size) throw new OrgContextError('ORG_CONTEXT_FILE_INVALID', undefined, 'required');
      file.originalname = fixMulterFilename(file.originalname);
      const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_KB_EXTENSIONS.includes(ext)) throw new OrgContextError('ORG_CONTEXT_FILE_INVALID', undefined, 'type');
      if (file.size > MAX_KB_FILE_SIZE) throw new OrgContextError('ORG_CONTEXT_FILE_INVALID', undefined, 'too_large');
      ok(201, { document: await deps.service.uploadDocument(actorOf(req), file) });
    })),

    deleteDocument: handle('delete_document', async (req, _res, ok) => {
      const documentId = req.params.documentId;
      if (!isUuid(documentId)) throw new OrgContextError('ORG_CONTEXT_DOCUMENT_NOT_FOUND');
      await deps.service.deleteDocument(actorOf(req), documentId);
      ok(202, { queued: true });
    }),

    distill: handle('distill', async (req, _res, ok) => {
      const body = parse(distillBody, req.body);
      ok(202, await deps.service.requestDistill(actorOf(req), body));
    }),

    saveProfile: handle('save_profile', async (req, _res, ok) => {
      const body = parse(profileBody, req.body);
      if (Buffer.byteLength(JSON.stringify(body.profile ?? null), 'utf8') > RAW_PROFILE_MAX_BYTES) {
        throw new OrgContextError('ORG_CONTEXT_PROFILE_INVALID', { path: 'profile', reason: 'total_too_long' });
      }
      ok(200, await deps.service.saveProfile(actorOf(req), { expected_revision: body.expected_revision,
        profile: body.profile, confirm: body.confirm }));
    }),

    restoreProfile: handle('restore_profile', async (req, _res, ok) => {
      const body = parse(restoreBody, req.body);
      ok(200, await deps.service.restoreProfile(actorOf(req), body));
    }),

    version: handle('read_version', async (req, _res, ok) => {
      const raw = req.params.version;
      if (typeof raw !== 'string' || !VERSION_PARAM.test(raw) || Number(raw) > 2_147_483_647) {
        throw new OrgContextError('ORG_CONTEXT_VERSION_NOT_FOUND');
      }
      ok(200, { version: await deps.service.readVersion(req.user!.tenantId!, Number(raw)) });
    }),
  };
}

// A temp file in the OS temp dir (never the heap), removed when the request ends.
const contextUpload = createKbTempUpload({ files: 1, fileSize: MAX_KB_FILE_SIZE });

/** Multipart `file` (one file ≤ 50 MB); a multipart error answers ORG_CONTEXT_FILE_INVALID in the request locale. */
export const parseOrgContextUpload: RequestHandler = (req, res, next: NextFunction) => {
  contextUpload.single('file')(req, res, (error?: unknown) => {
    if (!error) { next(); return; }
    const variant = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'too_large' : 'required';
    const [vi, en] = FILE_MESSAGES[variant];
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ success: false, code: 'ORG_CONTEXT_FILE_INVALID', message: localeOf(req) === 'en' ? en : vi });
  });
};
