// Assignment files: upload limits, storing attachments and submission files,
// their rows, and opening a file for download. Moved unchanged from
// assignments.service.ts, which re-exports the exported names.

import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  buildFileName,
  buildStoragePath,
  deleteFile,
  fixMulterFilename,
  openStorageObjectStream,
  uploadCourseAssetFileFromPath,
  uploadFile,
  type StorageObjectStream,
} from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { isLearnerRole } from '../../types/index.js';
import type { AuthUser } from '../../types/express.js';
import type { AssignmentFileMeta } from './assignments.types.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import { createAssignmentsRepository } from './assignments.repository.js';
import { learnerRepository, hasCoursePermission } from './assignment-access.service.js';
import { fileDownloadUrl, normalizeFiles } from './assignment-rules.logic.js';

const MAX_ASSIGNMENT_FILES = 5;
const MAX_ASSIGNMENT_FILE_SIZE_BYTES = 25 * 1024 * 1024;

interface UploadedAssignmentFile extends AssignmentFileMeta {
  storage_path: string;
}

interface StoredAssignmentAttachment extends UploadedAssignmentFile {
  created_at?: string;
}

export interface AssignmentFileUploaders {
  fromPath: (storagePath: string, filePath: string, contentType: string) => Promise<unknown>;
  fromBuffer: (storagePath: string, buffer: Buffer, contentType: string) => Promise<unknown>;
}

const defaultAssignmentFileUploaders: AssignmentFileUploaders = {
  fromPath: uploadCourseAssetFileFromPath,
  fromBuffer: uploadFile,
};

/**
 * Learner submissions arrive as temp files (assignments.routes.ts) and are
 * streamed to Storage, so a submission deadline does not hold every file in
 * the heap; admin uploads still arrive in memory. An empty file has nothing
 * to stream and keeps the buffer upload.
 */
export async function storeAssignmentFile(
  storagePath: string,
  file: Pick<Express.Multer.File, 'path' | 'buffer' | 'size' | 'mimetype'>,
  uploaders: AssignmentFileUploaders = defaultAssignmentFileUploaders,
): Promise<void> {
  const contentType = file.mimetype || 'application/octet-stream';
  if (file.path && file.size > 0) {
    await uploaders.fromPath(storagePath, file.path, contentType);
    return;
  }
  await uploaders.fromBuffer(storagePath, file.buffer ?? Buffer.alloc(0), contentType);
}

export async function uploadAssignmentFiles(
  files: Express.Multer.File[] | undefined,
  tenantId: string,
  courseId: string,
  assignmentId: string,
  submissionId: string,
  uploadedBy: string,
  kind: 'submission' | 'feedback',
): Promise<UploadedAssignmentFile[]> {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_ASSIGNMENT_FILES) {
    throw new AppError(`Chi duoc upload toi da ${MAX_ASSIGNMENT_FILES} files`, 400);
  }

  const uploaded: UploadedAssignmentFile[] = [];
  try {
    for (const file of files) {
      const id = uuidv4();
      const originalName = fixMulterFilename(file.originalname);
      const storageName = `${id}_${buildFileName(originalName)}`;
      const storagePath = buildStoragePath(
        tenantId,
        'assignments',
        storageName,
        `${courseId}/${assignmentId}/${submissionId}/${kind}/${uploadedBy}`,
      );
      await storeAssignmentFile(storagePath, file);
      uploaded.push({
        id,
        original_name: originalName,
        mime_type: file.mimetype || 'application/octet-stream',
        size_bytes: file.size,
        storage_path: storagePath,
        download_url: fileDownloadUrl(id),
      });
    }
    return uploaded;
  } catch (err) {
    await Promise.all(uploaded.map(file => deleteFile(file.storage_path).catch(swallowAndLog('assignments.storage_cleanup'))));
    throw err;
  }
}

