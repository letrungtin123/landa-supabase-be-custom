// ═══════════════════════════════════════════════════════════════
// KB Service — Knowledge Base + Document CRUD
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { uploadFile, buildStoragePath, buildFileName, deleteFile } from '../../config/storage.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import type { CreateKbInput, UpdateKbInput, CreateArticleInput, UpdateArticleInput } from './kb.validator.js';
import * as XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env.js';

const LOCAL_SOURCE_CONTENT_EXTENSIONS = new Set(['.txt', '.md', '.csv']);
const MAX_STORED_SOURCE_CONTENT_CHARS = 200_000;

function extractLocalSourceContent(ext: string, buffer: Buffer): string | null {
  if (!LOCAL_SOURCE_CONTENT_EXTENSIONS.has(ext)) return null;
  const text = buffer.toString('utf8').replace(/\u0000/g, '').trim();
  return text ? text.slice(0, MAX_STORED_SOURCE_CONTENT_CHARS) : null;
}

// ── Types ──
export interface Knowledgebase {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  document_count?: number;
}

export interface KbDocument {
  id: string;
  tenant_id: string;
  kb_id: string;
  type: string;
  name: string;
  status: string;
  error_reason: string | null;
  source_info: Record<string, unknown>;
  file_path: string | null;
  content: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════
// Knowledge Base CRUD
// ═══════════════════════════════════════

export async function listKnowledgebases(
  tenantId: string,
  opts: { page?: number; pageSize?: number; search?: string } = {},
): Promise<{ data: Knowledgebase[]; total: number }> {
  const { page = 1, pageSize = 10, search } = opts;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ['kb.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (search?.trim()) {
    conditions.push(`kb.name ILIKE $${idx++}`);
    params.push(`%${search.trim()}%`);
  }

  const where = conditions.join(' AND ');
  params.push(pageSize, offset);

  const result = await query<Knowledgebase & { full_count: string }>(
    `SELECT kb.*, COALESCE(dc.cnt, 0)::int AS document_count,
            COUNT(*) OVER() AS full_count
     FROM knowledgebases kb
     LEFT JOIN (
       SELECT kb_id, COUNT(*)::int AS cnt FROM kb_documents GROUP BY kb_id
     ) dc ON dc.kb_id = kb.id
     WHERE ${where}
     ORDER BY kb.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');
  const data = result.rows.map(r => {
    const { full_count, ...rest } = r;
    return rest as unknown as Knowledgebase;
  });

  return { data, total };
}

export async function getKnowledgebase(id: string, tenantId: string): Promise<Knowledgebase | null> {
  const result = await query<Knowledgebase>(
    `SELECT * FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return result.rows[0] || null;
}

export async function createKnowledgebase(tenantId: string, input: CreateKbInput, userId: string): Promise<Knowledgebase> {
  const result = await query<Knowledgebase>(
    `INSERT INTO knowledgebases (tenant_id, name, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tenantId, input.name, input.description || '', userId],
  );
  return result.rows[0];
}

export async function updateKnowledgebase(id: string, tenantId: string, input: UpdateKbInput): Promise<Knowledgebase | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  sets.push(`updated_at = now()`);

  if (sets.length <= 1) return getKnowledgebase(id, tenantId); // nothing to update

  params.push(id, tenantId);
  const result = await query<Knowledgebase>(
    `UPDATE knowledgebases SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx++} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function deleteKnowledgebase(id: string, tenantId: string): Promise<boolean> {
  // Check if any bot references this KB
  const botCheck = await query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM chatbots WHERE kb_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (botCheck.rows[0]?.cnt > 0) {
    throw new Error(`Không thể xoá KB — đang có ${botCheck.rows[0].cnt} bot sử dụng`);
  }

  // Get all document file paths to cleanup storage
  const docs = await query<{ file_path: string | null }>(
    `SELECT file_path FROM kb_documents WHERE kb_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );

  // Get gemini paths to delete from store
  const geminiPaths = await query<{ gemini_path: string }>(
    `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.kb_id = $1 AND d.tenant_id = $2`,
    [id, tenantId],
  );

  // 1. Delete from Gemini FIRST (synchronous)
  if (geminiPaths.rowCount && geminiPaths.rowCount > 0) {
    try {
      const aiClient = await (await import('./gemini.service.js')).getGeminiClient(tenantId);
      const { deleteFromStore } = await import('./gemini.service.js');
      await deleteFromStore(geminiPaths.rows.map(r => r.gemini_path), aiClient);
    } catch (err: any) {
      console.error(`[DeleteKB] Gemini delete failed for KB ${id}, continuing:`, err.message);
    }
  }

  // 2. Delete KB from DB (CASCADE → kb_documents → kb_doc_gemini_mapping + kb_google_store)
  const result = await query(
    `DELETE FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );

  // 3. Cleanup storage files (non-critical)
  for (const doc of docs.rows) {
    if (doc.file_path) {
      try { await deleteFile(doc.file_path); } catch { /* ignore */ }
    }
  }

  return (result.rowCount || 0) > 0;
}

// ═══════════════════════════════════════
// Document CRUD
// ═══════════════════════════════════════

interface ListDocumentsOptions {
  kbId: string;
  tenantId: string;
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  type?: string;
}

export async function listDocuments(opts: ListDocumentsOptions): Promise<{ data: KbDocument[]; total: number }> {
  const { kbId, tenantId, page = 1, pageSize = 20, search, status, type } = opts;
  const offset = (page - 1) * pageSize;

  // Build WHERE dynamically — always filter by kb_id + tenant_id
  const conditions: string[] = ['kb_id = $1', 'tenant_id = $2'];
  const params: unknown[] = [kbId, tenantId];
  let idx = 3;

  if (search?.trim()) {
    conditions.push(`name ILIKE $${idx++}`);
    params.push(`%${search.trim()}%`);
  }
  if (status?.trim()) {
    conditions.push(`status = $${idx++}`);
    params.push(status.trim());
  }
  if (type?.trim()) {
    conditions.push(`type = $${idx++}`);
    params.push(type.trim());
  }

  const where = conditions.join(' AND ');

  // Single query with window function COUNT(*) OVER() — more efficient than 2 queries
  params.push(pageSize, offset);
  const result = await query<KbDocument & { full_count: string }>(
    `SELECT *, COUNT(*) OVER() AS full_count
     FROM kb_documents
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');
  const data = result.rows.map(r => {
    const { full_count, ...rest } = r;
    return rest as unknown as KbDocument;
  });

  return { data, total };
}

export async function getDocument(docId: string, tenantId: string): Promise<KbDocument | null> {
  const result = await query<KbDocument>(
    `SELECT * FROM kb_documents WHERE id = $1 AND tenant_id = $2`,
    [docId, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * Upload a document file: insert record → upload to storage → enqueue Gemini job.
 */
export async function uploadDocument(
  kbId: string,
  tenantId: string,
  userId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<KbDocument> {
  const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();

  // 1. Insert document record (status=draft)
  const sourceInfo = {
    name: file.originalname,
    size: file.size,
    extension: ext,
    mime_type: file.mimetype,
  };
  const localContent = extractLocalSourceContent(ext, file.buffer);

  const insertResult = await query<KbDocument>(
    `INSERT INTO kb_documents (tenant_id, kb_id, type, name, status, source_info, content, created_by)
     VALUES ($1, $2, 'file', $3, 'draft', $4, $5, $6)
     RETURNING *`,
    [tenantId, kbId, file.originalname, JSON.stringify(sourceInfo), localContent, userId],
  );
  const doc = insertResult.rows[0];

  // 2. Upload to Supabase Storage
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeFileName = buildFileName(file.originalname);
  const storagePath = buildStoragePath(tenantId, 'kb-files', safeFileName, dateFolder);

  await uploadFile(storagePath, file.buffer, file.mimetype);

  // 3. Update document with file_path + status=learning
  await query(
    `UPDATE kb_documents SET file_path = $1, status = 'learning', updated_at = now() WHERE id = $2`,
    [storagePath, doc.id],
  );

  // 4. Enqueue Gemini upload job
  await publish(QUEUES.GEMINI_UPLOAD, {
    documentId: doc.id,
    kbId,
    tenantId,
    mode: 'file',
  });

  return { ...doc, file_path: storagePath, status: 'learning' };
}

/**
 * Delete a single document.
 * Order: Gemini → DB → Storage (prevents orphan docs on Gemini)
 */
export async function deleteDocument(docId: string, kbId: string, tenantId: string): Promise<boolean> {
  // 1. Get gemini mappings + doc info BEFORE deleting anything
  const mappings = await query<{ gemini_path: string }>(
    `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.id = $1 AND d.kb_id = $2 AND d.tenant_id = $3`,
    [docId, kbId, tenantId],
  );
  const doc = await getDocument(docId, tenantId);
  if (!doc) return false;
  if (doc.status === 'learning') throw new Error('Không thể xoá tài liệu đang được huấn luyện');

  // 2. Delete from Gemini FIRST (synchronous, not queue)
  if (mappings.rowCount && mappings.rowCount > 0) {
    try {
      const aiClient = await (await import('./gemini.service.js')).getGeminiClient(tenantId);
      const { deleteFromStore } = await import('./gemini.service.js');
      await deleteFromStore(mappings.rows.map(r => r.gemini_path), aiClient);
    } catch (err: any) {
      console.error(`[Delete] Gemini delete failed for doc ${docId}, continuing DB cleanup:`, err.message);
      // Still continue — better to lose Gemini mapping than have orphan DB records
    }
  }

  // 3. Delete from DB (CASCADE handles mapping table)
  const result = await query(
    `DELETE FROM kb_documents WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
    [docId, kbId, tenantId],
  );

  // 4. Cleanup storage (non-critical)
  if (doc.file_path) {
    try { await deleteFile(doc.file_path); } catch { /* ignore */ }
  }

  return (result.rowCount || 0) > 0;
}

/**
 * Bulk delete multiple documents in one operation.
 * Order: Gemini → DB → Storage (prevents orphan docs on Gemini)
 */
export async function bulkDeleteDocuments(
  docIds: string[],
  kbId: string,
  tenantId: string,
): Promise<{ deleted: number }> {
  if (docIds.length === 0) return { deleted: 0 };

  // Filter out docs that are currently learning
  const statusCheck = await query<{ id: string; status: string }>(
    `SELECT id, status FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
    [docIds, kbId, tenantId],
  );
  const learningIds = statusCheck.rows.filter(r => r.status === 'learning').map(r => r.id);
  const safeIds = docIds.filter(id => !learningIds.includes(id));
  if (safeIds.length === 0) throw new Error('Tất cả tài liệu đang được huấn luyện, không thể xoá');

  // 1. Get all gemini paths in a single query
  const mappings = await query<{ gemini_path: string }>(
    `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.id = ANY($1) AND d.kb_id = $2 AND d.tenant_id = $3`,
    [safeIds, kbId, tenantId],
  );

  // 2. Get all file paths in a single query
  const filePaths = await query<{ id: string; file_path: string | null }>(
    `SELECT id, file_path FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
    [safeIds, kbId, tenantId],
  );

  // 3. Delete from Gemini FIRST (synchronous)
  if (mappings.rowCount && mappings.rowCount > 0) {
    try {
      const aiClient = await (await import('./gemini.service.js')).getGeminiClient(tenantId);
      const { deleteFromStore } = await import('./gemini.service.js');
      await deleteFromStore(mappings.rows.map(r => r.gemini_path), aiClient);
    } catch (err: any) {
      console.error(`[BulkDelete] Gemini delete failed, continuing DB cleanup:`, err.message);
    }
  }

  // 4. Bulk delete from DB
  const result = await query(
    `DELETE FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
    [safeIds, kbId, tenantId],
  );

  // 5. Cleanup storage files (non-critical)
  for (const f of filePaths.rows) {
    if (f.file_path) {
      try { await deleteFile(f.file_path); } catch { /* ignore */ }
    }
  }

  return { deleted: result.rowCount || 0 };
}

/**
 * Retry failed documents — reset to 'learning' and re-enqueue Gemini upload.
 * Only retries documents with status = 'error' that still have file_path.
 */
export async function retryDocuments(
  docIds: string[],
  kbId: string,
  tenantId: string,
): Promise<{ retried: number }> {
  if (docIds.length === 0) return { retried: 0 };

  // 1. Find eligible docs (status=error, has file_path)
  const eligible = await query<{ id: string; file_path: string }>(
    `SELECT id, file_path FROM kb_documents
     WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3
       AND status = 'error' AND file_path IS NOT NULL`,
    [docIds, kbId, tenantId],
  );

  if (!eligible.rowCount || eligible.rowCount === 0) return { retried: 0 };

  const eligibleIds = eligible.rows.map(r => r.id);

  // 2. Clear old gemini mappings (if any partial uploads)
  await query(
    `DELETE FROM kb_doc_gemini_mapping WHERE document_id = ANY($1)`,
    [eligibleIds],
  );

  // 3. Reset status to 'learning', clear error
  await query(
    `UPDATE kb_documents SET status = 'learning', error_reason = NULL, updated_at = now()
     WHERE id = ANY($1)`,
    [eligibleIds],
  );

  // 4. Enqueue each doc individually (worker processes 1 at a time via prefetch)
  for (const doc of eligible.rows) {
    await publish(QUEUES.GEMINI_UPLOAD, {
      documentId: doc.id,
      kbId,
      tenantId,
      mode: 'file',
    });
  }

  return { retried: eligibleIds.length };
}

/**
 * Update document status (used by workers).
 */
export async function updateDocumentStatus(
  docId: string,
  status: 'draft' | 'learning' | 'learned' | 'error',
  errorReason?: string,
): Promise<void> {
  await query(
    `UPDATE kb_documents SET status = $1, error_reason = $2, updated_at = now() WHERE id = $3`,
    [status, errorReason || null, docId],
  );
}

/**
 * Link a document with its Gemini file search mapping.
 */
export async function linkDocumentGemini(
  documentId: string,
  storeId: string,
  geminiPath: string,
): Promise<void> {
  // Anti-race: check if mapping already exists
  const existing = await query<{ id: string }>(
    `SELECT id FROM kb_doc_gemini_mapping WHERE document_id = $1 LIMIT 1`,
    [documentId],
  );
  if (existing.rowCount && existing.rowCount > 0) return; // Already linked

  await query(
    `INSERT INTO kb_doc_gemini_mapping (document_id, store_id, gemini_path) VALUES ($1, $2, $3)`,
    [documentId, storeId, geminiPath],
  );
}

// ═══════════════════════════════════════
// FAQ Upload
// ═══════════════════════════════════════

/**
 * Validate & upload an FAQ xlsx file.
 * Checks template: Sheet 1 must have headers "Question" and "Answer".
 */
export async function uploadFaqDocument(
  kbId: string,
  tenantId: string,
  userId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<KbDocument> {
  // 1. Parse xlsx
  const workbook = XLSX.read(file.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('File xlsx không có sheet nào');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  // 2. Validate headers
  if (rows.length === 0) throw new Error('File xlsx trống, không có dữ liệu');

  const firstRow = rows[0];
  const headers = Object.keys(firstRow);
  const hasQuestion = headers.some(h => h.trim().toLowerCase() === 'question');
  const hasAnswer = headers.some(h => h.trim().toLowerCase() === 'answer');

  if (!hasQuestion || !hasAnswer) {
    throw new Error(
      `File không đúng template. Cần có 2 cột "Question" và "Answer". ` +
      `Cột hiện tại: ${headers.join(', ')}. Vui lòng tải template mẫu.`
    );
  }

  // 3. Validate rows — each must have both Q and A
  const qKey = headers.find(h => h.trim().toLowerCase() === 'question')!;
  const aKey = headers.find(h => h.trim().toLowerCase() === 'answer')!;
  let emptyRows = 0;
  for (let i = 0; i < rows.length; i++) {
    const q = String(rows[i][qKey] || '').trim();
    const a = String(rows[i][aKey] || '').trim();
    if (!q || !a) emptyRows++;
  }
  if (emptyRows > 0) {
    console.warn(`[FAQ] ${emptyRows} rows có Question hoặc Answer trống, sẽ bị bỏ qua khi train`);
  }

  // 4. Insert document record
  const sourceInfo = {
    name: file.originalname,
    size: file.size,
    extension: '.xlsx',
    mime_type: file.mimetype,
    row_count: rows.length,
    valid_rows: rows.length - emptyRows,
  };

  const insertResult = await query<KbDocument>(
    `INSERT INTO kb_documents (tenant_id, kb_id, type, name, status, source_info, created_by)
     VALUES ($1, $2, 'faq', $3, 'draft', $4, $5)
     RETURNING *`,
    [tenantId, kbId, file.originalname, JSON.stringify(sourceInfo), userId],
  );
  const doc = insertResult.rows[0];

  // 5. Upload xlsx to Supabase Storage
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeFileName = buildFileName(file.originalname);
  const storagePath = buildStoragePath(tenantId, 'kb-faqs', safeFileName, dateFolder);
  await uploadFile(storagePath, file.buffer, file.mimetype);

  // 6. Update status + file_path
  await query(
    `UPDATE kb_documents SET file_path = $1, status = 'learning', updated_at = now() WHERE id = $2`,
    [storagePath, doc.id],
  );

  // 7. Enqueue Gemini upload
  await publish(QUEUES.GEMINI_UPLOAD, {
    documentId: doc.id,
    kbId,
    tenantId,
    mode: 'faq',
  });

  return { ...doc, file_path: storagePath, status: 'learning' };
}

/**
 * Generate FAQ template xlsx buffer (in-memory).
 */
export function generateFaqTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Question', 'Answer'],
    ['Sản phẩm này giá bao nhiêu?', 'Sản phẩm có giá 500.000 VNĐ.'],
    ['Thời gian giao hàng bao lâu?', 'Giao hàng từ 3-5 ngày làm việc.'],
  ]);
  // Set column widths
  ws['!cols'] = [{ wch: 40 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, 'FAQs');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ═══════════════════════════════════════
// Article CRUD
// ═══════════════════════════════════════

/**
 * Simple HTML → Markdown converter.
 * Strips images (Gemini can't learn from images), keeps text structure.
 */
function htmlToMarkdown(html: string): string {
  let md = html;
  // Remove images (Gemini can't learn from them)
  md = md.replace(/<img[^>]*>/gi, '');
  // Headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
  // Bold / Italic
  md = md.replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*');
  // Lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');
  // Links
  md = md.replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  // Paragraphs / breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<p[^>]*>/gi, '');
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // Decode entities
  md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

/**
 * Create an article: convert HTML → .md → upload to Storage → enqueue Gemini.
 */
export async function uploadArticle(
  kbId: string,
  tenantId: string,
  userId: string,
  input: CreateArticleInput,
): Promise<KbDocument> {
  const markdown = `# ${input.title}\n\n${htmlToMarkdown(input.content)}\n`;

  // 1. Insert document record
  const insertResult = await query<KbDocument>(
    `INSERT INTO kb_documents (tenant_id, kb_id, type, name, status, content, source_info, created_by)
     VALUES ($1, $2, 'article', $3, 'draft', $4, $5, $6)
     RETURNING *`,
    [
      tenantId, kbId, input.title, input.content,
      JSON.stringify({ title: input.title, content_length: input.content.length }),
      userId,
    ],
  );
  const doc = insertResult.rows[0];

  // 2. Write .md to temp, upload to Storage
  const tempDir = env.GEMINI_TEMP_DIR || path.join(process.cwd(), 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `article-${doc.id}.md`);
  await fs.writeFile(tempPath, markdown, 'utf8');

  try {
    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const storagePath = buildStoragePath(tenantId, 'kb-articles', `${slug}-${doc.id.slice(0, 8)}.md`, dateFolder);
    const buffer = await fs.readFile(tempPath);
    await uploadFile(storagePath, buffer, 'text/markdown');

    // 3. Update document
    await query(
      `UPDATE kb_documents SET file_path = $1, status = 'learning', updated_at = now() WHERE id = $2`,
      [storagePath, doc.id],
    );

    // 4. Enqueue Gemini upload
    await publish(QUEUES.GEMINI_UPLOAD, {
      documentId: doc.id,
      kbId,
      tenantId,
      mode: 'article',
    });

    return { ...doc, file_path: storagePath, status: 'learning' };
  } finally {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
  }
}

/**
 * Update an article: update content, delete old Gemini mapping, re-upload.
 */
export async function updateArticle(
  docId: string,
  kbId: string,
  tenantId: string,
  input: UpdateArticleInput,
): Promise<KbDocument | null> {
  // 1. Get existing
  const existing = await getDocument(docId, tenantId);
  if (!existing || existing.type !== 'article' || existing.kb_id !== kbId) return null;
  if (existing.status === 'learning') throw new Error('Không thể sửa bài viết đang được huấn luyện');

  // Optimistic locking: reject if another admin has modified this doc since it was loaded
  if (input.expected_updated_at && existing.updated_at) {
    const expected = new Date(input.expected_updated_at).getTime();
    const actual = new Date(existing.updated_at).getTime();
    if (expected !== actual) {
      throw new Error('Bài viết đã được người khác chỉnh sửa. Vui lòng tải lại trang và thử lại.');
    }
  }

  const title = input.title ?? existing.name;
  const content = input.content ?? existing.content ?? '';
  const markdown = `# ${title}\n\n${htmlToMarkdown(content)}\n`;

  // 2. Delete old Gemini mapping
  await query(`DELETE FROM kb_doc_gemini_mapping WHERE document_id = $1`, [docId]);

  // 3. Write new .md
  const tempDir = env.GEMINI_TEMP_DIR || path.join(process.cwd(), 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `article-${docId}.md`);
  await fs.writeFile(tempPath, markdown, 'utf8');

  try {
    // Delete old storage file
    if (existing.file_path) {
      try { await deleteFile(existing.file_path); } catch { /* ignore */ }
    }

    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const storagePath = buildStoragePath(tenantId, 'kb-articles', `${slug}-${docId.slice(0, 8)}.md`, dateFolder);
    const buffer = await fs.readFile(tempPath);
    await uploadFile(storagePath, buffer, 'text/markdown');

    // 4. Update document
    await query(
      `UPDATE kb_documents SET name = $1, content = $2, file_path = $3, status = 'learning',
       source_info = $4, error_reason = NULL, updated_at = now()
       WHERE id = $5`,
      [title, content, storagePath, JSON.stringify({ title, content_length: content.length }), docId],
    );

    // 5. Re-enqueue
    await publish(QUEUES.GEMINI_UPLOAD, {
      documentId: docId,
      kbId,
      tenantId,
      mode: 'article',
    });

    return { ...existing, name: title, content, file_path: storagePath, status: 'learning' };
  } finally {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
  }
}
