// ═══════════════════════════════════════════════════════════════
// Modules Controller — List + CRUD modules
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as modulesService from './modules.service.js';
import { createModuleSchema, updateModuleSchema } from './modules.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';

/** GET /api/modules */
export async function listController(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const modules = await modulesService.listModules();
    sendSuccess(res, modules);
  } catch (err) { next(err); }
}

/** POST /api/modules (superadmin) */
export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createModuleSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const mod = await runAuditedTransaction(
      () => modulesService.createModule(parsed.data),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'module', { code: 'system_module.created' }, created.id, created.name),
    );
    sendSuccess(res, mod, 'Tạo module thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/modules/:id (superadmin) */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateModuleSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const mod = await runAuditedTransaction(
      () => modulesService.updateModule(req.params.id, parsed.data),
      (updated) => {
        const changes = [] as Array<{ field: string; before: string | number | boolean | null; after: string | number | boolean | null }>;
        if (updated.previous.name !== updated.name) changes.push({ field: 'name', before: updated.previous.name, after: updated.name });
        if (updated.previous.sort_order !== updated.sort_order) changes.push({ field: 'sort_order', before: updated.previous.sort_order, after: updated.sort_order });
        if (updated.previous.is_active !== updated.is_active) changes.push({ field: 'is_active', before: updated.previous.is_active, after: updated.is_active });
        return createTransactionalAuditEntry(
          req,
          'UPDATE',
          'module',
          { code: 'system_module.updated', changes },
          updated.id,
          updated.name,
        );
      },
    );
    sendSuccess(res, mod, 'Cập nhật thành công');
  } catch (err) { next(err); }
}
