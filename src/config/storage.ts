// ═══════════════════════════════════════════════════════════════
// Supabase Storage — Upload / Delete / Public URL helpers
// ═══════════════════════════════════════════════════════════════
// Tất cả file uploads đi qua utility này.
// Bucket: 'landa-storage' (public)
// Path pattern: {tenant_id}/{category}/{...}

import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

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
    fileSizeLimit: 52_428_800, // 50MB
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
 * @returns Public URL of the uploaded file
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

  return getPublicUrl(storagePath);
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
 * Extract storage path from a public URL.
 * e.g. "http://127.0.0.1:54321/storage/v1/object/public/landa-storage/tenant/avatars/file.jpg"
 *   → "tenant/avatars/file.jpg"
 */
export function extractStoragePath(publicUrl: string): string | null {
  const marker = `/object/public/${STORAGE_BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(publicUrl.substring(idx + marker.length));
}

/**
 * Delete a file from storage using its public URL.
 * Safe to call — silently ignores if URL is invalid or file doesn't exist.
 */
export async function deleteFileByUrl(publicUrl: string | null | undefined): Promise<void> {
  if (!publicUrl) return;
  const path = extractStoragePath(publicUrl);
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
  category: 'avatars' | 'courses' | 'library' | 'help-docs',
  fileName: string,
  subFolder?: string,
): string {
  const parts = [tenantId, category];
  if (subFolder) parts.push(subFolder);
  parts.push(fileName);
  return parts.join('/');
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
