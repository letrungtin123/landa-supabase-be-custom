// ═══════════════════════════════════════════════════════════════
// Bot Controller — HTTP handlers for Chatbot CRUD
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createBotSchema, updateBotSchema } from './bot.validator.js';
import * as botService from './bot.service.js';
import { auditFromReq } from '../../middleware/audit-log.js';

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
    const bot = await botService.createBot(tenantId, parsed.data, req.user!.id);
    auditFromReq(req, 'CREATE', 'chatbot', bot.id, bot.name);
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
    const bot = await botService.updateBot(req.params.id, tenantId, parsed.data);
    if (!bot) { sendError(res, 'Bot không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'chatbot', bot.id, bot.name);
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
  const deleted = await botService.deleteBot(req.params.id, tenantId);
  if (!deleted) { sendError(res, 'Lỗi xoá bot', 500); return; }
  auditFromReq(req, 'DELETE', 'chatbot', req.params.id, bot.name);
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
    const bot = await botService.uploadBotAvatar(req.params.id, tenantId, file);
    if (!bot) { sendError(res, 'Bot không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'chatbot', req.params.id, undefined, 'Avatar upload');
    sendSuccess(res, bot);
  } catch (err: any) {
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
    const persona = await botService.updateBotPersona(botId, personaId, tenantId, {
      custom_name, custom_description, custom_prompt,
    });
    if (!persona) { sendError(res, 'Persona không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'bot_persona', personaId, persona.custom_name || persona.template_name, 'Update persona');
    sendSuccess(res, persona);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function resetPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { id: botId, personaId } = req.params;

  try {
    const persona = await botService.resetBotPersona(botId, personaId, tenantId);
    if (!persona) { sendError(res, 'Persona không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'bot_persona', personaId, persona.template_name, 'Reset to default');
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
    const persona = await botService.addBotPersona(botId, template_id, tenantId);
    if (!persona) { sendError(res, 'Bot không tồn tại', 404); return; }
    auditFromReq(req, 'CREATE', 'bot_persona', persona.id, persona.template_name, 'Add persona');
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
    const deleted = await botService.removeBotPersona(botId, personaId, tenantId);
    if (!deleted) { sendError(res, 'Persona không tồn tại', 404); return; }
    auditFromReq(req, 'DELETE', 'bot_persona', personaId, persona?.template_name);
    sendSuccess(res, { deleted: true });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
