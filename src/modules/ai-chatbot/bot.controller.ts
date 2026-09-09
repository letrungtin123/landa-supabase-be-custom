// ═══════════════════════════════════════════════════════════════
// Bot Controller — HTTP handlers for Chatbot CRUD
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createBotSchema, updateBotSchema } from './bot.validator.js';
import * as botService from './bot.service.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';

export async function listBots(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = ([5, 10, 20].includes(parseInt(req.query.page_size as string)) ? parseInt(req.query.page_size as string) : 10);
  const search = req.query.search as string;

  const result = await botService.listBots(tenantId, { page, pageSize, search });
  sendSuccess(res, result);
}

export async function getBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const bot = await botService.getBot(req.params.id, tenantId);
  if (!bot) { sendError(res, 'Bot không tồn tại', 404); return; }
  sendSuccess(res, bot);
}

export async function createBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const parsed = createBotSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  try {
    const bot = await runAuditedTransaction(
      () => botService.createBot(tenantId, parsed.data, req.user!.id),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'chatbot', { code: 'chatbot.created' }, created.id, created.name),
    );
    sendSuccess(res, bot, undefined, 201);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function updateBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const parsed = updateBotSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  try {
    const previous = await botService.getBot(req.params.id, tenantId);
    const bot = await runAuditedTransaction(
      () => botService.updateBot(req.params.id, tenantId, parsed.data),
      (updated) => updated ? createTransactionalAuditEntry(
        req, 'UPDATE', 'chatbot',
        { code: 'chatbot.updated', changes: [
          ...(previous && previous.name !== updated.name ? [{ field: 'name', before: previous.name, after: updated.name }] : []),
        ] }, updated.id, updated.name,
      ) : null,
    );
    if (!bot) { sendError(res, 'Bot không tồn tại', 404); return; }
    sendSuccess(res, bot);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function deleteBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  // Fetch name before deleting for audit log
  const bot = await botService.getBot(req.params.id, tenantId);
  if (!bot) { sendError(res, 'Bot không tồn tại', 404); return; }
  const deleted = await runAuditedTransaction(
    () => botService.deleteBot(req.params.id, tenantId),
    (didDelete) => didDelete ? createTransactionalAuditEntry(req, 'DELETE', 'chatbot', { code: 'chatbot.deleted' }, bot.id, bot.name) : null,
  );
  if (!deleted) { sendError(res, 'Lỗi xoá bot', 500); return; }
  sendSuccess(res, { deleted: true });
}

