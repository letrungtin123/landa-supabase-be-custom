// ═══════════════════════════════════════════════════════════════
// Course Authoring Controller
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { auditFromReq } from '../../middleware/audit-log.js';
import fs from 'fs/promises';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './course-authoring.service.js';
import { requestBlockDeletion } from '../course-deletion/course-deletion.service.js';
import { reorderSchema } from './course-authoring.validator.js';
import { uploadFile, uploadFileFromPath, deleteFile, buildFileName, buildStoragePath, fixMulterFilename } from '../../config/storage.js';
import { COURSE_ASSET_MAX_UPLOAD_BYTES, COURSE_ASSET_MAX_UPLOAD_LABEL } from '../../config/upload-limits.js';

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

async function cleanupTempUpload(file: Express.Multer.File): Promise<void> {
  if (!file.path) return;
  await fs.unlink(file.path).catch(() => {});
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

  // Video upload (storage path) — alternative to YouTube
  const videoStoragePath = typeof raw.video_storage_path === 'string' && isSafeCourseAssetPath(raw.video_storage_path)
    ? raw.video_storage_path.trim()
    : undefined;

  if (!youtubeId && images.length === 0 && !videoStoragePath) return undefined;

  return {
    ...(youtubeId ? {
      youtube_id: youtubeId,
      youtube_url: `https://www.youtube.com/watch?v=${youtubeId}`,
    } : {}),
    ...(videoStoragePath ? { video_storage_path: videoStoragePath } : {}),
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

function sanitizeMediaQuizHtml(raw: unknown, fallback: string, maxLength: number): string {
  const value = typeof raw === 'string' ? raw : fallback;
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .slice(0, maxLength)
    .trim();
}

function sanitizeMediaQuizId(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function sanitizeMediaQuizMode(raw: unknown, fallback: 'single_select' | 'multiple_select'): 'single_select' | 'multiple_select' {
  return raw === 'single_select' || raw === 'multiple_select' ? raw : fallback;
}

function sanitizeMediaQuizData(raw: any) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object') throw new Error('Dữ liệu câu hỏi kèm media phải là object');

  const mode = sanitizeMediaQuizMode(parsed.mode, 'single_select');
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('Câu hỏi kèm media cần ít nhất một câu hỏi');
  }

  const questions = parsed.questions.slice(0, 50).map((question: any, questionIndex: number) => {
    const questionMode = sanitizeMediaQuizMode(question?.mode, mode);
    const mediaType = question?.media?.type === 'video' ? 'video' : 'image';
    const storagePath = typeof question?.media?.storage_path === 'string'
      ? question.media.storage_path.trim()
      : '';
    if (!isSafeCourseAssetPath(storagePath)) {
      throw new Error(`Câu hỏi ${questionIndex + 1} cần tải media của khóa học lên`);
    }

    if (!Array.isArray(question?.choices) || question.choices.length < 2) {
      throw new Error(`Câu hỏi ${questionIndex + 1} cần ít nhất hai lựa chọn`);
    }

    const choices = question.choices.slice(0, 12).map((choice: any, choiceIndex: number) => ({
      id: sanitizeMediaQuizId(choice?.id, `choice_${choiceIndex}`),
      html: sanitizeMediaQuizHtml(choice?.html, `Lựa chọn ${choiceIndex + 1}`, 2000),
      correct: choice?.correct === true,
    }));

    const correctCount = choices.filter((choice: any) => choice.correct).length;
    if (correctCount === 0) {
      throw new Error(`Câu hỏi ${questionIndex + 1} cần ít nhất một đáp án đúng`);
    }
    if (questionMode === 'single_select' && correctCount !== 1) {
      throw new Error(`Câu hỏi ${questionIndex + 1} phải có đúng một đáp án đúng`);
    }

    const hints = Array.isArray(question?.hints)
      ? question.hints
          .slice(0, 10)
          .map((hint: unknown) => sanitizeMediaQuizHtml(hint, '', 2000))
          .filter(Boolean)
      : [];

    return {
      id: sanitizeMediaQuizId(question?.id, `q_${questionIndex + 1}`),
      mode: questionMode,
      prompt_html: sanitizeMediaQuizHtml(question?.prompt_html, `Câu hỏi ${questionIndex + 1}`, 4000),
      explanation_html: sanitizeMediaQuizHtml(question?.explanation_html, '', 8000),
      hints,
      media: {
        type: mediaType,
        storage_path: storagePath,
        alt: typeof question?.media?.alt === 'string'
          ? question.media.alt.replace(/[<>]/g, '').slice(0, 200)
          : '',
      },
      choices,
    };
  });

  return {
    version: 1,
    mode: questions[0]?.mode ?? mode,
    require_correct_to_advance: true,
    questions,
  };
}

function getMediaQuizMetadataMode(data: any): 'single_select' | 'multiple_select' | 'mixed' {
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const hasSingle = questions.some((question: any) => question?.mode !== 'multiple_select');
  const hasMultiple = questions.some((question: any) => question?.mode === 'multiple_select');
  if (hasSingle && hasMultiple) return 'mixed';
  return hasMultiple ? 'multiple_select' : 'single_select';
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

  const sanitizedCreateData = resolvedType === 'la_media_quiz' && data !== undefined
    ? sanitizeMediaQuizData(data)
    : data;
  const mediaQuizMetadataMode = resolvedType === 'la_media_quiz'
    ? data !== undefined
      ? getMediaQuizMetadataMode(sanitizedCreateData)
      : boilerplate === 'media_quiz_multiple_select' ? 'multiple_select' : 'single_select'
    : undefined;

  const result = await svc.createBlock(
    finalCourseId,
    resolvedParentId,
    resolvedType,
    display_name,
    sanitizedCreateData,
    resolvedType === 'la_media_quiz'
      ? { ...(metadata ?? {}), media_quiz_mode: mediaQuizMetadataMode }
      : metadata,
    boilerplate,
  );

  auditFromReq(req, 'CREATE', 'course_block', result.id, display_name || resolvedType, `Khóa học ${finalCourseId}`);
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
      auditFromReq(req, 'UPDATE', 'course_block', result.id, result.display_name, 'Publish block');
      return sendSuccess(res, result);
    }

    // Handle discard draft (rollback to published version)
    if (publish === 'discard_changes') {
      const result = await svc.discardDraftCascade(req.params.blockId);
      auditFromReq(req, 'UPDATE', 'course_block', result.id, result.display_name, 'Discard draft block');
      return sendSuccess(res, result);
    }

    // Handle reorder
    if (Array.isArray(children)) {
      await svc.reorderChildren(req.params.blockId, children);
      const block = await svc.getBlockInfo(req.params.blockId);
      auditFromReq(req, 'UPDATE', 'course_block', block.id, block.display_name, `Sắp xếp ${children.length} block con`);
      return sendSuccess(res, block);
    }

    // Handle metadata.display_name (edX compat)
    const resolvedName = display_name ?? metadata?.display_name;

    let sanitizedData = data;
    let sanitizedMetadata = sanitizeMetadata(metadata);
    if (data !== undefined) {
      const currentBlock = await svc.getBlockInfo(req.params.blockId);
      if (currentBlock.block_type === 'la_media_quiz') {
        sanitizedData = sanitizeMediaQuizData(data);
        sanitizedMetadata = {
          ...(sanitizedMetadata ?? {}),
          media_quiz_mode: getMediaQuizMetadataMode(sanitizedData),
        };
      }
    }

    const result = await svc.updateBlock(req.params.blockId, {
      display_name: resolvedName,
      data: sanitizedData,
      metadata: sanitizedMetadata,
    });
    auditFromReq(req, 'UPDATE', 'course_block', result.id, result.display_name);
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
    const block = await svc.getBlockInfo(req.params.blockId);
    await requestBlockDeletion(req.params.blockId, tenantId, req.user!.id);
    auditFromReq(req, 'DELETE', 'course_block', block.id, block.display_name, 'Delete requested');
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
  const block = await svc.getBlockInfo(req.params.blockId);
  auditFromReq(req, 'UPDATE', 'course_block', block.id, block.display_name, `Sắp xếp ${parsed.data.children.length} block con`);
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
    // Sanitize problem_media if present (crossword, sortable, etc.)
    if (req.body?.problem_media) {
      const media = sanitizeProblemMedia(req.body.problem_media);
      if (media) req.body.problem_media = media;
      else delete req.body.problem_media;
    }
    const result = await svc.studioSubmit(req.params.blockId, req.body);
    const block = result?.block;
    auditFromReq(req, 'UPDATE', 'course_block', req.params.blockId, block?.display_name, 'Studio submit');
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
  let storagePath = '';
  let storageUploaded = false;

  try {
    if (file.size > COURSE_ASSET_MAX_UPLOAD_BYTES) {
      return sendError(res, `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Giới hạn tối đa ${COURSE_ASSET_MAX_UPLOAD_LABEL}.`, 413);
    }

    const originalName = fixMulterFilename(file.originalname);
    const fileName = buildFileName(originalName);
    storagePath = buildStoragePath(tenantId, 'courses', fileName, courseId);

    // Upload to Supabase Storage — trả về path, KHÔNG phải full URL
    if (file.path) {
      await uploadFileFromPath(storagePath, file.path, file.mimetype);
    } else if (file.buffer) {
      await uploadFile(storagePath, file.buffer, file.mimetype);
    } else {
      return sendError(res, 'Uploaded file is not readable', 400);
    }
    storageUploaded = true;

    // DB lưu storagePath cho cả storage_path VÀ url columns
    const asset = await svc.createAssetRecord(
      courseId, tenantId, originalName, file.mimetype,
      file.size, storagePath, storagePath, userId,
    );

    auditFromReq(req, 'CREATE', 'course_asset', asset.id, asset.display_name, `Khóa học ${courseId}`);
    sendSuccess(res, asset, undefined, 201);
  } catch (err) {
    if (storageUploaded && storagePath) {
      await deleteFile(storagePath);
    }
    throw err;
  } finally {
    await cleanupTempUpload(file);
  }
}

