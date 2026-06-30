// ═══════════════════════════════════════════════════════════════
// Bot Service — Chatbot CRUD + Bot Personas
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { uploadFile, buildStoragePath, buildFileName, deleteFileByUrl } from '../../config/storage.js';
import type { CreateBotInput, UpdateBotInput } from './bot.validator.js';

export interface Chatbot {
  id: string;
  tenant_id: string;
  kb_id: string | null;
  name: string;
  config: Record<string, unknown>;
  avatar_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  kb_name?: string | null;
  persona_previews?: { name: string; avatar_url: string | null; fullbody_url: string | null }[];
}


// ═══════════════════════════════════════════════════════════════
// Bot CRUD
// ═══════════════════════════════════════════════════════════════

export async function listBots(
  tenantId: string,
  opts: { page?: number; pageSize?: number; search?: string } = {},
): Promise<{ data: Chatbot[]; total: number }> {
  const { page = 1, pageSize = 10, search } = opts;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ['c.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (search?.trim()) {
    conditions.push(`c.name ILIKE $${idx++}`);
    params.push(`%${search.trim()}%`);
  }
  const where = conditions.join(' AND ');
  params.push(pageSize, offset);

  const result = await query<Chatbot & { full_count: string; persona_previews: string }>(
    `SELECT c.*, kb.name AS kb_name,
            COUNT(*) OVER() AS full_count,
            COALESCE(
              (SELECT json_agg(
                json_build_object(
                  'name', spt.name,
                  'avatar_url', spt.avatar_url,
                  'fullbody_url', spt.fullbody_url
                ) ORDER BY bp.sort_order ASC
              )
              FROM bot_personas bp
              JOIN system_prompt_templates spt ON spt.id = bp.template_id
              WHERE bp.bot_id = c.id
                AND spt.is_lesson_author = false
              ), '[]'
            ) AS persona_previews
     FROM chatbots c
     LEFT JOIN knowledgebases kb ON kb.id = c.kb_id
     WHERE ${where}
     ORDER BY c.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');
  const data = result.rows.map(r => {
    const { full_count, persona_previews, ...rest } = r;
    const previews = typeof persona_previews === 'string'
      ? JSON.parse(persona_previews)
      : persona_previews;
    return { ...rest, persona_previews: previews } as unknown as Chatbot;
  });


  return { data, total };
}


export async function getBot(id: string, tenantId: string): Promise<Chatbot | null> {
  const result = await query<Chatbot>(
    `SELECT c.*, kb.name AS kb_name
     FROM chatbots c
     LEFT JOIN knowledgebases kb ON kb.id = c.kb_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [id, tenantId],
  );
  return result.rows[0] || null;
}

