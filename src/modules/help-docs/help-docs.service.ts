// ═══════════════════════════════════════════════════════════════
// Help Docs Service — Folders + Pages + Image upload
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';

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
  return { success: true, id: result.rows[0].id, slug: result.rows[0].slug };
}

export async function updateFolder(folderId: string, input: { title?: string; icon?: string }) {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;
  if (input.title !== undefined) { sets.push(`title = $${idx++}`); params.push(input.title); sets.push(`slug = $${idx++}`); params.push(input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }
  if (input.icon !== undefined) { sets.push(`icon = $${idx++}`); params.push(input.icon); }
  params.push(folderId);
  const result = await query(`UPDATE help_folders SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id`, params);
  if (result.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  return { success: true };
}

export async function deleteFolder(folderId: string) {
  const result = await query('DELETE FROM help_folders WHERE id = $1 RETURNING id', [folderId]);
  if (result.rowCount === 0) throw new AppError('Folder không tồn tại', 404);
  return { success: true };
}

export async function reorderFolders(orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await query('UPDATE help_folders SET sort_order = $1 WHERE id = $2', [i, orderedIds[i]]);
  }
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
  return { success: true, id: result.rows[0].id, slug: result.rows[0].slug };
}

export async function updatePage(pageId: string, input: { title?: string; content?: string; is_published?: boolean }, userId: string) {
  const sets: string[] = ['updated_at = NOW()', `updated_by = '${userId}'`];
  const params: unknown[] = [];
  let idx = 1;
  if (input.title !== undefined) { sets.push(`title = $${idx++}`); params.push(input.title); sets.push(`slug = $${idx++}`); params.push(input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }
  if (input.content !== undefined) { sets.push(`content = $${idx++}`); params.push(input.content); }
  if (input.is_published !== undefined) { sets.push(`is_published = $${idx++}`); params.push(input.is_published); }
  params.push(pageId);
  const result = await query(`UPDATE help_pages SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id`, params);
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);
  return { success: true };
}

export async function deletePage(pageId: string) {
  const result = await query('DELETE FROM help_pages WHERE id = $1 RETURNING id', [pageId]);
  if (result.rowCount === 0) throw new AppError('Page không tồn tại', 404);
  return { success: true };
}

export async function reorderPages(folderId: string, orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await query('UPDATE help_pages SET sort_order = $1 WHERE id = $2 AND folder_id = $3', [i, orderedIds[i], folderId]);
  }
  return { success: true };
}
