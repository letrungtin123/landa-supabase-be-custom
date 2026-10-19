// ═══════════════════════════════════════════════════════════════
// Help Docs Service — Folders + Pages + Image upload
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { extractStoragePath } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { createHelpDocsRepository, type HelpDocsDb } from './help-docs.repository.js';

const helpDocsRepository = createHelpDocsRepository({ query } satisfies HelpDocsDb);

interface HelpDocMutationResult {
  id: string;
  title: string;
  storagePathsToDelete: string[];
  previousTitle?: string;
  previousPublished?: boolean;
}

const STORAGE_PROXY_PREFIX = '/api/storage/';

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function extractProxyStoragePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

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

function normalizeHelpDocImagePath(value: string | null | undefined, tenantId: string): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;

  const path = extractStoragePath(extractProxyStoragePath(raw) || raw)?.trim();
  if (!path) return null;

  const expectedPrefix = `${tenantId}/help-docs/`;
  if (!path.startsWith(expectedPrefix)) return null;
  if (path.includes('..') || path.includes('//') || /[<>"|?*]/.test(path)) return null;

  return path;
}

function extractHelpDocImagePaths(html: string | null | undefined, tenantId: string): string[] {
  if (!html) return [];

  const paths = new Set<string>();
  const imgSrcPattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;

  while ((match = imgSrcPattern.exec(html)) !== null) {
    const rawSrc = match[1] || match[2] || match[3] || '';
    const storagePath = normalizeHelpDocImagePath(rawSrc, tenantId);
    if (storagePath) paths.add(storagePath);
  }

  return [...paths];
}

async function getReferencedHelpDocImagePaths(tenantId: string): Promise<Set<string>> {
  const rows = await helpDocsRepository.selectTenantPageContents(tenantId);

  const referenced = new Set<string>();
  for (const row of rows) {
    for (const path of extractHelpDocImagePaths(row.content, tenantId)) {
      referenced.add(path);
    }
  }
  return referenced;
}

async function getUnreferencedHelpDocImagePaths(tenantId: string, candidatePaths: string[]): Promise<string[]> {
  const candidates = uniqueStrings(candidatePaths);
  if (candidates.length === 0) return [];

  const referenced = await getReferencedHelpDocImagePaths(tenantId);
  return candidates.filter((path) => !referenced.has(path));
}

// ═══ Folders ═══

export async function listFolders(tenantId: string) {
  const result = await helpDocsRepository.selectFolders(tenantId);
  return { folders: result.rows, total: result.rowCount || 0 };
}

export async function createFolder(tenantId: string, input: { title: string; icon?: string }) {
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const created = await helpDocsRepository.insertFolder(tenantId, input.title, slug, input.icon || 'BookOpen');
  return { success: true, id: created.id, slug: created.slug, title: input.title };
}

export async function updateFolder(folderId: string, tenantId: string, input: { title?: string; icon?: string }) {
  const current = await helpDocsRepository.lockFolder(folderId, tenantId);
  if (current.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  const columns: Array<[string, unknown]> = [];
  if (input.title !== undefined) { columns.push(['title', input.title], ['slug', input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')]); }
  if (input.icon !== undefined) { columns.push(['icon', input.icon]); }
  const result = await helpDocsRepository.updateFolder(folderId, tenantId, columns);
  if (result.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  return { ...result.rows[0], previousTitle: current.rows[0].title };
}

export async function deleteFolder(folderId: string, tenantId: string): Promise<HelpDocMutationResult> {
  const folder = await helpDocsRepository.selectFolder(folderId, tenantId);
  if (folder.rowCount === 0) throw new AppError('Folder không tồn tại', 404);

  const pages = await helpDocsRepository.selectFolderPageContents(folderId);
  const candidatePaths = pages.flatMap((row) => extractHelpDocImagePaths(row.content, tenantId));

  await helpDocsRepository.deleteFolder(folderId, tenantId);

  return {
    ...folder.rows[0],
    storagePathsToDelete: await getUnreferencedHelpDocImagePaths(tenantId, candidatePaths),
  };
}

export async function reorderFolders(tenantId: string, orderedIds: string[]) {
  if (orderedIds.length === 0) return { success: true };

  const eligible = await helpDocsRepository.countTenantFolders(tenantId, orderedIds);
  if (Number(eligible || 0) !== orderedIds.length) {
    throw new AppError('Một hoặc nhiều folder không thuộc tenant hiện tại', 404);
  }

  await helpDocsRepository.reorderFolders(tenantId, orderedIds);
  return { success: true };
}

// ═══ Pages ═══

export async function listPages(tenantId: string, folderId?: string) {
  const result = await helpDocsRepository.selectPages(tenantId, folderId);
  return { pages: result.rows, total: result.rowCount || 0 };
}

export async function getPage(pageId: string, tenantId: string) {
  const result = await helpDocsRepository.selectPage(pageId, tenantId);
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);
  return result.rows[0];
}

export async function createPage(tenantId: string, input: { folder_id: string; title: string; content?: string }, userId: string) {
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await helpDocsRepository.insertPage({
    tenantId,
    folderId: input.folder_id,
    title: input.title,
    slug,
    content: input.content ?? '',
    userId,
  });
  if (result.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  return { success: true, id: result.rows[0].id, slug: result.rows[0].slug, title: input.title };
}

export async function updatePage(
  pageId: string,
  tenantId: string,
  input: { title?: string; content?: string; is_published?: boolean },
  userId: string,
): Promise<HelpDocMutationResult> {
  const current = await helpDocsRepository.lockPage(pageId, tenantId);
  if (current.rowCount === 0) throw new AppError('Page không tồn tại', 404);

  const columns: Array<[string, unknown]> = [];
  if (input.title !== undefined) { columns.push(['title', input.title], ['slug', input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')]); }
  if (input.content !== undefined) { columns.push(['content', input.content]); }
  if (input.is_published !== undefined) { columns.push(['is_published', input.is_published]); }

  const result = await helpDocsRepository.updatePage(pageId, tenantId, userId, columns);
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);

  const removedPaths = input.content === undefined
    ? []
    : extractHelpDocImagePaths(current.rows[0].content, tenantId)
        .filter((path) => !extractHelpDocImagePaths(input.content, tenantId).includes(path));

  return {
    ...result.rows[0],
    storagePathsToDelete: await getUnreferencedHelpDocImagePaths(tenantId, removedPaths),
    previousTitle: current.rows[0].title,
    previousPublished: current.rows[0].is_published,
  };
}

export async function deletePage(pageId: string, tenantId: string): Promise<HelpDocMutationResult> {
  const result = await helpDocsRepository.deletePage(pageId, tenantId);
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);

  const candidatePaths = extractHelpDocImagePaths(result.rows[0].content, tenantId);
  return {
    id: result.rows[0].id,
    title: result.rows[0].title,
    storagePathsToDelete: await getUnreferencedHelpDocImagePaths(tenantId, candidatePaths),
  };
}

export async function deleteImage(tenantId: string, rawPath: string): Promise<HelpDocMutationResult> {
  const storagePath = normalizeHelpDocImagePath(rawPath, tenantId);
  if (!storagePath) throw new AppError('Đường dẫn ảnh không hợp lệ', 400);

  return {
    id: storagePath,
    title: storagePath.split('/').pop() || storagePath,
    storagePathsToDelete: await getUnreferencedHelpDocImagePaths(tenantId, [storagePath]),
  };
}

export async function reorderPages(tenantId: string, folderId: string, orderedIds: string[]) {
  if (!await helpDocsRepository.folderExists(folderId, tenantId)) throw new AppError('Folder không tồn tại', 404);
  if (orderedIds.length === 0) return { success: true };

  const eligible = await helpDocsRepository.countFolderPages(folderId, orderedIds);
  if (Number(eligible || 0) !== orderedIds.length) {
    throw new AppError('Một hoặc nhiều trang không thuộc folder hiện tại', 404);
  }

  await helpDocsRepository.reorderPages(folderId, orderedIds);
  return { success: true };
}
