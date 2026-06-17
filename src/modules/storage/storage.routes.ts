// ═══════════════════════════════════════════════════════════════
// Storage Proxy — Stream files từ Supabase qua BE
// FE chỉ thấy URL dạng: BE_DOMAIN/api/storage/{path}
// Không lộ Supabase URL khi inspect
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';

const router = Router();

// Supabase admin client (service_role — bypass RLS)
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = 'landa-storage';

// Mime-type map cho các extension phổ biến
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function getMimeType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * GET /api/storage/*
 * Stream file từ Supabase Storage bucket.
 * Không cần auth — tương tự public bucket, chỉ proxy qua BE để ẩn infra URL.
 *
 * Path validation: chặn path traversal (../) và ký tự nguy hiểm.
 */
router.get('/*path', async (req: Request, res: Response): Promise<void> => {
  try {
    // Lấy path từ URL (loại bỏ prefix /api/storage/)
    // Express v5 wildcard trả array of segments
    const rawPath = req.params.path;
    const storagePath = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');

    // Validate path — chặn path traversal + ký tự nguy hiểm
    if (
      !storagePath ||
      storagePath.includes('..') ||
      storagePath.includes('//') ||
      /[<>"|?*]/.test(storagePath)
    ) {
      res.status(400).json({ success: false, message: 'Invalid path' });
      return;
    }

    // Download file từ Supabase Storage
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(storagePath);

    if (error || !data) {
      res.status(404).json({ success: false, message: 'File not found' });
      return;
    }

    // Xác định content type
    const contentType = getMimeType(storagePath);

    // Avatars + branding dùng same path khi re-upload → cần revalidate
    // Các file khác (course assets, docs) thì cache aggressive
    const needsRevalidate = storagePath.includes('/avatars/') || storagePath.includes('/branding/');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', needsRevalidate
      ? 'no-cache, must-revalidate'
      : 'public, max-age=3600, immutable',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Nếu là file download (không phải image/video) hoặc có param ?download=1 → thêm Content-Disposition
    const forceDownload = req.query.download === '1';
    if (forceDownload || (!contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/'))) {
      const filename = storagePath.split('/').pop() || 'file';
      const dispositionType = forceDownload ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(filename)}"`);
    }

    // Convert Blob → Buffer → send
    const buffer = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Length', buffer.length);
    res.status(200).end(buffer);
  } catch (err) {
    console.error('[Storage Proxy] Error:', err);
    res.status(500).json({ success: false, message: 'Internal error' });
  }
});

export default router;
