// ═══════════════════════════════════════════════════════════════
// Storage Proxy — Stream files từ Supabase qua BE
// FE chỉ thấy URL dạng: BE_DOMAIN/api/storage/{path}
// Không lộ Supabase URL khi inspect
//
// Video/Large files: Dùng fetch() + pipe stream thay vì buffer
// toàn bộ file trong RAM. Hỗ trợ Range Request cho video seek.
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
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
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function getMimeType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// Size threshold để quyết định streaming vs buffer
// Files ≤ 2MB: buffer (nhanh hơn cho ảnh nhỏ, avatars)
// Files > 2MB: streaming (video, PDF lớn)
const STREAM_THRESHOLD = 2 * 1024 * 1024;

/**
 * Pipe a web ReadableStream to Express response (Node stream).
 * Safely handles errors to avoid crashing the process.
 */
function pipeWebStream(webBody: ReadableStream, res: Response): void {
  const readable = Readable.fromWeb(webBody as any);
  readable.pipe(res);
  readable.on('error', () => {
    if (!res.writableEnded) res.end();
  });
}

/**
 * GET /api/storage/*
 * Stream file từ Supabase Storage bucket.
 * Không cần auth — tương tự public bucket, chỉ proxy qua BE để ẩn infra URL.
 *
 * Hỗ trợ:
 * - Range Request (206 Partial Content) — bắt buộc cho video seek
 * - Streaming cho files lớn — tránh buffer toàn bộ trong RAM
 * - Buffer cho files nhỏ (≤2MB) — tối ưu latency
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

    // Xác định content type
    const contentType = getMimeType(storagePath);
    const isMedia = contentType.startsWith('video/') || contentType.startsWith('audio/');

    // Lấy public URL từ Supabase (không download — chỉ resolve URL)
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    // ── Range Request (video seek) → forward Range sang Supabase ──
    const rangeHeader = req.headers.range;
    if (rangeHeader && isMedia) {
      const upstreamRes = await fetch(publicUrl, {
        headers: { Range: rangeHeader },
      });

      if (!upstreamRes.ok && upstreamRes.status !== 206) {
        res.status(upstreamRes.status === 404 ? 404 : 502).json({
          success: false,
          message: upstreamRes.status === 404 ? 'File not found' : 'Upstream error',
        });
        return;
      }

      // Forward Range response headers
      res.status(upstreamRes.status); // 206 Partial Content
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      const contentRange = upstreamRes.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const cl = upstreamRes.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Pipe upstream body → client (streaming, no buffer)
      if (upstreamRes.body) {
        pipeWebStream(upstreamRes.body, res);
      } else {
        res.status(502).end();
      }
      return;
    }

    // ── Non-Range: streaming cho files lớn, buffer cho files nhỏ ──
    const upstreamRes = await fetch(publicUrl);

    if (!upstreamRes.ok) {
      res.status(upstreamRes.status === 404 ? 404 : 502).json({
        success: false,
        message: upstreamRes.status === 404 ? 'File not found' : 'Upstream error',
      });
      return;
    }

    const contentLength = upstreamRes.headers.get('content-length');
    const fileSize = contentLength ? parseInt(contentLength, 10) : 0;

    // Cache control
    const needsRevalidate = storagePath.includes('/avatars/') || storagePath.includes('/branding/');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', needsRevalidate
      ? 'no-cache, must-revalidate'
      : isMedia
        ? 'public, max-age=86400, immutable'
        : 'public, max-age=3600, immutable',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Video/audio: advertise Range support
    if (isMedia) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Content-Disposition cho file download
    const forceDownload = req.query.download === '1';
    if (forceDownload || (!contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/'))) {
      const filename = storagePath.split('/').pop() || 'file';
      const dispositionType = forceDownload ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(filename)}"`);
    }

    // Quyết định buffer vs stream dựa trên file size
    if (fileSize > 0 && fileSize <= STREAM_THRESHOLD) {
      // Files nhỏ (≤2MB): buffer — nhanh hơn, ít overhead
      const buffer = Buffer.from(await upstreamRes.arrayBuffer());
      res.status(200).end(buffer);
    } else {
      // Files lớn (>2MB) hoặc không biết size: streaming
      res.status(200);
      if (upstreamRes.body) {
        pipeWebStream(upstreamRes.body, res);
      } else {
        // Fallback: buffer nếu không có body stream
        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.end(buffer);
      }
    }
  } catch (err) {
    console.error('[Storage Proxy] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Internal error' });
    }
  }
});

export default router;
