// ═══════════════════════════════════════════════════════════════
// Prompt Templates Service — System Prompt Mascot CRUD
// Only superadmin can manage. Max 6 active globally.
// ═══════════════════════════════════════════════════════════════

import { getClient, query, withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { uploadFile, buildFileName, deleteFileByUrl } from '../../config/storage.js';
import type { CreateTemplateInput, UpdateTemplateInput } from './prompt-templates.validator.js';
import { AppError } from '../../utils/errors.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import {
  createPromptTemplatesRepository,
  type PromptTemplateRow,
  type PromptTemplatesDb,
} from './prompt-templates.repository.js';

const MAX_ACTIVE = 6;

export type PromptTemplate = PromptTemplateRow;

const templatesRepository = createPromptTemplatesRepository({ query } satisfies PromptTemplatesDb);

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
  return templatesRepository.selectAll();
}

export async function getTemplate(id: string): Promise<PromptTemplate | null> {
  return (await templatesRepository.selectById(id)) || null;
}

export async function getActiveCount(): Promise<number> {
  return parseInt((await templatesRepository.countActive()) || '0');
}

/** What any signed-in user may see of an active mascot (no prompts). */
export type PromptTemplateCard = Pick<PromptTemplate, 'id' | 'name' | 'description' | 'avatar_url' | 'fullbody_url' | 'sort_order'>;

/** Active mascots for the bot persona picker: display fields only — the
 * system prompts stay with the superadmin endpoints. */
export async function listActiveTemplates(): Promise<PromptTemplateCard[]> {
  return templatesRepository.selectActiveCards(MAX_ACTIVE);
}

export async function getActiveLessonAuthorTemplate(): Promise<PromptTemplate | null> {
  return (await templatesRepository.selectLessonAuthor()) || null;
}

async function setLessonAuthorTemplate(id: string, enabled: boolean): Promise<PromptTemplate | null> {
  // query() participates in runAuditedTransaction through AsyncLocalStorage.
  // A transaction-scoped advisory lock serializes the singleton even when no
  // current lesson-author row exists; the partial unique index remains the
  // database backstop.
  await templatesRepository.advisoryLock('system_prompt_templates:lesson_author');
  const existing = await templatesRepository.lockById(id);
  if (!existing) return null;

  if (enabled) {
    await templatesRepository.clearOtherLessonAuthors(id);
  }

  return (await templatesRepository.setLessonAuthor(id, enabled)) || null;
}

async function lockPromptTemplateCapacity(): Promise<void> {
  await templatesRepository.advisoryLock('system_prompt_templates:capacity');
}

export async function createTemplate(input: CreateTemplateInput, userId: string): Promise<PromptTemplate> {
  // Enforce max active
  if (input.is_active && !input.is_lesson_author) {
    await lockPromptTemplateCapacity();
    const activeCount = await getActiveCount();
    if (activeCount >= MAX_ACTIVE) {
      throw new AppError(`Tối đa ${MAX_ACTIVE} mascot được bật cùng lúc. Hãy tắt 1 mascot trước.`, 409);
    }
  }

  const created = await templatesRepository.insert({
    name: input.name,
    description: input.description || '',
    prompt: input.prompt,
    voicePrompt: input.voice_prompt?.trim() || null,
    isActive: input.is_lesson_author ? false : (input.is_active || false),
    sortOrder: input.sort_order || 0,
    createdBy: userId,
  });
  if (input.is_lesson_author) {
    const lessonAuthorTemplate = await setLessonAuthorTemplate(created.id, true);
    return lessonAuthorTemplate || created;
  }
  return created;
}

export async function updateTemplate(id: string, input: UpdateTemplateInput): Promise<PromptTemplate | null> {
  if (input.is_active !== undefined || input.is_lesson_author !== undefined) {
    await lockPromptTemplateCapacity();
  }
  const current = await getTemplate(id);
  if (!current) return null;

  if (input.is_active === true && (current.is_lesson_author || input.is_lesson_author === true)) {
    throw new AppError('Mascot chuyên gia bài học không hiển thị trong AI Chatbot. Hãy tắt cờ chuyên gia trước khi bật mascot thường.', 409);
  }

  // Enforce max active when toggling on
  if (input.is_active === true) {
    if (current && !current.is_active) {
      const activeCount = await getActiveCount();
      if (activeCount >= MAX_ACTIVE) {
        throw new AppError(`Tối đa ${MAX_ACTIVE} mascot được bật cùng lúc. Hãy tắt 1 mascot trước.`, 409);
      }
    }
  }

  const columns: Array<[string, unknown]> = [];
  if (input.name !== undefined) { columns.push(['name', input.name]); }
  if (input.description !== undefined) { columns.push(['description', input.description]); }
  if (input.prompt !== undefined) { columns.push(['prompt', input.prompt]); }
  if (input.voice_prompt !== undefined) { columns.push(['voice_prompt', input.voice_prompt?.trim() || null]); }
  if (input.is_active !== undefined) { columns.push(['is_active', input.is_active]); }
  if (input.sort_order !== undefined) { columns.push(['sort_order', input.sort_order]); }

  if (columns.length > 0) {
    await templatesRepository.update(id, columns);
  }

  if (input.is_lesson_author !== undefined) {
    return setLessonAuthorTemplate(id, input.is_lesson_author);
  }

  return getTemplate(id);
}

