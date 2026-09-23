import { extractStoragePath } from '../../config/storage.js';

export type CourseMentorLogoOwnership =
  | { kind: 'course-owned'; storagePath: string }
  | { kind: 'tenant-branding'; storagePath: string }
  | { kind: 'empty' }
  | {
      kind: 'unknown';
      reason: 'invalid-owner' | 'invalid-storage-path' | 'foreign-or-untrusted-tenant-path' | 'unrecognized-tenant-path';
      storagePath?: string;
    };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSafeCourseId(courseId: string): boolean {
  return courseId.length > 0
    && courseId.length <= 255
    && !courseId.includes('..')
    && !/[<>"'`\\/]/.test(courseId);
}

function normalizeStoragePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1200) return null;
  const path = extractStoragePath(raw);
  if (!path || path.length > 1200) return null;
  if (path.startsWith('/') || path.includes('//') || path.includes('..') || /[<>"'`\\]/.test(path)) return null;
  return path;
}

/**
 * Course mentor sections inherit tenant branding by default, but can later
 * replace it with an upload stored under this exact course.  The path is the
 * only legacy ownership signal, so classify it before any delete operation.
 */
export function classifyCourseMentorLogoOwnership(
  value: unknown,
  tenantId: string,
  courseId: string,
): CourseMentorLogoOwnership {
  if (value == null || value === '') return { kind: 'empty' };
  if (!UUID_PATTERN.test(tenantId) || !isSafeCourseId(courseId)) {
    return { kind: 'unknown', reason: 'invalid-owner' };
  }

  const storagePath = normalizeStoragePath(value);
  if (!storagePath) return { kind: 'unknown', reason: 'invalid-storage-path' };

  const tenantPrefix = `${tenantId}/`;
  if (!storagePath.startsWith(tenantPrefix)) {
    return { kind: 'unknown', reason: 'foreign-or-untrusted-tenant-path', storagePath };
  }

  if (storagePath.startsWith(`${tenantId}/branding/`)) {
    return { kind: 'tenant-branding', storagePath };
  }

  if (storagePath.startsWith(`${tenantId}/courses/${courseId}/`)) {
    return { kind: 'course-owned', storagePath };
  }

  return { kind: 'unknown', reason: 'unrecognized-tenant-path', storagePath };
}
