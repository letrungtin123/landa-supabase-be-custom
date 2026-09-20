// ═══════════════════════════════════════════════════════════════
// Supabase Storage — Upload / Delete / Public URL helpers
// ═══════════════════════════════════════════════════════════════
// Tất cả file uploads đi qua utility này.
// Download helper dùng cho worker (download temp file).
// Bucket: 'landa-storage' (public)
// Path pattern: {tenant_id}/{category}/{...}

import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { COURSE_ASSET_MAX_UPLOAD_BYTES } from './upload-limits.js';
import {
  commitStorageUpload,
  flagStorageDeletesForReconciliation,
  flagStorageUploadForReconciliation,
  recordStorageDelete,
  releaseStorageDeleteReservations,
  releaseStorageUploadReservation,
  reserveStorageDeletes,
  reserveStorageUpload,
} from '../modules/tenants/tenant-data-quota.service.js';

// ── Supabase admin client (service_role — bypass RLS) ──
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const STORAGE_BUCKET = 'landa-storage';
/**
 * Raw lesson-author videos and their uncommitted transcripts must never enter
 * the application's public asset bucket. This bucket is created manually by
 * the matching Supabase migration and is accessed by the backend only.
 */
export const LESSON_AUTHOR_PRIVATE_STORAGE_BUCKET = 'lesson-author-private';
/** Every tenant-owned object bucket included in quota reconciliation/parity. */
export const TENANT_STORAGE_BUCKETS = [STORAGE_BUCKET, LESSON_AUTHOR_PRIVATE_STORAGE_BUCKET] as const;

/** A received Storage API error is a definitive provider rejection, unlike a timeout. */
class StorageProviderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageProviderRejectedError';
  }
}

// ── Ensure bucket exists (idempotent — gọi 1 lần khi app start) ──
let bucketReady = false;
export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { data, error } = await supabase.storage.getBucket(STORAGE_BUCKET);
  if (!error && data) {
    // Bucket already exists
    bucketReady = true;
    return;
  }
  // Try to create
  const { error: createErr } = await supabase.storage.createBucket(STORAGE_BUCKET, {
    public: true,
    fileSizeLimit: COURSE_ASSET_MAX_UPLOAD_BYTES,
  });
  if (createErr && !createErr.message.includes('already exists')) {
    throw new Error(`[Storage] Cannot create bucket: ${createErr.message}`);
  }
  if (!createErr) console.log(`[Storage] Bucket "${STORAGE_BUCKET}" created.`);
  bucketReady = true;
}

/**
 * Upload file buffer to Supabase Storage.
 * @param storagePath - e.g. "{tenantId}/avatars/{filename}"
 * @param buffer - File buffer
 * @param contentType - MIME type
 * @param upsert - Overwrite if exists (default false)
 * @returns Storage path (NOT full URL) — DB chỉ lưu path, FE sẽ nhận URL qua toPublicUrl()
 */
export async function uploadFile(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
  upsert = false,
): Promise<string> {
  await ensureBucket();

  // Reserve before the provider call. This is intentionally server-side: a
  // browser-provided Content-Length is not a quota authority.
  const reservation = await reserveStorageUpload(storagePath, buffer.byteLength);

  try {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType,
        upsert,
        cacheControl: '3600',
      });

    if (error) {
      throw new StorageProviderRejectedError(`[Storage] Upload failed (${storagePath}): ${error.message}`);
    }

    // A successful provider response is the only point where a reservation is
    // converted into used bytes. A commit mismatch is conservatively retained
    // for reconciliation rather than freeing quota optimistically.
    await commitStorageUpload(reservation, buffer.byteLength);
    // Trả về PATH, không phải full URL — DB chỉ lưu path để không lộ infra
    return storagePath;
  } catch (error) {
    if (error instanceof StorageProviderRejectedError) {
      await releaseStorageUploadReservation(reservation)
        .catch(() => flagStorageUploadForReconciliation(reservation));
    } else {
      await flagStorageUploadForReconciliation(reservation).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Upload a local temp file to Supabase Storage.
 *
 * Supabase JS can keep Node file streams open on Windows in this runtime,
 * leaving multer temp files locked and the request unresolved. Read the temp
 * file into a Buffer and reuse the stable upload path used by memory uploads.
 */
export async function uploadFileFromPath(
  storagePath: string,
  filePath: string,
  contentType: string,
  upsert = false,
): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return uploadFile(storagePath, buffer, contentType, upsert);
}

function storageObjectUrl(bucket: string, storagePath: string): string {
  const encodedPath = storagePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

function privateStorageHeaders(contentType?: string, contentLength?: number): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(contentLength !== undefined ? { 'Content-Length': String(contentLength) } : {}),
  };
}

