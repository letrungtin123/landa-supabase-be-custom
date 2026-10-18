// ═══════════════════════════════════════════════════════════════
// Bot avatar upload — multipart parsing bounded by the real 5 MB limit
//
// The avatar was read into memory with a 50 MB multer limit although only
// 5 MB is accepted, so up to 50 MB per request sat in the heap before the
// handler refused it. Multer now stops reading at the avatar limit, and a
// file over it gets the answer the handler always gave ("File ảnh tối đa
// 5MB", or the type message first when the type is not an image).
// ═══════════════════════════════════════════════════════════════

import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { isUuid } from '../../../utils/uuid.js';
import { sendError } from '../../../utils/response.js';

export const BOT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const BOT_AVATAR_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const BOT_NOT_FOUND_MESSAGE = 'Bot không tồn tại';
export const BOT_AVATAR_TYPE_MESSAGE = 'Chỉ hỗ trợ JPEG, PNG, WebP, GIF';
export const BOT_AVATAR_SIZE_MESSAGE = 'File ảnh tối đa 5MB';

/** The refusal for an avatar file, in the handler's order (type, then size), or null when it is accepted. */
export function botAvatarFileError(file: { mimetype: string; size: number }): string | null {
  if (!BOT_AVATAR_MIME_TYPES.includes(file.mimetype)) return BOT_AVATAR_TYPE_MESSAGE;
  if (file.size > BOT_AVATAR_MAX_BYTES) return BOT_AVATAR_SIZE_MESSAGE;
  return null;
}

// The type of the file multer was reading when it hit the limit (a refused
// upload has no req.file).
const announcedMimeTypes = new WeakMap<Request, string>();

// busboy reports the limit as soon as a file reaches it, so the limit is one
// byte above the largest accepted file: exactly 5 MB is still accepted.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BOT_AVATAR_MAX_BYTES + 1 },
  fileFilter: (req, file, callback) => {
    announcedMimeTypes.set(req, file.mimetype);
    callback(null, true);
  },
});

/** Parses the `avatar` field; a file over the limit is answered here as the handler would. */
export function parseBotAvatarUpload(req: Request, res: Response, next: NextFunction): void {
  avatarUpload.single('avatar')(req, res, (error?: unknown) => {
    if (!(error instanceof multer.MulterError) || error.code !== 'LIMIT_FILE_SIZE') {
      next(error);
      return;
    }
    if (!isUuid(req.params.id)) {
      sendError(res, BOT_NOT_FOUND_MESSAGE, 404);
      return;
    }
    const imageType = BOT_AVATAR_MIME_TYPES.includes(announcedMimeTypes.get(req) ?? '');
    sendError(res, imageType ? BOT_AVATAR_SIZE_MESSAGE : BOT_AVATAR_TYPE_MESSAGE, 400);
  });
}
