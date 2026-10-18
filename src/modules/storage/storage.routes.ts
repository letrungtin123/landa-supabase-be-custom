// ═══════════════════════════════════════════════════════════════
// Storage Proxy — Stream files từ Supabase qua BE
// FE chỉ thấy URL dạng: BE_DOMAIN/api/storage/{path}
// Không lộ Supabase URL khi inspect
//
// Every file is streamed (never buffered in RAM), with stream.pipeline so
// the upstream body is destroyed when the client goes away (a video seek
// used to leave the Storage socket open for minutes). Storage must start
// answering within STORAGE_PROXY_HEADERS_TIMEOUT_MS; the body itself has no
// deadline (long videos). Range Request: video seek and PDF viewer.
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';

const BUCKET = 'landa-storage';

export interface StorageProxyOptions {
  /** Public Storage URL of a validated object path. */
  publicUrlFor: (storagePath: string) => string;
  fetch?: typeof fetch;
  headersTimeoutMs?: number;
}

class UpstreamHeadersTimeoutError extends Error {
  constructor() {
    super('storage_proxy_upstream_headers_timeout');
    this.name = 'UpstreamHeadersTimeoutError';
  }
}

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

const MAX_RANGE_HEADER_LENGTH = 128;
const MAX_IF_RANGE_HEADER_LENGTH = 256;
const SINGLE_BYTE_RANGE_RE = /^bytes=(?:\d+-\d*|\d*-\d+)$/;

function normalizeSingleRangeHeader(value: string | undefined): string | null {
  const range = value?.trim();
  if (!range || range.length > MAX_RANGE_HEADER_LENGTH) return null;
  if (!SINGLE_BYTE_RANGE_RE.test(range)) return null;
  return range;
}

function normalizeIfRangeHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return null;
  const ifRange = value?.trim();
  if (!ifRange || ifRange.length > MAX_IF_RANGE_HEADER_LENGTH) return null;
  return ifRange;
}

function rejectInvalidRange(res: Response, contentRange = 'bytes */*'): void {
  res.status(416);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Range', contentRange);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end();
}

function forwardOptionalHeader(upstreamRes: globalThis.Response, res: Response, headerName: string): void {
  const value = upstreamRes.headers.get(headerName.toLowerCase());
  if (value) res.setHeader(headerName, value);
}

/**
 * Streams the upstream body to the client. When either side fails or the
 * client leaves, pipeline destroys both streams (the Storage connection is
 * released at once); a cut body ends the client connection instead of
 * pretending the file is complete.
 */
async function streamBody(webBody: ReadableStream, res: Response): Promise<void> {
  try {
    await pipeline(Readable.fromWeb(webBody as any), res);
  } catch {
    // The client left or Storage failed mid-body; both streams are destroyed.
  }
}

/** Drops an upstream body that is not forwarded (error answers, HEAD). */
function discardBody(upstreamRes: globalThis.Response): void {
  upstreamRes.body?.cancel().catch(() => undefined); // releases an unread body; nothing to recover
}

/**
 * Fetches from Storage with an abort tied to the client: it fires when the
 * client goes away (also while the body streams) and when Storage has not
 * started answering within `headersTimeoutMs`.
 */