export async function uploadAvatar(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const file = req.file as Express.Multer.File | undefined;
  if (!file) { sendError(res, 'Chưa upload file ảnh', 400); return; }

  // Validate image
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.mimetype)) { sendError(res, 'Chỉ hỗ trợ JPEG, PNG, WebP, GIF', 400); return; }
  if (file.size > 5 * 1024 * 1024) { sendError(res, 'File ảnh tối đa 5MB', 400); return; }

  try {
    const bot = await botService.uploadBotAvatar(
      req.params.id, tenantId, file,
      (updated) => createTransactionalAuditEntry(req, 'UPDATE', 'chatbot', { code: 'chatbot.updated', context: { related_entity_name: 'avatar', related_entity_type: 'bot_setting' } }, updated.id, updated.name),
    );
    if (!bot) { sendError(res, 'Bot không tồn tại', 404); return; }
    sendSuccess(res, bot);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function getInputFilterConfig(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;

  try {
    const config = await botService.getBotInputFilterConfig(req.params.id, tenantId);
    if (!config) { sendError(res, 'Bot không tồn tại', 404); return; }
    sendSuccess(res, config);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function updateInputFilterConfig(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const rawInput = req.body?.input_filter ?? req.body;

  try {
    const bot = await botService.getBot(req.params.id, tenantId);
    const config = await runAuditedTransaction(
      () => botService.updateBotInputFilterConfig(req.params.id, tenantId, rawInput),
      (updated) => updated ? createTransactionalAuditEntry(req, 'UPDATE', 'chatbot', { code: 'chatbot.updated', context: { related_entity_name: 'input_filter', related_entity_type: 'bot_setting' } }, req.params.id, bot?.name) : null,
    );
    if (!config) { sendError(res, 'Bot không tồn tại', 404); return; }
    sendSuccess(res, config);
  } catch (err: any) {
    if (err instanceof ZodError) {
      sendError(res, err.errors[0]?.message || 'Cấu hình bộ lọc không hợp lệ', 400);
      return;
    }
    sendError(res, err.message, 400);
  }
}

// ── Bot Personas ──

export async function listPersonas(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const personas = await botService.listBotPersonas(req.params.id, tenantId);
  sendSuccess(res, personas);
}

export async function updatePersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { id: botId, personaId } = req.params;
  const { custom_name, custom_description, custom_prompt } = req.body ?? {};

  // Validate
  if (custom_prompt !== undefined && (typeof custom_prompt !== 'string' || custom_prompt.length > 20000)) {
    sendError(res, 'custom_prompt phải là chuỗi (tối đa 20000 ký tự)', 400); return;
  }
  if (custom_name !== undefined && custom_name !== null && (typeof custom_name !== 'string' || custom_name.length > 255)) {
    sendError(res, 'custom_name phải là chuỗi (tối đa 255 ký tự)', 400); return;
  }
  if (custom_description !== undefined && custom_description !== null && typeof custom_description !== 'string') {
    sendError(res, 'custom_description phải là chuỗi', 400); return;
  }

  try {
    const bot = await botService.getBot(botId, tenantId);
    const personas = await botService.listBotPersonas(botId, tenantId);
    const previous = personas.find((persona) => persona.id === personaId);
    const persona = await runAuditedTransaction(
      () => botService.updateBotPersona(botId, personaId, tenantId, { custom_name, custom_description, custom_prompt }),
      (updated) => updated ? createTransactionalAuditEntry(
        req, 'UPDATE', 'bot_persona',
        { code: 'chatbot.persona.updated', context: { parent_name: bot?.name }, changes: previous && (previous.custom_name || previous.template_name) !== (updated.custom_name || updated.template_name) ? [{ field: 'name', before: previous.custom_name || previous.template_name, after: updated.custom_name || updated.template_name }] : [] },
        personaId, updated.custom_name || updated.template_name,
      ) : null,
    );
    if (!persona) { sendError(res, 'Persona không tồn tại', 404); return; }
    sendSuccess(res, persona);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function resetPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { id: botId, personaId } = req.params;

  try {
    const bot = await botService.getBot(botId, tenantId);
    const persona = await runAuditedTransaction(
      () => botService.resetBotPersona(botId, personaId, tenantId),
      (updated) => updated ? createTransactionalAuditEntry(req, 'UPDATE', 'bot_persona', { code: 'chatbot.persona.updated', context: { parent_name: bot?.name } }, personaId, updated.template_name) : null,
    );
    if (!persona) { sendError(res, 'Persona không tồn tại', 404); return; }
    sendSuccess(res, persona);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function addPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { id: botId } = req.params;
  const { template_id } = req.body;

  if (!template_id || typeof template_id !== 'string') {
    sendError(res, 'template_id là bắt buộc', 400);
    return;
  }

  try {
    const bot = await botService.getBot(botId, tenantId);
    const persona = await runAuditedTransaction(
      () => botService.addBotPersona(botId, template_id, tenantId),
      (created) => created ? createTransactionalAuditEntry(req, 'CREATE', 'bot_persona', { code: 'chatbot.persona.created', context: { parent_name: bot?.name } }, created.id, created.template_name) : null,
    );
    if (!persona) { sendError(res, 'Bot không tồn tại', 404); return; }
    sendSuccess(res, persona, undefined, 201);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function removePersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { id: botId, personaId } = req.params;

  try {
    // Fetch persona name before deleting for audit log
    const personas = await botService.listBotPersonas(botId, tenantId);
    const persona = personas.find(p => p.id === personaId);
    const bot = await botService.getBot(botId, tenantId);
    const deleted = await runAuditedTransaction(
      () => botService.removeBotPersona(botId, personaId, tenantId),
      (didDelete) => didDelete ? createTransactionalAuditEntry(req, 'DELETE', 'bot_persona', { code: 'chatbot.persona.deleted', context: { parent_name: bot?.name } }, personaId, persona?.custom_name || persona?.template_name) : null,
    );
    if (!deleted) { sendError(res, 'Persona không tồn tại', 404); return; }
    sendSuccess(res, { deleted: true });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