export async function uploadAssignmentAttachment(
  file: Express.Multer.File | undefined,
  tenantId: string,
  courseId: string,
  assignmentId: string,
): Promise<StoredAssignmentAttachment | null> {
  if (!file) return null;
  if (file.size > MAX_ASSIGNMENT_FILE_SIZE_BYTES) {
    throw new AppError('File đính kèm không được vượt quá 25MB', 400);
  }

  const id = uuidv4();
  const originalName = fixMulterFilename(file.originalname);
  const storageName = `${id}_${buildFileName(originalName)}`;
  const storagePath = buildStoragePath(
    tenantId,
    'assignments',
    storageName,
    // Assignment attachments belong to the course, not to the staff member
    // who uploaded them. Do not embed a deletable user ID in a long-lived
    // course asset path.
    `${courseId}/${assignmentId}/attachment`,
  );
  await uploadFile(storagePath, file.buffer, file.mimetype || 'application/octet-stream');
  return {
    id,
    original_name: originalName,
    mime_type: file.mimetype || 'application/octet-stream',
    size_bytes: file.size,
    storage_path: storagePath,
    download_url: fileDownloadUrl(id),
    created_at: new Date().toISOString(),
  };
}

export async function insertAssignmentFileRows(
  client: PoolClient,
  tenantId: string,
  courseId: string,
  assignmentId: string,
  submissionId: string,
  uploadedBy: string,
  kind: 'submission' | 'feedback',
  files: UploadedAssignmentFile[],
): Promise<void> {
  await createAssignmentsRepository(client).insertAssignmentFiles(
    tenantId,
    courseId,
    assignmentId,
    submissionId,
    uploadedBy,
    kind,
    files,
  );
}

export interface AssignmentFileDownload {
  body: StorageObjectStream['body'];
  contentLength: number | null;
  contentType: string;
  originalName: string;
}

export interface AssignmentFileDownloadOptions {
  /** Aborts the Storage request (the controller ties it to the client connection). */
  signal?: AbortSignal;
  openObject?: typeof openStorageObjectStream;
}

async function openAssignmentFile(
  storagePath: string,
  mimeType: string | null,
  originalName: string,
  options: AssignmentFileDownloadOptions,
): Promise<AssignmentFileDownload> {
  const opened = await (options.openObject ?? openStorageObjectStream)(storagePath, { signal: options.signal });
  return {
    body: opened.body,
    contentLength: opened.contentLength,
    contentType: mimeType || opened.contentType || 'application/octet-stream',
    originalName,
  };
}

/**
 * An assignment attachment or submission/feedback file, after the access
 * check, as a stream from Storage: a download is never held whole in the
 * heap (many learners download at a deadline).
 */
export async function getAssignmentFileForDownload(
  fileId: string,
  user: AuthUser,
  options: AssignmentFileDownloadOptions = {},
): Promise<AssignmentFileDownload> {
  const attachment = await learnerRepository.selectAttachmentDownload(fileId);

  if (attachment) {
    const file = attachment;
    const sameTenant = user.role === 'superadmin' || user.tenantId === file.tenant_id;
    const isAdmin = sameTenant && await hasCoursePermission(user);
    let learnerAllowed = false;

    if (sameTenant && user.tenantId && isLearnerRole(user.role)) {
      learnerAllowed = await learnerRepository.learnerCanOpenCourse(file.course_id, user.tenantId, user.id);
    }

    if ((!isAdmin && !learnerAllowed) || !sameTenant || !file.storage_path) {
      throw new AppError('Khong co quyen tai file nay', 403);
    }

    return openAssignmentFile(file.storage_path, file.mime_type, file.original_name || 'file', options);
  }

  const file = await learnerRepository.selectAssignmentFileDownload(fileId);
  if (!file) throw new AppError('File khong ton tai', 404);

  const sameTenant = user.role === 'superadmin' || user.tenantId === file.tenant_id;
  const isAdmin = sameTenant && await hasCoursePermission(user);
  const currentFeedbackFileIds = new Set(normalizeFiles(file.feedback_files).map(item => item.id));
  const learnerAllowed = file.learner_id === user.id && (
    (file.kind === 'submission' && file.uploaded_by === user.id)
    || (file.kind === 'feedback' && currentFeedbackFileIds.has(file.id))
  );
  if ((!isAdmin && !learnerAllowed) || !sameTenant) {
    throw new AppError('Khong co quyen tai file nay', 403);
  }

  return openAssignmentFile(file.storage_path, file.mime_type, file.original_name, options);
}
