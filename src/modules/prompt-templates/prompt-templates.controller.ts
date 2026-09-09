// ═══════════════════════════════════════════════════════════════
// Prompt Templates Controller — HTTP handlers (superadmin only)
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTemplateSchema, updateTemplateSchema } from './prompt-templates.validator.js';
import * as service from './prompt-templates.service.js';
import { createPlatformTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';

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
    const tpl = await runAuditedTransaction(
      () => service.createTemplate(parsed.data, req.user!.id),
      (created) => createPlatformTransactionalAuditEntry(req, 'CREATE', 'prompt_template', { code: 'prompt_template.created' }, created.id, created.name),
    );
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
    let previous: Awaited<ReturnType<typeof service.getTemplate>> | undefined;
    const tpl = await runAuditedTransaction(
      async () => {
        // Keep before/after under the same transaction and singleton locks.
        // Reading outside this unit can audit a stale version under concurrent updates.
        previous = await service.getTemplate(req.params.id);
        return service.updateTemplate(req.params.id, parsed.data);
      },
      (updated) => updated ? createPlatformTransactionalAuditEntry(
        req, 'UPDATE', 'prompt_template',
        {
          code: 'prompt_template.updated',
          context: { related_entity_name: 'template', related_entity_type: 'system_setting' },
          changes: [
            ...(previous && previous.name !== updated.name ? [{ field: 'name', before: previous.name, after: updated.name }] : []),
            ...(previous && previous.is_active !== updated.is_active ? [{ field: 'is_active', before: previous.is_active, after: updated.is_active }] : []),
            ...(previous && previous.sort_order !== updated.sort_order ? [{ field: 'sort_order', before: previous.sort_order, after: updated.sort_order }] : []),
          ],
        }, updated.id, updated.name,
      ) : null,
    );
    if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
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
  const deleted = await service.deleteTemplate(
    req.params.id,
    createPlatformTransactionalAuditEntry(req, 'DELETE', 'prompt_template', { code: 'prompt_template.deleted' }, tpl.id, tpl.name),
  );
  if (!deleted) { sendError(res, 'Lỗi xoá template', 500); return; }
  sendSuccess(res, { deleted: true });
}

// ── Upload Avatar ──
export async function uploadAvatar(req: Request, res: Response): Promise<void> {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) { sendError(res, 'Chưa upload file ảnh', 400); return; }

  try {
    const tpl = await service.uploadAvatar(
      req.params.id, file,
      (updated) => createPlatformTransactionalAuditEntry(
        req, 'UPDATE', 'prompt_template',
        { code: 'prompt_template.updated', context: { related_entity_name: 'avatar', related_entity_type: 'system_setting' } },
        updated.id, updated.name,
      ),
    );
    if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
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
    const tpl = await service.uploadFullbody(
      req.params.id, file,
      (updated) => createPlatformTransactionalAuditEntry(
        req, 'UPDATE', 'prompt_template',
        { code: 'prompt_template.updated', context: { related_entity_name: 'fullbody', related_entity_type: 'system_setting' } },
        updated.id, updated.name,
      ),
    );
    if (!tpl) { sendError(res, 'Template không tồn tại', 404); return; }
    sendSuccess(res, tpl);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
