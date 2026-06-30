// ═══════════════════════════════════════════════════════════════
// Prompt Templates Service — System Prompt Mascot CRUD
// Only superadmin can manage. Max 6 active globally.
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { uploadFile, buildFileName, deleteFileByUrl } from '../../config/storage.js';
import type { CreateTemplateInput, UpdateTemplateInput } from './prompt-templates.validator.js';

const MAX_ACTIVE = 6;

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  avatar_url: string | null;
  fullbody_url: string | null;
  is_active: boolean;
  is_lesson_author: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── Default mascot avatars (indexed by sort_order % 6) ──
// SVG data-URIs so every template has a unique placeholder when no image is uploaded
const DEFAULT_MASCOT_COLORS = [
  '#6366f1', // indigo
  '#f43f5e', // rose
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#06b6d4', // cyan
];

/**
 * Generate a simple SVG avatar placeholder with a unique color + initial.
 */
export function getDefaultAvatar(name: string, index: number): string {
  const color = DEFAULT_MASCOT_COLORS[index % DEFAULT_MASCOT_COLORS.length];
  const initial = name.charAt(0).toUpperCase() || '?';
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" rx="64" fill="${color}"/>
      <text x="64" y="72" text-anchor="middle" font-size="56" font-family="system-ui,sans-serif" font-weight="700" fill="#fff">${initial}</text>
    </svg>`,
  )}`;
}

export function getDefaultFullbody(name: string, index: number): string {
  const color = DEFAULT_MASCOT_COLORS[index % DEFAULT_MASCOT_COLORS.length];
  const initial = name.charAt(0).toUpperCase() || '?';
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="320" viewBox="0 0 200 320">
      <rect width="200" height="320" rx="24" fill="${color}" opacity="0.15"/>
      <circle cx="100" cy="80" r="40" fill="${color}"/>
      <text x="100" y="95" text-anchor="middle" font-size="36" font-family="system-ui,sans-serif" font-weight="700" fill="#fff">${initial}</text>
      <rect x="60" y="130" width="80" height="100" rx="16" fill="${color}" opacity="0.7"/>
      <rect x="50" y="240" width="30" height="60" rx="10" fill="${color}" opacity="0.5"/>
      <rect x="120" y="240" width="30" height="60" rx="10" fill="${color}" opacity="0.5"/>
    </svg>`,
  )}`;
}

// ── CRUD ──

export async function listTemplates(): Promise<PromptTemplate[]> {
  const result = await query<PromptTemplate>(
    `SELECT * FROM system_prompt_templates ORDER BY sort_order ASC, created_at ASC`,
  );
  return result.rows;
}

export async function getTemplate(id: string): Promise<PromptTemplate | null> {
  const result = await query<PromptTemplate>(
    `SELECT * FROM system_prompt_templates WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function getActiveCount(): Promise<number> {
  const r = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM system_prompt_templates
     WHERE is_active = true AND is_lesson_author = false`,
  );
  return parseInt(r.rows[0]?.cnt || '0');
}

export async function listActiveTemplates(): Promise<PromptTemplate[]> {
  const result = await query<PromptTemplate>(
    `SELECT *
     FROM system_prompt_templates
     WHERE is_active = true AND is_lesson_author = false
     ORDER BY sort_order ASC, created_at ASC
     LIMIT ${MAX_ACTIVE}`,
  );
  return result.rows;
}

