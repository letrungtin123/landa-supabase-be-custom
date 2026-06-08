// ═══════════════════════════════════════════════════════════════
// Prompt Templates Controller — HTTP handlers (superadmin only)
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTemplateSchema, updateTemplateSchema } from './prompt-templates.validator.js';
import * as service from './prompt-templates.service.js';
import { auditFromReq } from '../../middleware/audit-log.js';

// ── List all templates ──
export async function listTemplates(req: Request, res: Response): Promise<void> {
  const templates = await service.listTemplates();
  const activeCount = await service.getActiveCount();
  sendSuccess(res, { templates, activeCount, maxActive: 6 });
}

// ── List active templates (for bot creation — any authenticated user) ──
export async function listActiveTemplates(_req: Request, res: Response): Promise<void> {
  const templates = await service.listActiveTemplates();
  sendSuccess(res, templates);
}

// ── Get single ──
export async function getTemplate(req: Request, res: Response): Promise<void> {
  const tpl = await service.getTemplate(req.params.id);
  if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
  sendSuccess(res, tpl);
}

// ── Create ──
export async function createTemplate(req: Request, res: Response): Promise<void> {
  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  try {
    const tpl = await service.createTemplate(parsed.data, req.user!.id);
    auditFromReq(req, 'CREATE', 'prompt_template', tpl.id, tpl.name);
    sendSuccess(res, tpl, undefined, 201);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

// ── Update ──
export async function updateTemplate(req: Request, res: Response): Promise<void> {
  const parsed = updateTemplateSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  try {
    const tpl = await service.updateTemplate(req.params.id, parsed.data);
    if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'prompt_template', tpl.id, tpl.name);
    sendSuccess(res, tpl);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

// ── Delete ──
export async function deleteTemplate(req: Request, res: Response): Promise<void> {
  // Fetch name before deleting for audit log
  const tpl = await service.getTemplate(req.params.id);
  if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
  const deleted = await service.deleteTemplate(req.params.id);
  if (!deleted) { sendError(res, 'Lỗi xoá template', 500); return; }
  auditFromReq(req, 'DELETE', 'prompt_template', req.params.id, tpl.name);
  sendSuccess(res, { deleted: true });
}

// ── Upload Avatar ──
export async function uploadAvatar(req: Request, res: Response): Promise<void> {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) { sendError(res, 'Chưa upload file ảnh', 400); return; }

  try {
    const tpl = await service.uploadAvatar(req.params.id, file);
    if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'prompt_template', tpl.id, tpl.name, 'Avatar upload');
    sendSuccess(res, tpl);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

// ── Upload Fullbody ──
export async function uploadFullbody(req: Request, res: Response): Promise<void> {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) { sendError(res, 'Chưa upload file ảnh', 400); return; }

  try {
    const tpl = await service.uploadFullbody(req.params.id, file);
    if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'prompt_template', tpl.id, tpl.name, 'Fullbody upload');
    sendSuccess(res, tpl);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
