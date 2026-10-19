// ═══════════════════════════════════════════════════════════════
// Course outline transfer rules without I/O: the outline levels a block may
// move to, input and cursor normalization, operator-safe failure messages
// and the Storage paths an outline references. Moved unchanged from
// course-outline-transfer.service.ts.
// ═══════════════════════════════════════════════════════════════

import { extractStoragePath } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { withoutServerOwnedAuthorNotes } from './course-author-notes.logic.js';
import {
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../tenants/tenant-data-quota.constants.js';
import { UUID_PATTERN } from '../../utils/uuid.js';
import type { PayloadRow } from './course-outline-transfer.types.js';

export const MOVE_OPERATION_DISABLED_MESSAGE = 'Tính năng chuyển nội dung đã ngừng sử dụng. Hãy tạo một yêu cầu nhân bản mới.';

const STRUCTURAL_PARENT: Record<string, string> = {
  chapter: 'course',
  sequential: 'chapter',
  vertical: 'sequential',
};
const DESTINATION_PATH_TYPES: Record<string, Array<'chapter' | 'sequential' | 'vertical'>> = {
  chapter: [],
  sequential: ['chapter'],
  vertical: ['chapter', 'sequential'],
};

export function isTransferableBlockType(blockType: string): boolean {
  return blockType !== 'course';
}

export function expectedDestinationParentType(sourceBlockType: string): string {
  return STRUCTURAL_PARENT[sourceBlockType] || 'vertical';
}

export function destinationPathTypes(sourceBlockType: string): Array<'chapter' | 'sequential' | 'vertical'> {
  return DESTINATION_PATH_TYPES[sourceBlockType] || ['chapter', 'sequential', 'vertical'];
}

export function normalizeSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

export function normalizePage(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

export function decodeCursor(value: unknown): { displayName: string; id: string } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { displayName?: unknown; id?: unknown };
    if (typeof parsed.displayName !== 'string' || typeof parsed.id !== 'string' || parsed.displayName.length > 500 || parsed.id.length > 500) {
      throw new Error('invalid cursor');
    }
    return { displayName: parsed.displayName, id: parsed.id };
  } catch {
    throw new AppError('Trang dữ liệu không hợp lệ. Hãy tải lại danh sách.', 400);
  }
}

export function encodeCursor(row: { display_name: string; id: string }): string {
  return Buffer.from(JSON.stringify({ displayName: row.display_name, id: row.id }), 'utf8').toString('base64url');
}

export function normalizeDestinationPath(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new AppError('Đường dẫn vị trí nhận nội dung không hợp lệ.', 400);
  }
  return value.map((item) => {
    if (typeof item !== 'string') throw new AppError('Đường dẫn vị trí nhận nội dung không hợp lệ.', 400);
    assertUuid(item, 'Vị trí nhận nội dung');
    return item;
  });
}

export function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(`${label} không hợp lệ`, 400);
  }
}

export function asNumber(value: string | number | null | undefined): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function safeTransferFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) return TENANT_DATA_LIMIT_REACHED_MESSAGE;
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) return TENANT_DATA_QUOTA_RECONCILING_MESSAGE;
  if (error instanceof AppError) return error.message;
  return 'Hệ thống chưa thể xử lý yêu cầu chuyển nội dung. Vui lòng thử lại sau ít phút.';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Accept both current public URLs and legacy raw bucket keys. Course IDs are
 * opaque and may legitimately contain `:` and `+`, so do not constrain the
 * path to a filename-style character set here.
 */
export function normalizeCourseOutlineTransferStoragePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1_200) return null;

  let extracted: string | null;
  try {
    extracted = extractStoragePath(raw);
  } catch {
    return null;
  }

  const path = extracted?.split(/[?#]/, 1)[0] || '';
  if (!path || path.length > 1_200) return null;
  if (path.startsWith('/') || path.includes('//') || path.includes('..') || /[\s<>"'`\\]/.test(path)) return null;
  return path;
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, output);
  }
}

export function collectReferencedAssetPaths(payloadRows: PayloadRow[], tenantId: string): Set<string> {
  // A quota-neutral move intentionally retains the physical object key. A
  // component moved for a second time can therefore reference an older course
  // segment, while its authoritative course_assets row belongs to this source
  // course. Discover every tenant-owned course key here; the tenant+course
  // asset lookup below remains the ownership boundary.
  const tenantCoursePrefix = `${tenantId}/courses/`;
  const matcher = new RegExp(`${escapeRegExp(tenantCoursePrefix)}[^\\s"'<>()\\[\\]{}]+`, 'g');
  const paths = new Set<string>();
  for (const row of payloadRows) {
    const strings: string[] = [];
    collectStringValues(row.data, strings);
    // AI ID author notes are not copied (see finishDuplicate), so their text
    // can never require a destination asset copy.
    collectStringValues(withoutServerOwnedAuthorNotes(row.metadata), strings);
    collectStringValues(row.published_data, strings);
    collectStringValues(withoutServerOwnedAuthorNotes(row.published_metadata), strings);
    for (const value of strings) {
      const direct = normalizeCourseOutlineTransferStoragePath(value);
      if (direct?.startsWith(tenantCoursePrefix)) paths.add(direct);
      for (const match of value.matchAll(matcher)) {
        const candidate = match[0].split(/[?#]/, 1)[0].replace(/[.,;:!?]+$/, '');
        if (candidate.startsWith(tenantCoursePrefix)) paths.add(candidate);
      }
    }
  }
  return paths;
}