async function fetchUpstream(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string> | undefined,
  res: Response,
  headersTimeoutMs: number,
): Promise<globalThis.Response> {
  const controller = new AbortController();
  const clientGone = () => controller.abort(new Error('storage_proxy_client_closed'));
  if (res.destroyed) clientGone();
  else res.once('close', clientGone);
  const timer = setTimeout(() => controller.abort(new UpstreamHeadersTimeoutError()), headersTimeoutMs);
  try {
    return await fetchImpl(url, { ...(headers ? { headers } : {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createStorageProxyRouter(options: StorageProxyOptions): Router {
  const router = Router();
  const fetchImpl = options.fetch ?? fetch;
  const headersTimeoutMs = options.headersTimeoutMs ?? env.STORAGE_PROXY_HEADERS_TIMEOUT_MS;

  /**
   * GET /api/storage/*
   * Stream file từ Supabase Storage bucket.
   * Không cần auth — tương tự public bucket, chỉ proxy qua BE để ẩn infra URL.
   *
   * Hỗ trợ:
   * - Range Request (206 Partial Content) — bắt buộc cho video seek và hữu ích cho PDF lớn
   * - Streaming cho mọi file — không buffer trong RAM
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
      const isPdf = contentType === 'application/pdf';
      const supportsRange = isMedia || isPdf;

      // Lấy public URL từ Supabase (không download — chỉ resolve URL)
      const publicUrl = options.publicUrlFor(storagePath);

      // ── Range Request (video seek/PDF viewer) -> forward one safe Range to Supabase ──
      const rawRangeHeader = req.headers.range;
      const rangeHeader = normalizeSingleRangeHeader(rawRangeHeader);
      if (rawRangeHeader && !rangeHeader) {
        rejectInvalidRange(res);
        return;
      }

      if (rangeHeader && supportsRange) {
        const upstreamHeaders: Record<string, string> = { Range: rangeHeader };
        const ifRangeHeader = normalizeIfRangeHeader(req.headers['if-range']);
        if (ifRangeHeader) upstreamHeaders['If-Range'] = ifRangeHeader;

        const upstreamRes = await fetchUpstream(fetchImpl, publicUrl, upstreamHeaders, res, headersTimeoutMs);

        if (upstreamRes.status === 416) {
          discardBody(upstreamRes);
          rejectInvalidRange(res, upstreamRes.headers.get('content-range') || 'bytes */*');
          return;
        }

        if (!upstreamRes.ok && upstreamRes.status !== 206) {
          discardBody(upstreamRes);
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
        forwardOptionalHeader(upstreamRes, res, 'ETag');
        forwardOptionalHeader(upstreamRes, res, 'Last-Modified');
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (isPdf) {
          const filename = storagePath.split('/').pop() || 'file.pdf';
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
        }

        if (req.method === 'HEAD') {
          discardBody(upstreamRes);
          res.end();
          return;
        }

        // Pipe upstream body → client (streaming, no buffer)
        if (upstreamRes.body) {
          await streamBody(upstreamRes.body, res);
        } else {
          res.status(502).end();
        }
        return;
      }

      // ── Non-Range: always streamed ──
      const upstreamRes = await fetchUpstream(fetchImpl, publicUrl, undefined, res, headersTimeoutMs);

      if (!upstreamRes.ok) {
        discardBody(upstreamRes);
        res.status(upstreamRes.status === 404 ? 404 : 502).json({
          success: false,
          message: upstreamRes.status === 404 ? 'File not found' : 'Upstream error',
        });
        return;
      }

      const contentLength = upstreamRes.headers.get('content-length');

      // Cache control
      const needsRevalidate = storagePath.includes('/avatars/') || storagePath.includes('/branding/');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', needsRevalidate
        ? 'no-cache, must-revalidate'
        : supportsRange
          ? 'public, max-age=86400, immutable'
          : 'public, max-age=3600, immutable',
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Video/audio/PDF: advertise Range support
      if (supportsRange) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      forwardOptionalHeader(upstreamRes, res, 'ETag');
      forwardOptionalHeader(upstreamRes, res, 'Last-Modified');

      // Content-Disposition cho file download
      const forceDownload = req.query.download === '1';
      if (forceDownload || (!contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/'))) {
        const filename = storagePath.split('/').pop() || 'file';
        const dispositionType = forceDownload ? 'attachment' : 'inline';
        res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(filename)}"`);
      }

      if (req.method === 'HEAD') {
        discardBody(upstreamRes);
        res.status(200).end();
        return;
      }

      // Every size is streamed: nothing transforms the bytes, so a buffer
      // (formerly for files up to 2 MB) only cost heap per concurrent image.
      res.status(200);
      if (upstreamRes.body) {
        await streamBody(upstreamRes.body, res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err instanceof UpstreamHeadersTimeoutError
        || (err instanceof Error && err.cause instanceof UpstreamHeadersTimeoutError)
        || (err as { name?: string })?.name === 'UpstreamHeadersTimeoutError') {
        console.warn('[Storage Proxy] Storage did not answer in time');
        if (!res.headersSent) res.status(502).json({ success: false, message: 'Upstream error' });
        return;
      }
      if (res.destroyed || res.writableEnded) return; // the client left before Storage answered
      console.error('[Storage Proxy] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Internal error' });
      }
    }
  });

  return router;
}

// Supabase admin client (service_role — bypass RLS)
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default createStorageProxyRouter({
  publicUrlFor: (storagePath) => supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl,
});
