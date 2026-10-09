// ═══════════════════════════════════════════════════════════════
// AI course design source upload — course data permission, not KB admin
//
// POST /api/ai-chatbot/chat/lesson-author/source-documents (multipart `file`)
// Route chain: authenticate → tenantContext → checkPermission('courses','can_edit').
// The knowledge base is NEVER taken from the request: the server resolves the
// tenant's active lesson-author bot + KB assignment (the deployed feature) and
// uploads exactly one file into it, through the same staging/queue/audit path
// as the KB management upload. KB management routes keep ai_chatbot rights.
// ═══════════════════════════════════════════════════════════════

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { fixMulterFilename } from '../../config/storage.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { getActiveBot, getActiveKbAssignmentFresh } from './chat.service.js';
import { getGeminiApiKey } from './gemini.service.js';
import * as kbService from './kb.service.js';
import { ALLOWED_KB_EXTENSIONS, MAX_KB_FILE_SIZE } from './kb.validator.js';
import { lessonAuthorRequestLocale } from './lesson-author-session-access.logic.js';

const MAX_MB = Math.floor(MAX_KB_FILE_SIZE / (1024 * 1024));

/** [HTTP status, Vietnamese, English]; public code LESSON_AUTHOR_SOURCE_UPLOAD_<CODE>. */
export const LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS = {
  FILE_REQUIRED: [400, 'Hãy chọn một tệp tài liệu để tải lên.', 'Choose one document file to upload.'],
  FILE_TYPE_UNSUPPORTED: [400, 'Chỉ hỗ trợ tệp PDF, Word, PowerPoint, văn bản hoặc bảng CSV.',
    'Only PDF, Word, PowerPoint, text or CSV files are supported.'],
  FILE_TOO_LARGE: [413, `Tệp quá lớn. Vui lòng chọn tệp tối đa ${MAX_MB} MB.`, `The file is too large. Choose a file of up to ${MAX_MB} MB.`],
  NOT_DEPLOYED: [409, 'Trợ lý soạn khoá học chưa được bật cho doanh nghiệp của bạn. Vui lòng liên hệ quản trị viên.',
    'The course design assistant is not set up for your organization yet. Please contact your administrator.'],
  NOT_READY: [409, 'Trợ lý soạn khoá học chưa sẵn sàng để đọc tài liệu. Vui lòng liên hệ quản trị viên.',
    'The course design assistant is not ready to read documents yet. Please contact your administrator.'],
  FAILED: [503, 'Chưa tải được tài liệu lên. Vui lòng thử lại sau ít phút.',
    'The document could not be uploaded. Please try again in a few minutes.'],
} as const satisfies Record<string, readonly [number, string, string]>;
type UploadErrorCode = keyof typeof LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS;
export const LESSON_AUTHOR_SOURCE_UPLOAD_CODE_PREFIX = 'LESSON_AUTHOR_SOURCE_UPLOAD_';

function refuse(req: Request, res: Response, code: UploadErrorCode): void {
  const [status, vi, en] = LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS[code];
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ success: false, code: `${LESSON_AUTHOR_SOURCE_UPLOAD_CODE_PREFIX}${code}`,
    message: lessonAuthorRequestLocale(req.query.ui_locale, req.get('X-UI-Locale')) === 'en' ? en : vi });
}

const sourceUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: MAX_KB_FILE_SIZE } });

/** Multipart errors answer in the request locale instead of a generic 500. */
export const parseLessonAuthorSourceUpload: RequestHandler = (req, res, next: NextFunction) => {
  sourceUpload.single('file')(req, res, (error?: unknown) => {
    if (!error) { next(); return; }
    refuse(req, res, error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'FILE_REQUIRED');
  });
};

export async function uploadLessonAuthorSourceDocument(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const file = req.file;
  if (!file || !file.size) { refuse(req, res, 'FILE_REQUIRED'); return; }
  file.originalname = fixMulterFilename(file.originalname);
  const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_KB_EXTENSIONS.includes(ext)) { refuse(req, res, 'FILE_TYPE_UNSUPPORTED'); return; }
  if (file.size > MAX_KB_FILE_SIZE) { refuse(req, res, 'FILE_TOO_LARGE'); return; }

  const [bot, assignment] = await Promise.all([getActiveBot(tenantId, 'lesson_author'), getActiveKbAssignmentFresh(tenantId)]);
  const kb = assignment ? await kbService.getKnowledgebase(assignment.kb_id, tenantId) : null;
  if (!bot || !assignment || !kb) { refuse(req, res, 'NOT_DEPLOYED'); return; }
  try { await getGeminiApiKey(tenantId); } catch { refuse(req, res, 'NOT_READY'); return; }

  let staged: kbService.StagedKbSource | null = null;
  try {
    staged = await kbService.stageDocumentSource(kb.id, tenantId, file);
    const doc = await runAuditedTransaction(
      () => kbService.createQueuedDocumentFromStagedSource(kb.id, tenantId, req.user!.id, staged!),
      created => createTransactionalAuditEntry(req, 'CREATE', 'kb_document', { code: 'knowledgebase.document.created',
        context: { parent_name: kb.name, file_name: created.name, file_size_bytes: file.size } }, created.id, created.name),
    );
    // Same receipt shape as the KB upload so the browser keeps one parser.
    res.status(201).json({ success: true, data: { results: [{ file: file.originalname, success: true, data: doc }], uploaded: 1, failed: 0 } });
  } catch (error) {
    await kbService.discardStagedKbSource(staged);
    console.warn('[LessonAuthorSourceUpload] upload rejected', JSON.stringify({ event: 'lesson_author_source_upload_failed',
      tenant_id: tenantId, kb_id: kb.id, source_size_bytes: file.size,
      error_code: error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null }));
    refuse(req, res, 'FAILED');
  }
}
