import { createHmac, timingSafeEqual } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { extractStoragePath } from '../../config/storage.js';
import { AppError } from '../../middleware/error-handler.js';

const NEWS_CONTENT_MAX_BYTES = 500_000;
const STORAGE_PROXY_PREFIX = '/api/storage/';
const CURSOR_VERSION = 1;

export interface NewsCursorPayload {
  v: 1;
  timestamp: string;
  id: string;
  status: 'active' | 'archived';
  search: string;
}

function cursorSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeNewsCursor(
  input: Omit<NewsCursorPayload, 'v'>,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...input }), 'utf8').toString('base64url');
  return `${payload}.${cursorSignature(payload, secret)}`;
}

export function decodeNewsCursor(raw: string | undefined, secret: string): NewsCursorPayload | null {
  if (!raw) return null;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra) throw new AppError('Cursor không hợp lệ', 400, 'INVALID_CURSOR');
  const expected = cursorSignature(payload, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new AppError('Cursor không hợp lệ', 400, 'INVALID_CURSOR');
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<NewsCursorPayload>;
    const validTimestamp = typeof parsed.timestamp === 'string' && Number.isFinite(Date.parse(parsed.timestamp));
    const validId = typeof parsed.id === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.id);
    if (parsed.v !== CURSOR_VERSION || !validTimestamp || !validId
      || !['active', 'archived'].includes(parsed.status || '') || typeof parsed.search !== 'string') {
      throw new Error('invalid payload');
    }
    return parsed as NewsCursorPayload;
  } catch {
    throw new AppError('Cursor không hợp lệ', 400, 'INVALID_CURSOR');
  }
}

function extractProxyStoragePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith(STORAGE_PROXY_PREFIX)) {
    return decodeURIComponent(trimmed.slice(STORAGE_PROXY_PREFIX.length));
  }
  try {
    const url = new URL(trimmed);
    if (url.pathname.startsWith(STORAGE_PROXY_PREFIX)) {
      return decodeURIComponent(url.pathname.slice(STORAGE_PROXY_PREFIX.length));
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeNewsImagePath(value: unknown, tenantId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const path = extractStoragePath(extractProxyStoragePath(raw) || raw)?.trim();
  if (!path || !path.startsWith(`${tenantId}/news/`)) return null;
  if (path.includes('..') || path.includes('//') || /[\s<>"'`\\|?*]/.test(path)) return null;
  return path;
}

export function extractNewsImagePaths(html: string, tenantId: string): string[] {
  const paths = new Set<string>();
  const imgPattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = imgPattern.exec(html)) !== null) {
    const raw = match[1] || match[2] || match[3] || '';
    const path = normalizeNewsImagePath(raw, tenantId);
    if (!path) throw new AppError('Nội dung chứa ảnh không thuộc Bảng tin của doanh nghiệp hiện tại', 400, 'INVALID_NEWS_IMAGE');
    paths.add(path);
  }
  return [...paths];
}

export function sanitizeNewsContent(raw: unknown, tenantId: string): { html: string; imagePaths: string[]; excerpt: string } {
  if (typeof raw !== 'string') throw new AppError('Nội dung bài viết không hợp lệ', 400);
  if (Buffer.byteLength(raw, 'utf8') > NEWS_CONTENT_MAX_BYTES) {
    throw new AppError('Nội dung bài viết vượt quá dung lượng cho phép', 400);
  }

  // Validate before sanitizing so an invalid/hot-linked image cannot silently disappear from an editor save.
  extractNewsImagePaths(raw, tenantId);
  const html = sanitizeHtml(raw, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'figure', 'figcaption', 'h1', 'h2', 'h3',
      'h4', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span', 'strike', 'strong', 'u', 'ul',
    ],
    allowedAttributes: {
      '*': ['class'],
      a: ['href', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'width', 'height', 'data-landa-image-mode'],
    },
    allowedClasses: { '*': [/^[A-Za-z0-9_-]{1,64}$/] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, rel: 'noopener noreferrer', ...(attribs.target === '_blank' ? { target: '_blank' } : {}) },
      }),
      img: (_tagName, attribs) => {
        const path = normalizeNewsImagePath(attribs.src, tenantId);
        return path
          ? { tagName: 'img', attribs: { ...attribs, src: path } }
          : { tagName: 'span', attribs: {} };
      },
    },
  });

  const imagePaths = extractNewsImagePaths(html, tenantId);
  const excerpt = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
  return { html, imagePaths, excerpt };
}

export function normalizeNewsSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

export function foldNewsSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLocaleLowerCase('vi');
}
