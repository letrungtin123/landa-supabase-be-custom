// ═══════════════════════════════════════════════════════════════
// Course Authoring Controller
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './course-authoring.service.js';
import { requestBlockDeletion } from '../course-deletion/course-deletion.service.js';
import { reorderSchema } from './course-authoring.validator.js';
import { uploadFile, deleteFile, buildFileName, buildStoragePath, fixMulterFilename } from '../../config/storage.js';

function extractYoutubeId(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return '';
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?[^#]*v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isSafeCourseAssetPath(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  const value = src.trim();
  if (!value || value.length > 1000) return false;
  const lower = value.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('//') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('javascript:')
  ) return false;
  if (!value.includes('/courses/')) return false;
  return !/[<>"'`\\]/.test(value);
}

function sanitizeProblemMedia(raw: any) {
  if (!raw || typeof raw !== 'object') return undefined;

  const youtubeId = extractYoutubeId(raw.youtube_id || raw.youtube_url || raw.video_url);
  const images = Array.isArray(raw.images)
    ? raw.images
        .map((img: any) => ({
          src: typeof img?.src === 'string' ? img.src.trim() : '',
          alt: typeof img?.alt === 'string' ? img.alt.replace(/[<>]/g, '').slice(0, 200) : '',
        }))
        .filter((img: any) => isSafeCourseAssetPath(img.src))
        .slice(0, 20)
    : [];

  if (!youtubeId && images.length === 0) return undefined;

  return {
    ...(youtubeId ? {
      youtube_id: youtubeId,
      youtube_url: `https://www.youtube.com/watch?v=${youtubeId}`,
    } : {}),
    images,
  };
}

function sanitizeHtmlMedia(raw: any) {
  if (!raw || typeof raw !== 'object') return undefined;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const images = Array.isArray(raw.images)
    ? raw.images
        .map((img: any) => {
          const src = typeof img?.src === 'string' ? img.src.trim() : '';
          return {
            src,
            alt: typeof img?.alt === 'string' ? img.alt.replace(/[<>]/g, '').slice(0, 200) : '',
            ...(typeof img?.asset_id === 'string' && uuidRegex.test(img.asset_id) ? { asset_id: img.asset_id } : {}),
          };
        })
        .filter((img: any) => isSafeCourseAssetPath(img.src))
        .slice(0, 50)
    : [];

  if (images.length === 0) return undefined;
  return { images };
}

function sanitizeMetadata(metadata: any) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const next = { ...metadata };
  if ('problem_media' in next) {
    const media = sanitizeProblemMedia(next.problem_media);
    if (media) next.problem_media = media;
    else delete next.problem_media;
  }
  if ('html_media' in next) {
    const media = sanitizeHtmlMedia(next.html_media);
    if (media) next.html_media = media;
    else delete next.html_media;
  }
  return next;
}

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

    // Handle discard draft (rollback to published version)
    if (publish === 'discard_changes') {
      const result = await svc.discardDraft(req.params.blockId);
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
      metadata: sanitizeMetadata(metadata),
    });
    sendSuccess(res, result);
  } catch (err: any) {
    sendError(res, err.message, 404);
  }
}

/** DELETE /api/course-authoring/blocks/:blockId */
export async function deleteBlock(req: Request, res: Response) {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return sendError(res, 'tenant_id is required', 400);
    await requestBlockDeletion(req.params.blockId, tenantId, req.user!.id);
    sendSuccess(res, { success: true });
  } catch (err: any) {
    sendError(res, err.message, 404);
  }
}

/** POST /api/course-authoring/blocks/:blockId/reorder */
export async function reorderChildren(req: Request, res: Response) {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

  await svc.reorderChildren(req.params.blockId, parsed.data.children);
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

  // Upload to Supabase Storage — trả về path, KHÔNG phải full URL
  await uploadFile(storagePath, file.buffer, file.mimetype);

  // DB lưu storagePath cho cả storage_path VÀ url columns
  const asset = await svc.createAssetRecord(
    courseId, tenantId, originalName, file.mimetype,
    file.size, storagePath, storagePath, userId,
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

/** POST /api/course-authoring/assets/:courseId/delete-by-path */
export async function deleteAssetByPath(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const storagePath = typeof req.body?.storage_path === 'string'
    ? req.body.storage_path.trim()
    : typeof req.body?.storagePath === 'string'
      ? req.body.storagePath.trim()
      : '';

  if (!isSafeCourseAssetPath(storagePath)) {
    return sendError(res, 'Invalid storage path', 400);
  }

  const deleted = await svc.deleteAssetByStoragePath(courseId, tenantId, storagePath);
  await Promise.allSettled(
    deleted
      .map((row) => row.storage_path)
      .filter(Boolean)
      .map((path) => deleteFile(path)),
  );

  sendSuccess(res, { success: true, deleted: deleted.length });
}

/** POST /api/course-authoring/courses — Create course + root block */
export async function createCourse(req: Request, res: Response) {
  const { display_name, description, org, number: courseNumber, run, start } = req.body;
  const tenantId = req.user!.tenantId!;
  const safeDisplayName = typeof display_name === 'string' ? display_name.trim() : '';
  const safeDescription = typeof description === 'string' ? description.trim() : '';

  if (!safeDisplayName) return sendError(res, 'display_name is required', 400);
  if (!safeDescription) return sendError(res, 'description is required', 400);
  if (safeDisplayName.length > 500) return sendError(res, 'display_name max 500 chars', 400);
  if (safeDescription.length > 5000) return sendError(res, 'description max 5000 chars', 400);

  // Generate course ID: course-v1:{org}+{number}+{run}
  const safeOrg = org || 'LANDA';
  const safeNumber = courseNumber || `C${Date.now()}`;
  const safeRun = run || 'default';
  const courseId = `course-v1:${safeOrg}+${safeNumber}+${safeRun}`;

  // ── Kiểm tra quota course cho tenant ──
  const { checkQuota } = await import('../tenants/tenants.service.js');
  await checkQuota(tenantId, 'courses');

  // Insert into courses table
  const { query: dbQuery } = await import('../../config/database.js');
  await dbQuery(
    `INSERT INTO courses (id, tenant_id, display_name, description, org, start_date, created_by, mentor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [courseId, tenantId, safeDisplayName, safeDescription, safeOrg, start || '2020-01-01', req.user!.id],
  );

  // Initialize course structure with root block
  await svc.initializeCourseStructure(courseId, safeDisplayName);

  sendSuccess(res, {
    id: courseId,
    display_name: safeDisplayName,
    description: safeDescription,
    org: safeOrg,
    number: safeNumber,
    run: safeRun,
  }, undefined, 201);
}

export async function updateAssetReference(req: Request, res: Response) {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return sendError(res, 'tenant_id is required', 400);
    const { assetIds, is_reference } = req.body;
    if (!Array.isArray(assetIds)) return sendError(res, 'assetIds must be an array', 400);
    
    await svc.updateCourseAssetReference(req.params.courseId, assetIds, Boolean(is_reference), tenantId);
    sendSuccess(res, { success: true });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
