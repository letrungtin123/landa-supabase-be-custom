// ═══════════════════════════════════════════════════════════════
// Knowledge Base uploads on disk
//
// KB documents (up to 20 files of 50 MB per request), FAQ sheets and the
// AI course design source document arrive as temp files in the OS temp dir
// instead of the heap; staging streams them to Storage from there. The
// handlers remove the temp files when the request ends (withKbTempUploadCleanup).
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import multer from 'multer';
import { removeTempUploadFiles } from '../../../utils/temp-upload-files.js';
import { MAX_KB_FILE_SIZE } from './kb.validator.js';

export const KB_UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'landa-kb-uploads');

const kbTempFileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdir(KB_UPLOAD_TEMP_DIR, { recursive: true }, (error) => cb(error ?? null, KB_UPLOAD_TEMP_DIR));
  },
  filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomUUID()}.upload`),
});

/** Same per-file limit as the former memory upload (50 MB). */
export function createKbTempUpload(limits: multer.Options['limits'] = {}): multer.Multer {
  return multer({ storage: kbTempFileStorage, limits: { fileSize: MAX_KB_FILE_SIZE, ...limits } });
}

export function kbTempUploadsOf(req: Request): Express.Multer.File[] {
  const files = Array.isArray(req.files) ? req.files : [];
  return req.file ? [...files, req.file] : files;
}

export async function removeKbTempUploads(req: Request): Promise<void> {
  await removeTempUploadFiles(kbTempUploadsOf(req), 'KnowledgeBase');
}

/** Runs the handler, then removes the request's temp upload files, whatever happened. */
export function withKbTempUploadCleanup(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async function handleKbUpload(req, res) {
    try {
      await handler(req, res);
    } finally {
      await removeKbTempUploads(req);
    }
  };
}