/** DELETE /api/course-authoring/assets/:courseId/:assetId */
export async function deleteAsset(req: Request, res: Response) {
  const { courseId, assetId } = req.params;
  const tenantId = req.user!.tenantId!;
  const result = await svc.deleteAsset(assetId, courseId, tenantId);
  if (!result) return sendError(res, 'Asset not found', 404);

  await Promise.allSettled(result.storagePathsToDelete.map((path) => deleteFile(path)));
  if (result.deleted) {
    auditFromReq(req, 'DELETE', 'course_asset', assetId, result.asset?.display_name, `Khóa học ${courseId}`);
  }

  sendSuccess(res, {
    success: true,
    deleted: result.deleted ? 1 : 0,
    pending_delete: result.pendingPublishedReferences,
    published_reference_count: result.publishedReferenceCount,
  });
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

  const result = await svc.deleteAssetByStoragePath(courseId, tenantId, storagePath);
  await Promise.allSettled(result.storagePathsToDelete.map((path) => deleteFile(path)));
  if (result.deletedRows.length > 0) {
    const first = result.deletedRows[0];
    auditFromReq(req, 'DELETE', 'course_asset', first.storage_path, first.display_name || first.storage_path, `Xóa ${result.deletedRows.length} asset theo path`);
  }

  sendSuccess(res, {
    success: true,
    deleted: result.deletedRows.length,
    pending_delete: result.pendingPublishedReferences,
    published_reference_count: result.publishedReferenceCount,
  });
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
  await svc.initializeCourseStructure(courseId, safeDisplayName, tenantId);

  auditFromReq(req, 'CREATE', 'course', courseId, safeDisplayName);
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
    auditFromReq(req, 'UPDATE', 'course_asset', req.params.courseId, undefined, `Cập nhật reference ${assetIds.length} asset`);
    sendSuccess(res, { success: true });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}