/**
 * Stream a public course asset from Multer's temp file to Storage. Unlike the
 * SDK's Buffer upload, this does not duplicate large videos in the Node heap.
 * This is deliberately separate from uploadFileFromPath() so document and AI
 * flows retain their established behaviour.
 */
export async function uploadCourseAssetFileFromPath(
  storagePath: string,
  filePath: string,
  contentType: string,
  upsert = false,
): Promise<string> {
  await ensureBucket();

  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Tệp tải lên tạm không hợp lệ.');
  if (stat.size > COURSE_ASSET_MAX_UPLOAD_BYTES) throw new Error('Tệp tải lên vượt quá giới hạn cho phép.');

  const reservation = await reserveStorageUpload(storagePath, stat.size);
  try {
    const body = Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit;
    const response = await fetch(storageObjectUrl(STORAGE_BUCKET, storagePath), {
      method: 'POST',
      headers: {
        ...privateStorageHeaders(contentType, stat.size),
        'x-upsert': String(upsert),
        'cache-control': '3600',
      },
      body,
      // Node requires this for a streamed request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new StorageProviderRejectedError(`[Storage] Course asset upload failed (${response.status}): ${detail || response.statusText}`);
    }

    await commitStorageUpload(reservation, stat.size);
    return storagePath;
  } catch (error) {
    if (error instanceof StorageProviderRejectedError) {
      await releaseStorageUploadReservation(reservation)
        .catch(() => flagStorageUploadForReconciliation(reservation));
    } else {
      await flagStorageUploadForReconciliation(reservation).catch(() => undefined);
    }
    throw error;
  }
}

/** Build an opaque, tenant-scoped key for server-only lesson-author artifacts. */
export function buildLessonAuthorPrivateStoragePath(
  tenantId: string,
  kind: 'videos' | 'transcripts',
  fileName: string,
): string {
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${tenantId}/lesson-author/${kind}/${dateFolder}/${fileName}`;
}

/**
 * Stream a local file directly to the private bucket. The existing SDK helper
 * accepts Buffers and is intentionally not used here: a video upload must not
 * allocate its full size in the Node.js heap.
 */
export async function uploadLessonAuthorPrivateFileFromPath(
  storagePath: string,
  filePath: string,
  contentType: string,
): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Tệp video tạm không hợp lệ.');

  const reservation = await reserveStorageUpload(storagePath, stat.size);
  try {
    const body = Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit;
    const response = await fetch(storageObjectUrl(LESSON_AUTHOR_PRIVATE_STORAGE_BUCKET, storagePath), {
      method: 'POST',
      headers: { ...privateStorageHeaders(contentType, stat.size), 'x-upsert': 'false' },
      body,
      // Required by Node's fetch implementation for streamed request bodies.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new StorageProviderRejectedError(`[Storage] Private upload failed (${response.status}): ${detail || response.statusText}`);
    }
    await commitStorageUpload(reservation, stat.size);
    return storagePath;
  } catch (error) {
    if (error instanceof StorageProviderRejectedError) {
      await releaseStorageUploadReservation(reservation)
        .catch(() => flagStorageUploadForReconciliation(reservation));
    } else {
      await flagStorageUploadForReconciliation(reservation).catch(() => undefined);
    }
    throw error;
  }
}

/** Download a private object to disk without buffering a video in memory. */
export async function downloadLessonAuthorPrivateFileToTemp(
  storagePath: string,
  tempDir: string,
): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  const response = await fetch(storageObjectUrl(LESSON_AUTHOR_PRIVATE_STORAGE_BUCKET, storagePath), {
    headers: privateStorageHeaders(),
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`[Storage] Private download failed (${response.status}): ${detail || response.statusText}`);
  }

  const fileName = storagePath.split('/').pop() || `lesson-author-${Date.now()}`;
  const tempPath = path.resolve(tempDir, `${Date.now()}_${fileName}`);
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('stream/web').ReadableStream),
      createWriteStream(tempPath, { flags: 'wx' }),
    );
    return tempPath;
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Transcript text is bounded before buffering, even if a private object is corrupted. */
export async function downloadLessonAuthorPrivateText(
  storagePath: string,
  maximumBytes = env.LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS * 4 + 1024,
): Promise<string> {
  const response = await fetch(storageObjectUrl(LESSON_AUTHOR_PRIVATE_STORAGE_BUCKET, storagePath), {
    headers: privateStorageHeaders(),
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`[Storage] Private transcript download failed (${response.status}): ${detail || response.statusText}`);
  }
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error('[Storage] Private transcript exceeds the permitted size.');
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of Readable.fromWeb(response.body as unknown as import('stream/web').ReadableStream)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maximumBytes) {
      throw new Error('[Storage] Private transcript exceeds the permitted size.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function deleteLessonAuthorPrivateFiles(storagePaths: readonly string[]): Promise<void> {
  const paths = [...new Set(storagePaths.map(value => value.trim()).filter(Boolean))];
  if (paths.length === 0) return;
  const reservations = await reserveStorageDeletes(paths);
  try {
    const { error } = await supabase.storage.from(LESSON_AUTHOR_PRIVATE_STORAGE_BUCKET).remove(paths);
    if (error) throw new StorageProviderRejectedError(`[Storage] Private delete failed: ${error.message}`);
    await recordStorageDelete(paths, reservations);
  } catch (error) {
    if (error instanceof StorageProviderRejectedError) {
      await releaseStorageDeleteReservations(reservations)
        .catch(() => flagStorageDeletesForReconciliation(reservations));
    } else {
      await flagStorageDeletesForReconciliation(reservations).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Download a file buffer from Supabase Storage.
 * Used by authenticated/private download endpoints.
 */
export async function downloadFileBuffer(storagePath: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  await ensureBucket();

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`[Storage] Download failed (${storagePath}): ${error?.message || 'No data'}`);
  }

  return {
    buffer: Buffer.from(await data.arrayBuffer()),
    contentType: data.type || null,
  };
}

/**
 * Delete storage objects in bounded batches.
 *
 * A caller that needs a guaranteed purge must be able to observe a failure.
 * Do not change this back to log-and-continue: that behavior turns storage
 * leaks into falsely successful deletion jobs.
 */
export async function deleteFiles(storagePaths: readonly string[]): Promise<void> {
  const paths = [...new Set(storagePaths.map((path) => path.trim()).filter(Boolean))];
  if (paths.length === 0) return;

  await ensureBucket();
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    const reservations = await reserveStorageDeletes(batch);
    try {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(batch);
      if (error) {
        throw new StorageProviderRejectedError(`[Storage] Delete failed (${batch.length} object(s)): ${error.message}`);
      }
      // Only reduce quota after the provider confirms removal of this batch.
      await recordStorageDelete(batch, reservations);
    } catch (error) {
      if (error instanceof StorageProviderRejectedError) {
        await releaseStorageDeleteReservations(reservations)
          .catch(() => flagStorageDeletesForReconciliation(reservations));
      } else {
        await flagStorageDeletesForReconciliation(reservations).catch(() => undefined);
      }
      throw error;
    }
  }
}

/** Delete one storage object. Errors are deliberately propagated to the caller. */
export async function deleteFile(storagePath: string): Promise<void> {
  await deleteFiles([storagePath]);
}

/**
 * Get public URL for a storage path.
 */
export function getPublicUrl(storagePath: string): string {
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Convert a storage path to a full public URL.
 * Dùng khi cần trả URL cho FE trong API response.
 * DB lưu path, FE nhận full URL.
 */
export function toPublicUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  // Nếu đã là full URL (data cũ) → trả nguyên
  if (storagePath.startsWith('http://') || storagePath.startsWith('https://')) {
    return storagePath;
  }
  return getPublicUrl(storagePath);
}

/**
 * Resolve a value that could be either a storage path or a full URL.
 * Dùng trong query results để xử lý cả data cũ (full URL) và data mới (path only).
 */
export function resolveStorageUrl(value: string | null | undefined): string | null {
  return toPublicUrl(value);
}

/**
 * Extract storage path from a full URL or return as-is if already a path.
 * e.g. "http://127.0.0.1:54321/storage/v1/object/public/landa-storage/tenant/avatars/file.jpg"
 *   → "tenant/avatars/file.jpg"
 * e.g. "tenant/avatars/file.jpg" → "tenant/avatars/file.jpg"
 */
export function extractStoragePath(value: string): string | null {
  if (!value) return null;
  // Nếu không phải URL → đã là path rồi
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return value;
  }
  const marker = `/object/public/${STORAGE_BUCKET}/`;
  const idx = value.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(value.substring(idx + marker.length));
}

/**
 * Delete a file from storage using its path or public URL.
 * Safe to call — silently ignores if value is invalid or file doesn't exist.
 * Handles both old full URLs and new path-only values.
 */
export async function deleteFileByUrl(value: string | null | undefined): Promise<void> {
  if (!value) return;
  const path = extractStoragePath(value);
  if (!path) return;
  await deleteFile(path);
}

/**
 * Build a safe filename for Supabase Storage (ASCII-only keys).
 * Tên file gốc được lưu trong DB (display_name / title), không cần giữ trong path.
 */
export function buildFileName(originalName: string): string {
  // Tách extension
  const lastDot = originalName.lastIndexOf('.');
  const ext = lastDot > 0 ? originalName.substring(lastDot) : '';
  const baseName = lastDot > 0 ? originalName.substring(0, lastDot) : originalName;

  // Transliterate: normalize Unicode → strip diacritics → ASCII-safe
  const ascii = baseName
    .normalize('NFD')                    // decompose diacritics (ấ → a + combining)
    .replace(/[\u0300-\u036f]/g, '')     // strip combining marks
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')  // Vietnamese đ
    .replace(/[^a-zA-Z0-9._-]/g, '_')   // non-ASCII → underscore
    .replace(/_+/g, '_')                 // collapse
    .replace(/^_|_$/g, '');              // trim

  return `${Date.now()}_${ascii || 'file'}${ext}`;
}

/**
 * Build storage path for a specific context.
 */
export function buildStoragePath(
  tenantId: string,
  category: 'avatars' | 'courses' | 'library' | 'help-docs' | 'branding' | 'kb-documents' | 'kb-files' | 'kb-faqs' | 'kb-articles' | 'prompt-mascots' | 'assignments',
  fileName: string,
  subFolder?: string,
): string {
  const parts = [tenantId, category];
  if (subFolder) parts.push(subFolder);
  parts.push(fileName);
  return parts.join('/');
}

/**
 * Download a file from Supabase Storage to a local temp path.
 * Used by RabbitMQ workers to get files for Gemini upload.
 * @returns Absolute path to the temp file.
 */
export async function downloadToTempFile(
  storagePath: string,
  tempDir: string,
): Promise<string> {
  await ensureBucket();

  // Ensure temp dir exists
  await fs.mkdir(tempDir, { recursive: true });

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`[Storage] Download failed (${storagePath}): ${error?.message || 'No data'}`);
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  const fileName = storagePath.split('/').pop() || `tmp_${Date.now()}`;
  const tempPath = path.resolve(tempDir, `${Date.now()}_${fileName}`);
  await fs.writeFile(tempPath, buffer);
  return tempPath;
}

/**
 * Fix multer's filename encoding.
 * Multer stores `originalname` using Latin-1 encoding from multipart headers,
 * which causes mojibake for UTF-8 filenames (e.g. "Tất" → "Táº¥t").
 * This converts the Latin-1 bytes back to a proper UTF-8 string.
 */
export function fixMulterFilename(originalname: string): string {
  try {
    return Buffer.from(originalname, 'latin1').toString('utf8');
  } catch {
    return originalname;
  }
}
