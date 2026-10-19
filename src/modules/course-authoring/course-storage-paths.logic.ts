// ═══════════════════════════════════════════════════════════════
// Course storage paths: which Storage paths block content references, and
// how a reference is removed from it. Pure; moved unchanged from
// course-authoring.service.ts.
// ═══════════════════════════════════════════════════════════════

import { extractStoragePath } from '../../config/storage.js';

/** A block whose draft or published content mentions a storage path. */
export interface ReferencingBlockRow {
  id: string;
  data: any;
  metadata: any;
  published_data: any;
  published_metadata: any;
}

const STORAGE_REFERENCE_KEYS = new Set(['video_storage_path', 'video_url', 'url', 'storage_path', 'pdf_url', 'src']);
const COURSE_STORAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/courses\/.+\/[^/]+$/i;

export function isCourseStoragePath(value: string): boolean {
  const storagePath = extractStoragePath(value.trim());
  return !!storagePath && COURSE_STORAGE_PATH_RE.test(storagePath);
}

export function collectCourseStoragePaths(value: any, paths: Set<string>): void {
  if (value == null) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const storagePath = extractStoragePath(trimmed);
    if (storagePath && COURSE_STORAGE_PATH_RE.test(storagePath)) {
      paths.add(storagePath);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectCourseStoragePaths(item, paths);
    return;
  }

  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectCourseStoragePaths(nested, paths);
  }
}

export function collectCourseStoragePathsFromValues(...values: any[]): Set<string> {
  const paths = new Set<string>();
  for (const value of values) collectCourseStoragePaths(value, paths);
  return paths;
}

export function valueContainsStoragePath(value: any, storagePath: string): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.includes(storagePath);
  try {
    return JSON.stringify(value).includes(storagePath);
  } catch {
    return false;
  }
}

export function stripStoragePathReference(value: any, storagePath: string): any {
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        if (item === storagePath) return false;
        if (item && typeof item === 'object') {
          if (item.url === storagePath || item.video_url === storagePath || item.storage_path === storagePath || item.src === storagePath || item.pdf_url === storagePath || item.video_storage_path === storagePath) {
            return false;
          }
        }
        return true;
      })
      .map((item) => stripStoragePathReference(item, storagePath));
  }

  if (value !== null && typeof value === 'object') {
    const next: any = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === storagePath && STORAGE_REFERENCE_KEYS.has(key)) continue;
      next[key] = stripStoragePathReference(nested, storagePath);
    }
    return next;
  }

  return value;
}

export function countPublishedReferences(blocks: ReferencingBlockRow[], storagePath: string): number {
  return blocks.filter((block) =>
    valueContainsStoragePath(block.published_data, storagePath) ||
    valueContainsStoragePath(block.published_metadata, storagePath),
  ).length;
}

export function chunkList<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
