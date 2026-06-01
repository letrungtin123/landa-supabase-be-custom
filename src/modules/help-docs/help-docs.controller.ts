import type { Request, Response, NextFunction } from 'express';
import * as svc from './help-docs.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';

// ═══ Folders ═══

export async function listFoldersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listFolders(tenantId));
  } catch (err) { next(err); }
}

export async function createFolderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.createFolder(tenantId, req.body);
    auditFromReq(req, 'CREATE', 'help_folder', result.id);
    sendSuccess(res, result, 'Tạo folder thành công', 201);
  } catch (err) { next(err); }
}

export async function updateFolderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.updateFolder(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'help_folder', req.params.id);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteFolderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteFolder(req.params.id);
    auditFromReq(req, 'DELETE', 'help_folder', req.params.id);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function reorderFoldersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) { sendError(res, 'ordered_ids phải là mảng', 400); return; }
    await svc.reorderFolders(ordered_ids);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Pages ═══

export async function listPagesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.listPages(req.query.folder_id as string)); }
  catch (err) { next(err); }
}

export async function getPageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getPage(req.params.id)); }
  catch (err) { next(err); }
}

export async function createPageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await svc.createPage(req.body, req.user!.id);
    auditFromReq(req, 'CREATE', 'help_page', result.id);
    sendSuccess(res, result, 'Tạo trang thành công', 201);
  } catch (err) { next(err); }
}

export async function updatePageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.updatePage(req.params.id, req.body, req.user!.id);
    auditFromReq(req, 'UPDATE', 'help_page', req.params.id);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deletePageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deletePage(req.params.id);
    auditFromReq(req, 'DELETE', 'help_page', req.params.id);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function reorderPagesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { folder_id, ordered_ids } = req.body;
    if (!folder_id || !Array.isArray(ordered_ids)) { sendError(res, 'folder_id và ordered_ids bắt buộc', 400); return; }
    await svc.reorderPages(folder_id, ordered_ids);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}
