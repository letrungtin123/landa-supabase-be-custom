// ═══════════════════════════════════════════════════════════════
// Modules Controller — List + CRUD modules
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as modulesService from './modules.service.js';
import { createModuleSchema, updateModuleSchema } from './modules.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';

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

    const mod = await modulesService.createModule(parsed.data);
    auditFromReq(req, 'CREATE', 'module', mod.id, mod.name);
    sendSuccess(res, mod, 'Tạo module thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/modules/:id (superadmin) */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateModuleSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const mod = await modulesService.updateModule(req.params.id, parsed.data);
    auditFromReq(req, 'UPDATE', 'module', mod.id, mod.name);
    sendSuccess(res, mod, 'Cập nhật thành công');
  } catch (err) { next(err); }
}
