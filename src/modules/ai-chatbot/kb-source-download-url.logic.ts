// ═══════════════════════════════════════════════════════════════
// SEP-1: short-lived signed URL for the AI service to download a KB source
// The AI service no longer holds a storage service key. Before each index request the backend
// signs one URL for exactly one object; the URL embeds a bearer token, so it is never logged,
// persisted or placed in an error message.
// ═══════════════════════════════════════════════════════════════

import { AppError } from '../../middleware/error-handler.js';

/** Returns a signed download URL for `objectPath` in `bucket`, valid for `ttlSeconds`. */
export type KbSourceUrlSigner = (bucket: string, objectPath: string, ttlSeconds: number) => Promise<string>;

/**
 * Same ownership rule as the AI service (`assert_tenant_storage_path`): the first path segment is
 * the tenant, no traversal and no embedded URL. Returns the normalized object path.
 */
export function assertKbSourcePathOwnedByTenant(filePath: string, tenantId: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!tenantId || !normalized.startsWith(`${tenantId}/`) || normalized.split('/').includes('..')
    || normalized.includes('://')) {
    throw new AppError('Không xác minh được quyền sở hữu tệp nguồn của tài liệu.', 422, 'KB_SOURCE_PATH_INVALID');
  }
  return normalized;
}

/**
 * Point a signed URL at the origin the AI server can reach (e.g. Kong's private TLS listener)
 * when the backend's own SUPABASE_URL is local to its host. Path and token are origin-independent.
 */
export function rewriteSignedUrlOrigin(signedUrl: string, origin: string): string {
  if (!origin) return signedUrl;
  const target = new URL(origin);
  const url = new URL(signedUrl);
  url.protocol = target.protocol;
  url.hostname = target.hostname;
  url.port = target.port;  // '' for the scheme default; assigning `host` alone would keep the old port
  return url.toString();
}

export async function signKbDocumentSourceUrl(input: {
  filePath: string;
  tenantId: string;
  bucket: string;
  ttlSeconds: number;
  origin: string;
  sign: KbSourceUrlSigner;
}): Promise<string> {
  const objectPath = assertKbSourcePathOwnedByTenant(input.filePath, input.tenantId);
  let signed = '';
  try {
    signed = await input.sign(input.bucket, objectPath, input.ttlSeconds);
  } catch {
    signed = '';  // the provider error may echo the object path; it is replaced by a safe code
  }
  if (!signed) {
    throw new AppError('Không tạo được liên kết tải tài liệu nguồn cho AI. Hệ thống sẽ thử lại.', 503,
      'KB_SOURCE_SIGNED_URL_FAILED');
  }
  return rewriteSignedUrlOrigin(signed, input.origin);
}
