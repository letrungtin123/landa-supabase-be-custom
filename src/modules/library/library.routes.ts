// ═══════════════════════════════════════════════════════════════
// Library Routes — /api/library/*
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { LIBRARY_DOCUMENT_MAX_FILES_PER_UPLOAD, LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES, LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL } from '../../config/upload-limits.js';
import { sendError } from '../../utils/response.js';
import {
  listCategoriesController, createCategoryController, updateCategoryController,
  deleteCategoryController, bulkDeleteCategoriesController,
  listDocumentsController, createDocumentController, updateDocumentController,
  deleteDocumentController, bulkDocumentActionController,
  uploadDocumentController,
} from './library.controller.js';

const router = Router();
const libraryUploadTempDir = path.join(process.cwd(), 'tmp', 'library-documents');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(libraryUploadTempDir, { recursive: true });
      cb(null, libraryUploadTempDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '');
      cb(null, `${Date.now()}-${randomUUID()}${ext || '.upload'}`);
    },
  }),
  limits: {
    fileSize: LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES,
    files: LIBRARY_DOCUMENT_MAX_FILES_PER_UPLOAD,
  },
});

function formatUploadSizeMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function requestUploadSizeLabel(req: Request): string | null {
  const raw = req.headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? formatUploadSizeMb(bytes) : null;
}

function isClientUploadAbort(req: Request, err: unknown): boolean {
  const error = err as { code?: string; message?: string } | undefined;
  return Boolean(
    req.aborted ||
    req.destroyed ||
    error?.message === 'Request aborted' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ECONNABORTED'
  );
}

function uploadedFilesFromRequest(req: Request): Express.Multer.File[] {
  const files = req.files;
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat();
}

async function cleanupMulterTempFiles(req: Request): Promise<void> {
  const files = uploadedFilesFromRequest(req);
  await Promise.all(files.map((file) => file.path ? fs.promises.unlink(file.path).catch(() => {}) : Promise.resolve()));
}

function uploadLibraryDocuments(req: Request, res: Response, next: NextFunction): void {
  upload.array('files', LIBRARY_DOCUMENT_MAX_FILES_PER_UPLOAD)(req, res, (err: unknown) => {
    if (err) void cleanupMulterTempFiles(req);

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      const requestSize = requestUploadSizeLabel(req);
      sendError(
        res,
        `File upload quá giới hạn ${LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL}/file.${requestSize ? ` Dung lượng request hiện tại: ${requestSize}.` : ''}`,
        413,
      );
      return;
    }

    if (err instanceof multer.MulterError && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
      sendError(res, `Tối đa ${LIBRARY_DOCUMENT_MAX_FILES_PER_UPLOAD} file mỗi lần upload.`, 400);
      return;
    }

    if (err && isClientUploadAbort(req, err)) {
      if (!res.headersSent && !res.writableEnded && !req.destroyed) {
        sendError(res, 'Upload đã bị hủy bởi client.', 400);
      }
      return;
    }

    next(err);
  });
}

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

// Categories
router.get('/categories', checkPermission('library', 'can_view'), listCategoriesController);
router.post('/categories', checkPermission('library', 'can_add'), createCategoryController);
router.patch('/categories/:id', checkPermission('library', 'can_edit'), updateCategoryController);
router.delete('/categories/:id', checkPermission('library', 'can_delete'), deleteCategoryController);
router.post('/categories/bulk', checkPermission('library', 'can_delete'), bulkDeleteCategoriesController);

// Documents
router.get('/documents', checkPermission('library', 'can_view'), listDocumentsController);
router.post('/documents', checkPermission('library', 'can_add'), createDocumentController);
router.post('/documents/upload', checkPermission('library', 'can_add'), uploadLibraryDocuments, uploadDocumentController);
router.patch('/documents/:id', checkPermission('library', 'can_edit'), updateDocumentController);
router.delete('/documents/:id', checkPermission('library', 'can_delete'), deleteDocumentController);
router.post('/documents/bulk', checkPermission('library', 'can_delete'), bulkDocumentActionController);

export default router;