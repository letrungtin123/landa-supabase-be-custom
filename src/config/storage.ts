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
import path from 'path';
import { COURSE_ASSET_MAX_UPLOAD_BYTES } from './upload-limits.js';

// ── Supabase admin client (service_role — bypass RLS) ──
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const STORAGE_BUCKET = 'landa-storage';

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

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType,
      upsert,
      cacheControl: '3600',
    });

  if (error) {
    throw new Error(`[Storage] Upload failed (${storagePath}): ${error.message}`);
  }

  // Trả về PATH, không phải full URL — DB chỉ lưu path để không lộ infra
  return storagePath;
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
 * Delete a file from storage.
 */
export async function deleteFile(storagePath: string): Promise<void> {
  await ensureBucket();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
  if (error) {
    console.error(`[Storage] Delete failed (${storagePath}): ${error.message}`);
  }
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