export async function createBot(tenantId: string, input: CreateBotInput, userId: string): Promise<Chatbot> {
  // Validate kb_id belongs to same tenant (if provided)
  if (input.kb_id) {
    const kbCheck = await query<{ id: string }>(
      `SELECT id FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
      [input.kb_id, tenantId],
    );
    if (!kbCheck.rowCount || kbCheck.rowCount === 0) {
      throw new Error('Knowledge Base không tồn tại hoặc không thuộc tenant này');
    }
  }

  const result = await query<Chatbot>(
    `INSERT INTO chatbots (tenant_id, kb_id, name, config, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      tenantId,
      input.kb_id || null,
      input.name,
      JSON.stringify(input.config || {}),
      userId,
    ],
  );
  const bot = result.rows[0];

  // Auto-assign active templates as personas
  await autoAssignPersonas(bot.id);

  return bot;
}

export async function updateBot(id: string, tenantId: string, input: UpdateBotInput): Promise<Chatbot | null> {
  // Validate kb_id if being changed
  if (input.kb_id !== undefined && input.kb_id !== null) {
    const kbCheck = await query<{ id: string }>(
      `SELECT id FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
      [input.kb_id, tenantId],
    );
    if (!kbCheck.rowCount || kbCheck.rowCount === 0) {
      throw new Error('Knowledge Base không tồn tại hoặc không thuộc tenant này');
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.kb_id !== undefined) { sets.push(`kb_id = $${idx++}`); params.push(input.kb_id); }

  if (input.config !== undefined) { sets.push(`config = $${idx++}`); params.push(JSON.stringify(input.config)); }
  if (input.avatar_url !== undefined) { sets.push(`avatar_url = $${idx++}`); params.push(input.avatar_url); }
  sets.push(`updated_at = now()`);

  if (sets.length <= 1) return getBot(id, tenantId);

  params.push(id, tenantId);
  const result = await query<Chatbot>(
    `UPDATE chatbots SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx++} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function deleteBot(id: string, tenantId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM chatbots WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Upload bot avatar — stores in Supabase Storage and updates avatar_url.
 */
export async function uploadBotAvatar(
  botId: string,
  tenantId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
): Promise<Chatbot | null> {
  const bot = await getBot(botId, tenantId);
  if (!bot) return null;

  // Delete old avatar if exists
  if (bot.avatar_url) {
    try { await deleteFileByUrl(bot.avatar_url); } catch { /* ignore */ }
  }

  const fileName = buildFileName(file.originalname);
  const storagePath = buildStoragePath(tenantId, 'avatars', fileName);
  await uploadFile(storagePath, file.buffer, file.mimetype);

  const result = await query<Chatbot>(
    `UPDATE chatbots SET avatar_url = $1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [storagePath, botId, tenantId],
  );
  return result.rows[0] || null;
}

// ═══════════════════════════════════════════════════════════════
// Bot Personas — per-bot mascot instances
// ═══════════════════════════════════════════════════════════════

export interface BotPersona {
  id: string;
  bot_id: string;
  template_id: string;
  custom_name: string | null;
  custom_description: string | null;
  custom_prompt: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  // Joined from template
  template_name: string;
  template_description: string;
  template_prompt: string;
  template_avatar_url: string | null;
  template_fullbody_url: string | null;
  template_is_lesson_author?: boolean;
}

/**
 * Auto-assign active system templates as personas for a newly created bot.
 * Uses ON CONFLICT to skip duplicates safely.
 */
async function autoAssignPersonas(botId: string): Promise<void> {
  await query(
    `INSERT INTO bot_personas (bot_id, template_id, sort_order)
     SELECT $1, id, sort_order
     FROM system_prompt_templates
     WHERE is_active = true AND is_lesson_author = false
     ORDER BY sort_order ASC
     LIMIT 6
     ON CONFLICT (bot_id, template_id) DO NOTHING`,
    [botId],
  );
}

/**
 * List personas for a bot (with template info).
 * Validates bot belongs to tenant.
 */
export async function listBotPersonas(botId: string, tenantId: string): Promise<BotPersona[]> {
  const bot = await getBot(botId, tenantId);
  if (!bot) return [];

  const result = await query<BotPersona>(
    `SELECT bp.*,
            spt.name AS template_name,
            spt.description AS template_description,
            spt.prompt AS template_prompt,
            spt.avatar_url AS template_avatar_url,
            spt.fullbody_url AS template_fullbody_url,
            spt.is_lesson_author AS template_is_lesson_author
     FROM bot_personas bp
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     WHERE bp.bot_id = $1
       AND spt.is_lesson_author = false
     ORDER BY bp.sort_order ASC, bp.created_at ASC`,
    [botId],
  );
  return result.rows;
}

async function assertMutableBotPersona(botId: string, personaId: string): Promise<boolean> {
  const result = await query<{ is_lesson_author: boolean }>(
    `SELECT spt.is_lesson_author
     FROM bot_personas bp
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     WHERE bp.id = $1 AND bp.bot_id = $2`,
    [personaId, botId],
  );
  if (!result.rows[0]) return false;
  if (result.rows[0].is_lesson_author) {
    throw new Error('Nhân cách chuyên gia bài học chỉ được chỉnh trong Prompt hệ thống bởi superadmin.');
  }
  return true;
}

/**
 * Update persona custom fields (name, description, prompt).
 * Validates bot ownership via tenant.
 */
export async function updateBotPersona(
  botId: string,
  personaId: string,
  tenantId: string,
  input: { custom_name?: string | null; custom_description?: string | null; custom_prompt?: string | null },
): Promise<BotPersona | null> {
  const bot = await getBot(botId, tenantId);
  if (!bot) return null;
  const mutable = await assertMutableBotPersona(botId, personaId);
  if (!mutable) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.custom_name !== undefined) { sets.push(`custom_name = $${idx++}`); params.push(input.custom_name); }
  if (input.custom_description !== undefined) { sets.push(`custom_description = $${idx++}`); params.push(input.custom_description); }
  if (input.custom_prompt !== undefined) { sets.push(`custom_prompt = $${idx++}`); params.push(input.custom_prompt); }
  sets.push(`updated_at = now()`);

  if (sets.length <= 1) {
    const personas = await listBotPersonas(botId, tenantId);
    return personas.find(p => p.id === personaId) || null;
  }

  params.push(personaId, botId);
  const result = await query(
    `UPDATE bot_personas SET ${sets.join(', ')} WHERE id = $${idx++} AND bot_id = $${idx++}`,
    params,
  );
  if (!result.rowCount || result.rowCount === 0) return null;

  const personas = await listBotPersonas(botId, tenantId);
  return personas.find(p => p.id === personaId) || null;
}

/**
 * Reset persona to defaults (clear all custom fields).
 */
export async function resetBotPersona(
  botId: string,
  personaId: string,
  tenantId: string,
): Promise<BotPersona | null> {
  const bot = await getBot(botId, tenantId);
  if (!bot) return null;
  const mutable = await assertMutableBotPersona(botId, personaId);
  if (!mutable) return null;

  const result = await query(
    `UPDATE bot_personas SET custom_name = NULL, custom_description = NULL, custom_prompt = NULL, updated_at = now()
     WHERE id = $1 AND bot_id = $2`,
    [personaId, botId],
  );
  if (!result.rowCount || result.rowCount === 0) return null;

  const personas = await listBotPersonas(botId, tenantId);
  return personas.find(p => p.id === personaId) || null;
}

const MAX_PERSONAS_PER_BOT = 6;

/**
 * Add a template as persona to a bot. Max 6 per bot.
 */
export async function addBotPersona(
  botId: string,
  templateId: string,
  tenantId: string,
): Promise<BotPersona | null> {
  const bot = await getBot(botId, tenantId);
  if (!bot) return null;

  // Check max
  const existing = await listBotPersonas(botId, tenantId);
  if (existing.length >= MAX_PERSONAS_PER_BOT) {
    throw new Error(`Tối đa ${MAX_PERSONAS_PER_BOT} nhân cách cho mỗi bot`);
  }

  // Check duplicate
  if (existing.some(p => p.template_id === templateId)) {
    throw new Error('Nhân cách này đã được gán cho bot');
  }

  // Verify template exists
  const tplCheck = await query<{ id: string; sort_order: number; is_lesson_author: boolean }>(
    `SELECT id, sort_order, is_lesson_author FROM system_prompt_templates WHERE id = $1`,
    [templateId],
  );
  if (!tplCheck.rows[0]) throw new Error('Template không tồn tại');
  if (tplCheck.rows[0].is_lesson_author) {
    throw new Error('Nhân cách chuyên gia bài học được quản lý trong Prompt hệ thống, không thể thêm thủ công vào AI Chatbot.');
  }

  await query(
    `INSERT INTO bot_personas (bot_id, template_id, sort_order) VALUES ($1, $2, $3)`,
    [botId, templateId, tplCheck.rows[0].sort_order],
  );

  const personas = await listBotPersonas(botId, tenantId);
  return personas.find(p => p.template_id === templateId) || null;
}

/**
 * Remove a persona from a bot.
 */
export async function removeBotPersona(
  botId: string,
  personaId: string,
  tenantId: string,
): Promise<boolean> {
  const bot = await getBot(botId, tenantId);
  if (!bot) return false;
  const mutable = await assertMutableBotPersona(botId, personaId);
  if (!mutable) return false;

  const result = await query(
    `DELETE FROM bot_personas WHERE id = $1 AND bot_id = $2`,
    [personaId, botId],
  );
  return (result.rowCount || 0) > 0;
}
