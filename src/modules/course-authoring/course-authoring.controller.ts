// ═══════════════════════════════════════════════════════════════
// Course Authoring Controller
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './course-authoring.service.js';
import { uploadFile, deleteFile, buildFileName, buildStoragePath, fixMulterFilename } from '../../config/storage.js';

/** GET /api/course-authoring/outline/:courseId */
export async function getOutline(req: Request, res: Response) {
  try {
    const { courseId } = req.params;
    const tenantId = req.user!.tenantId!;
    const result = await svc.getCourseOutline(courseId, tenantId);
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message || 'Failed to load outline', 404);
  }
}

/** GET /api/course-authoring/blocks/:blockId */
export async function getBlock(req: Request, res: Response) {
  try {
    const block = await svc.getBlockInfo(req.params.blockId);
    sendSuccess(res, block);
  } catch (err: any) {
    sendError(res, err.message, 404);
  }
}

/** POST /api/course-authoring/blocks */
export async function createBlock(req: Request, res: Response) {
  const { course_id, parent_id, block_type, display_name, data, metadata, type, category, parent_locator, boilerplate } = req.body;

  // Support both our format and edX-compatible format
  const resolvedCourseId = course_id;
  const resolvedParentId = parent_id || parent_locator || null;
  const resolvedType = block_type || type || category;

  if (!resolvedCourseId && !resolvedParentId) {
    return sendError(res, 'course_id or parent_id is required', 400);
  }
  if (!resolvedType) {
    return sendError(res, 'block_type is required', 400);
  }

  // If parent_id provided but no course_id, resolve from parent
  let finalCourseId = resolvedCourseId;
  if (!finalCourseId && resolvedParentId) {
    try {
      const parent = await svc.getBlockInfo(resolvedParentId);
      finalCourseId = parent.course_id;
    } catch {
      return sendError(res, 'Parent block not found', 404);
    }
  }

  const result = await svc.createBlock(
    finalCourseId,
    resolvedParentId,
    resolvedType,
    display_name,
    data,
    metadata,
  );

  // Return edX-compatible response
  sendSuccess(res, { locator: result.id, courseKey: finalCourseId, ...result }, undefined, 201);
}

/** PATCH /api/course-authoring/blocks/:blockId */
export async function updateBlock(req: Request, res: Response) {
  try {
    const { display_name, data, metadata, publish, children } = req.body;

    // Handle publish action
    if (publish === 'make_public') {
      const result = await svc.publishBlock(req.params.blockId);
      return sendSuccess(res, result);
    }

    // Handle reorder
    if (Array.isArray(children)) {
      await svc.reorderChildren(req.params.blockId, children);
      const block = await svc.getBlockInfo(req.params.blockId);
      return sendSuccess(res, block);
    }

    // Handle metadata.display_name (edX compat)
    const resolvedName = display_name ?? metadata?.display_name;

    const result = await svc.updateBlock(req.params.blockId, {
      display_name: resolvedName,
      data,
      metadata: metadata ? { ...metadata } : undefined,
    });
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 404);
  }
}

/** DELETE /api/course-authoring/blocks/:blockId */
export async function deleteBlock(req: Request, res: Response) {
  try {
    await svc.deleteBlock(req.params.blockId);
    sendSuccess(res, { success: true });
  } catch (err: any) {
    sendError(res, err.message, 404);
  }
}

/** POST /api/course-authoring/blocks/:blockId/reorder */
export async function reorderChildren(req: Request, res: Response) {
  const { children } = req.body;
  if (!Array.isArray(children)) return sendError(res, 'children array is required', 400);

  await svc.reorderChildren(req.params.blockId, children);
  sendSuccess(res, { success: true });
}

/** GET /api/course-authoring/units/:unitId/children */
export async function getUnitChildren(req: Request, res: Response) {
  const result = await svc.getUnitChildren(req.params.unitId);
  sendSuccess(res, result);
}

/** POST /api/course-authoring/blocks/:blockId/handler/studio_submit */
export async function studioSubmit(req: Request, res: Response) {
  try {
    const result = await svc.studioSubmit(req.params.blockId, req.body);
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

/** GET /api/course-authoring/assets/:courseId */
export async function getAssets(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 0;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 50, 100);
  const textSearch = (req.query.text_search as string) || '';

  const result = await svc.getCourseAssets(courseId, tenantId, page, pageSize, textSearch);
  sendSuccess(res, result);
}

/** POST /api/course-authoring/assets/:courseId — Upload file */
export async function uploadAsset(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const userId = req.user!.id;

  if (!req.file) return sendError(res, 'No file uploaded', 400);

  const file = req.file;
  const originalName = fixMulterFilename(file.originalname);
  const fileName = buildFileName(originalName);
  const storagePath = buildStoragePath(tenantId, 'courses', fileName, courseId);

  // Upload to Supabase Storage
  const url = await uploadFile(storagePath, file.buffer, file.mimetype);

  const asset = await svc.createAssetRecord(
    courseId, tenantId, originalName, file.mimetype,
    file.size, storagePath, url, userId,
  );

  sendSuccess(res, asset, undefined, 201);
}

/** DELETE /api/course-authoring/assets/:courseId/:assetId */
export async function deleteAsset(req: Request, res: Response) {
  const result = await svc.deleteAsset(req.params.assetId);
  if (!result) return sendError(res, 'Asset not found', 404);

  // Delete from Supabase Storage
  if (result.storage_path) {
    await deleteFile(result.storage_path).catch(() => {});
  }

  sendSuccess(res, { success: true });
}

/** POST /api/course-authoring/courses — Create course + root block */
export async function createCourse(req: Request, res: Response) {
  const { display_name, org, number: courseNumber, run, start } = req.body;
  const tenantId = req.user!.tenantId!;

  if (!display_name) return sendError(res, 'display_name is required', 400);

  // Generate course ID: course-v1:{org}+{number}+{run}
  const safeOrg = org || 'LANDA';
  const safeNumber = courseNumber || `C${Date.now()}`;
  const safeRun = run || 'default';
  const courseId = `course-v1:${safeOrg}+${safeNumber}+${safeRun}`;

  // Insert into courses table
  const { query: dbQuery } = await import('../../config/database.js');
  await dbQuery(
    `INSERT INTO courses (id, tenant_id, display_name, org, start_date)
     VALUES ($1, $2, $3, $4, $5)`,
    [courseId, tenantId, display_name, safeOrg, start || '2020-01-01'],
  );

  // Initialize course structure with root block
  await svc.initializeCourseStructure(courseId, display_name);

  sendSuccess(res, {
    id: courseId,
    display_name,
    org: safeOrg,
    number: safeNumber,
    run: safeRun,
  }, undefined, 201);
}
