// ═══════════════════════════════════════════════════════════════
// Help Docs Service — Folders + Pages + Image upload
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { extractStoragePath } from '../../config/storage.js';
import { AppError } from '../../middleware/error-handler.js';

interface HelpDocMutationResult {
  id: string;
  title: string;
  storagePathsToDelete: string[];
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
  const result = await query<{ content: string | null }>(
    `SELECT hp.content
     FROM help_pages hp
     JOIN help_folders hf ON hf.id = hp.folder_id
     WHERE hf.tenant_id = $1`,
    [tenantId],
  );

  const referenced = new Set<string>();
  for (const row of result.rows) {
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

export async function listFolders(tenantId: string | null) {
  const params: unknown[] = [];
  let where = '';
  if (tenantId) { params.push(tenantId); where = 'WHERE hf.tenant_id = $1'; }

  const result = await query(
    `SELECT hf.*, (SELECT COUNT(*) FROM help_pages hp WHERE hp.folder_id = hf.id) AS page_count
     FROM help_folders hf ${where}
     ORDER BY hf.sort_order, hf.title`,
    params,
  );
  return { folders: result.rows, total: result.rowCount || 0 };
}

export async function createFolder(tenantId: string, input: { title: string; icon?: string }) {
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await query(
    'INSERT INTO help_folders (tenant_id, title, slug, icon) VALUES ($1, $2, $3, $4) RETURNING id, slug',
    [tenantId, input.title, slug, input.icon || 'BookOpen'],
  );
  return { success: true, id: result.rows[0].id, slug: result.rows[0].slug, title: input.title };
}

export async function updateFolder(folderId: string, input: { title?: string; icon?: string }) {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;
  if (input.title !== undefined) { sets.push(`title = $${idx++}`); params.push(input.title); sets.push(`slug = $${idx++}`); params.push(input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }
  if (input.icon !== undefined) { sets.push(`icon = $${idx++}`); params.push(input.icon); }
  params.push(folderId);
  const result = await query(`UPDATE help_folders SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, title`, params);
  if (result.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  return result.rows[0];
}

export async function deleteFolder(folderId: string, tenantId: string): Promise<HelpDocMutationResult> {
  const folder = await query<{ id: string; title: string }>(
    'SELECT id, title FROM help_folders WHERE id = $1 AND tenant_id = $2',
    [folderId, tenantId],
  );
  if (folder.rowCount === 0) throw new AppError('Folder không tồn tại', 404);

  const pages = await query<{ content: string | null }>(
    'SELECT content FROM help_pages WHERE folder_id = $1',
    [folderId],
  );
  const candidatePaths = pages.rows.flatMap((row) => extractHelpDocImagePaths(row.content, tenantId));

  await query('DELETE FROM help_folders WHERE id = $1 AND tenant_id = $2', [folderId, tenantId]);

  return {
    ...folder.rows[0],
    storagePathsToDelete: await getUnreferencedHelpDocImagePaths(tenantId, candidatePaths),
  };
}

export async function reorderFolders(tenantId: string, orderedIds: string[]) {
  if (orderedIds.length === 0) return { success: true };

  const eligible = await query<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM help_folders WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [tenantId, orderedIds],
  );
  if (Number(eligible.rows[0]?.count || 0) !== orderedIds.length) {
    throw new AppError('Một hoặc nhiều folder không thuộc tenant hiện tại', 404);
  }

  await query(
    `UPDATE help_folders hf
     SET sort_order = (ordered.sort_order - 1)::int, updated_at = NOW()
     FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, sort_order)
     WHERE hf.id = ordered.id
       AND hf.tenant_id = $1`,
    [tenantId, orderedIds],
  );
  return { success: true };
}

// ═══ Pages ═══

export async function listPages(folderId?: string) {
  let where = '';
  const params: unknown[] = [];
  if (folderId) { params.push(folderId); where = 'WHERE hp.folder_id = $1'; }

  const result = await query(
    `SELECT hp.id, hp.folder_id, hf.title AS folder_title, hp.title, hp.slug,
            hp.sort_order, hp.is_published, hp.created_at, hp.updated_at
     FROM help_pages hp
     JOIN help_folders hf ON hf.id = hp.folder_id
     ${where}
     ORDER BY hp.sort_order, hp.title`,
    params,
  );
  return { pages: result.rows, total: result.rowCount || 0 };
}

export async function getPage(pageId: string) {
  const result = await query(
    `SELECT hp.*, hf.title AS folder_title,
            cu.username AS created_by, uu.username AS updated_by
     FROM help_pages hp
     JOIN help_folders hf ON hf.id = hp.folder_id
     LEFT JOIN users cu ON cu.id = hp.created_by
     LEFT JOIN users uu ON uu.id = hp.updated_by
     WHERE hp.id = $1`,
    [pageId],
  );
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);
  return result.rows[0];
}

export async function createPage(input: { folder_id: string; title: string; content?: string }, userId: string) {
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await query(
    `INSERT INTO help_pages (folder_id, title, slug, content, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id, slug`,
    [input.folder_id, input.title, slug, input.content || '', userId],
  );
  return { success: true, id: result.rows[0].id, slug: result.rows[0].slug, title: input.title };
}

export async function updatePage(
  pageId: string,
  tenantId: string,
  input: { title?: string; content?: string; is_published?: boolean },
  userId: string,
): Promise<HelpDocMutationResult> {
  const current = await query<{ id: string; title: string; content: string | null }>(
    `SELECT hp.id, hp.title, hp.content
     FROM help_pages hp
     JOIN help_folders hf ON hf.id = hp.folder_id
     WHERE hp.id = $1 AND hf.tenant_id = $2`,
    [pageId, tenantId],
  );
  if (current.rowCount === 0) throw new AppError('Page không tồn tại', 404);

  const sets: string[] = ['updated_at = NOW()', 'updated_by = $1'];
  const params: unknown[] = [userId];
  let idx = 2;
  if (input.title !== undefined) { sets.push(`title = $${idx++}`); params.push(input.title); sets.push(`slug = $${idx++}`); params.push(input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }
  if (input.content !== undefined) { sets.push(`content = $${idx++}`); params.push(input.content); }
  if (input.is_published !== undefined) { sets.push(`is_published = $${idx++}`); params.push(input.is_published); }
  params.push(pageId, tenantId);

  const result = await query<{ id: string; title: string }>(
    `UPDATE help_pages hp
     SET ${sets.join(', ')}
     FROM help_folders hf
     WHERE hp.folder_id = hf.id
       AND hp.id = $${idx++}
       AND hf.tenant_id = $${idx}
     RETURNING hp.id, hp.title`,
    params,
  );
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);

  const removedPaths = input.content === undefined
    ? []
    : extractHelpDocImagePaths(current.rows[0].content, tenantId)
        .filter((path) => !extractHelpDocImagePaths(input.content, tenantId).includes(path));

  return {
    ...result.rows[0],
    storagePathsToDelete: await getUnreferencedHelpDocImagePaths(tenantId, removedPaths),
  };
}

export async function deletePage(pageId: string, tenantId: string): Promise<HelpDocMutationResult> {
  const result = await query<{ id: string; title: string; content: string | null }>(
    `DELETE FROM help_pages hp
     USING help_folders hf
     WHERE hp.folder_id = hf.id
       AND hp.id = $1
       AND hf.tenant_id = $2
     RETURNING hp.id, hp.title, hp.content`,
    [pageId, tenantId],
  );
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
  const folder = await query<{ id: string }>(
    'SELECT id FROM help_folders WHERE id = $1 AND tenant_id = $2',
    [folderId, tenantId],
  );
  if (folder.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  if (orderedIds.length === 0) return { success: true };

  const eligible = await query<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM help_pages WHERE folder_id = $1 AND id = ANY($2::uuid[])',
    [folderId, orderedIds],
  );
  if (Number(eligible.rows[0]?.count || 0) !== orderedIds.length) {
    throw new AppError('Một hoặc nhiều trang không thuộc folder hiện tại', 404);
  }

  await query(
    `UPDATE help_pages hp
     SET sort_order = (ordered.sort_order - 1)::int, updated_at = NOW()
     FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, sort_order)
     WHERE hp.id = ordered.id
       AND hp.folder_id = $1`,
    [folderId, orderedIds],
  );
  return { success: true };
}
