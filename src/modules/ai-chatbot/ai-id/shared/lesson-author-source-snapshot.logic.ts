import { createHash } from 'node:crypto';

/** Existing Blueprint metadata-revision fingerprint. This is deliberately
 * byte-compatible with stored V3/V4/V5 hashes, NOT a hash of document content.
 * Callers must check ownership/readiness and normalize updated_at first. */
export interface LessonAuthorSnapshotDocument {
  document_id: string;
  name: string;
  status?: string | null;
  updated_at: string;
  source_info: Record<string, unknown> | null;
}
export function lessonAuthorSourceInfoSummary(sourceInfo: Record<string, unknown> | null): string {
  if (!sourceInfo) return '';
  const parts: string[] = [];
  const extension = typeof sourceInfo.extension === 'string' ? sourceInfo.extension : '';
  const mimeType = typeof sourceInfo.mime_type === 'string' ? sourceInfo.mime_type : '';
  const size = typeof sourceInfo.size === 'number' ? sourceInfo.size : null;
  if (extension) parts.push(`extension=${extension}`);
  if (mimeType) parts.push(`mime_type=${mimeType}`);
  if (size && Number.isFinite(size)) parts.push(`size=${size}`);
  return parts.join(', ');
}
export function lessonAuthorSourceSnapshotHash(
  ctx: { tenantId: string; courseId: string | null }, kbId: string,
  sourceDocuments: readonly LessonAuthorSnapshotDocument[],
): string {
  const sourceKey = sourceDocuments.map(document => [document.document_id, document.name, document.status ?? '',
    document.updated_at, lessonAuthorSourceInfoSummary(document.source_info)].join(':')).sort().join('|');
  return createHash('sha256').update([ctx.tenantId, ctx.courseId, kbId, sourceKey].join('|')).digest('hex');
}