export async function deleteTemplate(id: string, auditEntry?: TransactionalAuditEntry): Promise<boolean> {
  // found false: no such template; the transaction that found none still commits.
  const outcome = await withDatabaseTransaction(async (client) => {
    const repository = createPromptTemplatesRepository(client);
    const current = await repository.lockImages(id);
    if (current.rowCount === 0) return { found: false as const };
    const removed: Pick<PromptTemplate, 'avatar_url' | 'fullbody_url'> | null = current.rows[0];
    await repository.delete(id);
    if (auditEntry) await appendAuditLog(client, auditEntry);
    return { found: true as const, removed };
  });
  if (!outcome.found) return false;
  const { removed } = outcome;
  if (removed?.avatar_url) await deleteFileByUrl(removed.avatar_url).catch(swallowAndLog('prompt_templates.image_cleanup'));
  if (removed?.fullbody_url) await deleteFileByUrl(removed.fullbody_url).catch(swallowAndLog('prompt_templates.image_cleanup'));
  return true;
}

// ── Image Uploads ──

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

function validateImage(file: { mimetype: string; size: number }): void {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new AppError('Chỉ hỗ trợ JPEG, PNG, WebP, GIF', 400);
  }
  if (file.size > MAX_IMAGE_SIZE) {
    throw new AppError('File ảnh tối đa 5MB', 400);
  }
}

export async function uploadAvatar(
  id: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  auditEntry?: (template: PromptTemplate) => TransactionalAuditEntry,
): Promise<PromptTemplate | null> {
  validateImage(file);
  const fileName = buildFileName(file.originalname);
  const storagePath = `system/prompt-mascots/avatars/${fileName}`;
  await uploadFile(storagePath, file.buffer, file.mimetype);
  const client = await getClient();
  let oldPath: string | null = null;
  let updated: PromptTemplate | null = null;
  try {
    await client.query('BEGIN');
    const repository = createPromptTemplatesRepository(client);
    const current = await repository.lockImage(id, 'avatar_url');
    if (current.rowCount === 0) { await client.query('ROLLBACK'); await deleteFileByUrl(storagePath).catch(swallowAndLog('prompt_templates.image_cleanup')); return null; }
    oldPath = current.rows[0].avatar_url;
    updated = (await repository.setImage(id, 'avatar_url', storagePath)) || null;
    if (!updated) throw new AppError('Không thể cập nhật ảnh đại diện', 500);
    if (auditEntry) await appendAuditLog(client, auditEntry(updated));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    await deleteFileByUrl(storagePath).catch(swallowAndLog('prompt_templates.image_cleanup'));
    throw error;
  } finally {
    client.release();
  }
  if (oldPath && oldPath !== storagePath) await deleteFileByUrl(oldPath).catch(swallowAndLog('prompt_templates.image_cleanup'));
  return updated;
}

export async function uploadFullbody(
  id: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  auditEntry?: (template: PromptTemplate) => TransactionalAuditEntry,
): Promise<PromptTemplate | null> {
  validateImage(file);
  const fileName = buildFileName(file.originalname);
  const storagePath = `system/prompt-mascots/fullbody/${fileName}`;
  await uploadFile(storagePath, file.buffer, file.mimetype);
  const client = await getClient();
  let oldPath: string | null = null;
  let updated: PromptTemplate | null = null;
  try {
    await client.query('BEGIN');
    const repository = createPromptTemplatesRepository(client);
    const current = await repository.lockImage(id, 'fullbody_url');
    if (current.rowCount === 0) { await client.query('ROLLBACK'); await deleteFileByUrl(storagePath).catch(swallowAndLog('prompt_templates.image_cleanup')); return null; }
    oldPath = current.rows[0].fullbody_url;
    updated = (await repository.setImage(id, 'fullbody_url', storagePath)) || null;
    if (!updated) throw new AppError('Không thể cập nhật ảnh toàn thân', 500);
    if (auditEntry) await appendAuditLog(client, auditEntry(updated));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    await deleteFileByUrl(storagePath).catch(swallowAndLog('prompt_templates.image_cleanup'));
    throw error;
  } finally {
    client.release();
  }
  if (oldPath && oldPath !== storagePath) await deleteFileByUrl(oldPath).catch(swallowAndLog('prompt_templates.image_cleanup'));
  return updated;
}