export async function getActiveLessonAuthorTemplate(): Promise<PromptTemplate | null> {
  const result = await query<PromptTemplate>(
    `SELECT *
     FROM system_prompt_templates
     WHERE is_lesson_author = true
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

async function setLessonAuthorTemplate(id: string, enabled: boolean): Promise<PromptTemplate | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query<PromptTemplate>(
      `SELECT * FROM system_prompt_templates WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    if (enabled) {
      await client.query(
        `UPDATE system_prompt_templates
         SET is_lesson_author = false, updated_at = now()
         WHERE is_lesson_author = true AND id <> $1`,
        [id],
      );
    }

    const updated = await client.query<PromptTemplate>(
      `UPDATE system_prompt_templates
       SET is_lesson_author = $2,
           is_active = CASE WHEN $2 = true THEN false ELSE is_active END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, enabled],
    );

    await client.query('COMMIT');
    return updated.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function createTemplate(input: CreateTemplateInput, userId: string): Promise<PromptTemplate> {
  // Enforce max active
  if (input.is_active && !input.is_lesson_author) {
    const activeCount = await getActiveCount();
    if (activeCount >= MAX_ACTIVE) {
      throw new Error(`Tối đa ${MAX_ACTIVE} mascot được bật cùng lúc. Hãy tắt 1 mascot trước.`);
    }
  }

  const result = await query<PromptTemplate>(
    `INSERT INTO system_prompt_templates (name, description, prompt, is_active, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.name,
      input.description || '',
      input.prompt,
      input.is_lesson_author ? false : (input.is_active || false),
      input.sort_order || 0,
      userId,
    ],
  );
  const created = result.rows[0];
  if (input.is_lesson_author) {
    const lessonAuthorTemplate = await setLessonAuthorTemplate(created.id, true);
    return lessonAuthorTemplate || created;
  }
  return created;
}

export async function updateTemplate(id: string, input: UpdateTemplateInput): Promise<PromptTemplate | null> {
  const current = await getTemplate(id);
  if (!current) return null;

  if (input.is_active === true && (current.is_lesson_author || input.is_lesson_author === true)) {
    throw new Error('Mascot chuyên gia bài học không hiển thị trong AI Chatbot. Hãy tắt cờ chuyên gia trước khi bật mascot thường.');
  }

  // Enforce max active when toggling on
  if (input.is_active === true) {
    if (current && !current.is_active) {
      const activeCount = await getActiveCount();
      if (activeCount >= MAX_ACTIVE) {
        throw new Error(`Tối đa ${MAX_ACTIVE} mascot được bật cùng lúc. Hãy tắt 1 mascot trước.`);
      }
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (input.prompt !== undefined) { sets.push(`prompt = $${idx++}`); params.push(input.prompt); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }
  if (input.sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(input.sort_order); }
  sets.push('updated_at = now()');

  if (sets.length > 1) {
    params.push(id);
    await query<PromptTemplate>(
      `UPDATE system_prompt_templates SET ${sets.join(', ')} WHERE id = $${idx++} RETURNING *`,
      params,
    );
  }

  if (input.is_lesson_author !== undefined) {
    return setLessonAuthorTemplate(id, input.is_lesson_author);
  }

  return getTemplate(id);
}

export async function deleteTemplate(id: string): Promise<boolean> {
  // Clean up storage files
  const tpl = await getTemplate(id);
  if (tpl) {
    if (tpl.avatar_url) await deleteFileByUrl(tpl.avatar_url).catch(() => {});
    if (tpl.fullbody_url) await deleteFileByUrl(tpl.fullbody_url).catch(() => {});
  }

  const result = await query(
    `DELETE FROM system_prompt_templates WHERE id = $1`,
    [id],
  );
  return (result.rowCount || 0) > 0;
}

// ── Image Uploads ──

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

function validateImage(file: { mimetype: string; size: number }): void {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new Error('Chỉ hỗ trợ JPEG, PNG, WebP, GIF');
  }
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error('File ảnh tối đa 5MB');
  }
}

export async function uploadAvatar(
  id: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<PromptTemplate | null> {
  validateImage(file);
  const tpl = await getTemplate(id);
  if (!tpl) return null;

  // Delete old
  if (tpl.avatar_url) await deleteFileByUrl(tpl.avatar_url).catch(() => {});

  const fileName = buildFileName(file.originalname);
  const storagePath = `system/prompt-mascots/avatars/${fileName}`;
  await uploadFile(storagePath, file.buffer, file.mimetype);

  const result = await query<PromptTemplate>(
    `UPDATE system_prompt_templates SET avatar_url = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [storagePath, id],
  );
  return result.rows[0] || null;
}

export async function uploadFullbody(
  id: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<PromptTemplate | null> {
  validateImage(file);
  const tpl = await getTemplate(id);
  if (!tpl) return null;

  // Delete old
  if (tpl.fullbody_url) await deleteFileByUrl(tpl.fullbody_url).catch(() => {});

  const fileName = buildFileName(file.originalname);
  const storagePath = `system/prompt-mascots/fullbody/${fileName}`;
  await uploadFile(storagePath, file.buffer, file.mimetype);

  const result = await query<PromptTemplate>(
    `UPDATE system_prompt_templates SET fullbody_url = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [storagePath, id],
  );
  return result.rows[0] || null;
}
