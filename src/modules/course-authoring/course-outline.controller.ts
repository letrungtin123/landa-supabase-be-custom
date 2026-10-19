// ═══════════════════════════════════════════════════════════════
// Course outline controller: the outline, blocks (create, edit, publish,
// discard, reorder, delete), unit children, studio submits and course
// creation. Moved from course-authoring.controller.ts, which still re-exports
// every handler.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { sendClientError } from '../../utils/client-error.js';
import * as svc from './course-authoring.service.js';
import { getTenantCourseComponentPermissions } from '../tenants/tenant-course-components.service.js';
import { requestBlockDeletion } from '../course-deletion/course-deletion.service.js';
import { reorderSchema } from './course-authoring.validator.js';
import { sanitizeCourseHtmlData } from './course-html-sanitizer.logic.js';
import { scrubMarkupDeep } from './course-markup-scrubber.logic.js';
import { withoutServerOwnedAuthorNotes } from './course-author-notes.logic.js';
import { env } from '../../config/env.js';
import {
  CoursePublishGovernanceError,
  getCoursePublishPolicyForBlock,
  mapCoursePublishGovernanceError,
} from './course-publish-governance.repository.js';
import { ensureCoursePublishGovernanceSchema } from './course-publish-governance-schema.repository.js';
import { isUuid } from '../../utils/uuid.js';
import { componentAuditContext, requestComponentLocale } from './course-authoring-request.js';
import {
  getMediaQuizMetadataMode,
  sanitizeImageChoiceQuizData,
  sanitizeMediaQuizData,
  sanitizeMetadata,
  sanitizeProblemMedia,
  sanitizeScenarioChatData,
} from './course-block-input.logic.js';

/** GET /api/course-authoring/outline/:courseId */
export async function getOutline(req: Request, res: Response) {
  try {
    const { courseId } = req.params;
    const tenantId = req.user!.tenantId!;
    const result = await svc.getCourseOutline(courseId, tenantId);
    sendSuccess(res, result);
  } catch (err) {
    sendClientError(req, res, err, 'CourseAuthoring');
  }
}

/** GET /api/course-authoring/blocks/:blockId */
export async function getBlock(req: Request, res: Response) {
  try {
    // `courses.can_view` is enough for this generic read, so the server-owned
    // AI ID author notes are removed; editors read them via author-notes.
    const block = await svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
    sendSuccess(res, { ...block, metadata: withoutServerOwnedAuthorNotes(block.metadata) });
  } catch (err) {
    sendClientError(req, res, err, 'CourseAuthoring');
  }
}

/** GET /api/course-authoring/component-permissions */
export async function getComponentPermissions(req: Request, res: Response) {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant context is required', 403);

    const permissions = await getTenantCourseComponentPermissions(tenantId);
    sendSuccess(res, permissions);
  } catch (err) {
    sendClientError(req, res, err, 'CourseAuthoring');
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
      const parent = await svc.getBlockInfo(resolvedParentId, req.user!.tenantId);
      finalCourseId = parent.course_id;
    } catch {
      return sendError(res, 'Parent block not found', 404);
    }
  }
  if (!finalCourseId) {
    return sendError(res, 'course_id could not be resolved', 400);
  }

  const sanitizedCreateData = resolvedType === 'la_media_quiz' && data !== undefined
    ? sanitizeMediaQuizData(data)
    : resolvedType === 'la_image_choice_quiz' && data !== undefined
      ? sanitizeImageChoiceQuizData(data)
    : resolvedType === 'la_scenario_chat' && data !== undefined
      ? sanitizeScenarioChatData(data)
      : resolvedType === 'html' && data !== undefined
        ? sanitizeCourseHtmlData(data)
      // Problem OLX and other component JSON: executable markup is removed.
      : scrubMarkupDeep(data, { xml: resolvedType === 'problem' });
  const mediaQuizMetadataMode = resolvedType === 'la_media_quiz'
    ? data !== undefined
      ? getMediaQuizMetadataMode(sanitizedCreateData)
      : boilerplate === 'media_quiz_multiple_select' ? 'multiple_select' : 'single_select'
    : undefined;

  if (resolvedType === 'la_image_choice_quiz' && sanitizedCreateData !== undefined) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Tenant context is required', 403);
    await svc.assertImageChoiceQuizImageAssets(finalCourseId, tenantId, sanitizedCreateData);
  }

  const result = await runAuditedTransaction(
    () => svc.createBlock(
      finalCourseId,
      resolvedParentId,
      resolvedType,
      display_name,
      sanitizedCreateData,
      resolvedType === 'la_media_quiz'
        ? { ...scrubMarkupDeep(metadata ?? {}), media_quiz_mode: mediaQuizMetadataMode }
        : scrubMarkupDeep(metadata),
      boilerplate,
      req.user!.tenantId,
      requestComponentLocale(req),
    ),
    async (created) => {
      const block = await svc.getBlockInfo(created.id, req.user!.tenantId);
      return createTransactionalAuditEntry(
        req,
        'CREATE',
        'course_block',
        { code: 'course.component.created', context: componentAuditContext(block) },
        block.id,
        block.display_name,
      );
    },
  );
  // Return edX-compatible response
  sendSuccess(res, { locator: result.id, courseKey: finalCourseId, ...result }, undefined, 201);
}

/** PATCH /api/course-authoring/blocks/:blockId */
export async function updateBlock(req: Request, res: Response) {
  try {
    const { display_name, data, metadata, publish, children, candidate_id } = req.body;

    // Handle publish action
    if (publish === 'make_public') {
      let before: Awaited<ReturnType<typeof svc.getBlockInfo>> | undefined;
      const result = await runAuditedTransaction(
        async () => {
          before = await svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
          const tenantId = req.user!.tenantId;
          if (env.COURSE_PUBLISH_GOVERNANCE_ENABLED) await ensureCoursePublishGovernanceSchema();
          const enrolledPolicy = env.COURSE_PUBLISH_GOVERNANCE_ENABLED && tenantId
            ? await getCoursePublishPolicyForBlock(req.params.blockId, tenantId)
            : null;
          if (enrolledPolicy) {
            if (!isUuid(candidate_id)) {
              throw new CoursePublishGovernanceError(
                'COURSE_PUBLISH_CANDIDATE_REQUIRED',
                409,
                'Cần tạo hoặc chọn bản duyệt trước khi xuất bản.',
              );
            }
            return svc.publishBlock(req.params.blockId, tenantId, {
              candidateId: candidate_id,
              actorId: req.user!.id,
            });
          }
          return svc.publishBlock(req.params.blockId, tenantId);
        },
        (updated) => createTransactionalAuditEntry(
          req,
          'UPDATE',
          'course_block',
          {
            code: 'course.component.updated',
            context: componentAuditContext(updated),
            changes: [{
              field: 'publication_status',
              before: before?.is_published ? 'published' : 'draft',
              after: 'published',
            }],
          },
          updated.id,
          updated.display_name,
        ),
      );
      return sendSuccess(res, result);
    }

    // Handle discard draft (rollback to published version)
    if (publish === 'discard_changes') {
      let before: Awaited<ReturnType<typeof svc.getBlockInfo>> | undefined;
      const result = await runAuditedTransaction(
        async () => {
          before = await svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
          return svc.discardDraftCascade(req.params.blockId, req.user!.tenantId);
        },
        (updated) => createTransactionalAuditEntry(
          req,
          'UPDATE',
          'course_block',
          {
            code: 'course.component.updated',
            context: componentAuditContext(updated),
            changes: before?.has_draft_changes
              ? [{ field: 'content_status', before: 'draft', after: 'published_version' }]
              : [],
          },
          updated.id,
          updated.display_name,
        ),
      );
      return sendSuccess(res, result);
    }

    // Handle reorder
    if (Array.isArray(children)) {
      const block = await runAuditedTransaction(
        async () => {
          await svc.reorderChildren(req.params.blockId, children, req.user!.tenantId);
          return svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
        },
        (parent) => createTransactionalAuditEntry(
          req,
          'UPDATE',
          'course_block',
          {
            code: 'course.component.reordered',
            context: { ...componentAuditContext(parent), affected_count: children.length },
          },
          parent.id,
          parent.display_name,
        ),
      );
      return sendSuccess(res, block);
    }

    // Handle metadata.display_name (edX compat)
    const resolvedName = display_name ?? metadata?.display_name;

    let sanitizedData = data;
    let sanitizedMetadata = scrubMarkupDeep(sanitizeMetadata(metadata));
    if (data !== undefined) {
      const currentBlock = await svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
      if (currentBlock.block_type === 'la_media_quiz') {
        sanitizedData = sanitizeMediaQuizData(data);
        sanitizedMetadata = {
          ...(sanitizedMetadata ?? {}),
          media_quiz_mode: getMediaQuizMetadataMode(sanitizedData),
        };
      } else if (currentBlock.block_type === 'la_image_choice_quiz') {
        sanitizedData = sanitizeImageChoiceQuizData(data);
        const tenantId = req.user?.tenantId;
        if (!tenantId) return sendError(res, 'Tenant context is required', 403);
        await svc.assertImageChoiceQuizImageAssets(currentBlock.course_id, tenantId, sanitizedData);
      } else if (currentBlock.block_type === 'la_scenario_chat') {
        sanitizedData = sanitizeScenarioChatData(data);
      } else if (currentBlock.block_type === 'html') {
        sanitizedData = sanitizeCourseHtmlData(data);
      } else {
        // Problem OLX and other component JSON: executable markup is removed.
        sanitizedData = scrubMarkupDeep(data, { xml: currentBlock.block_type === 'problem' });
      }
    }

    let before: Awaited<ReturnType<typeof svc.getBlockInfo>> | undefined;
    const result = await runAuditedTransaction(
      async () => {
        before = await svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
        return svc.updateBlock(req.params.blockId, {
          display_name: resolvedName,
          data: sanitizedData,
          metadata: sanitizedMetadata,
        });
      },
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'course_block',
        {
          code: 'course.component.updated',
          context: componentAuditContext(updated),
          changes: before && before.display_name !== updated.display_name
            ? [{ field: 'display_name', before: before.display_name, after: updated.display_name }]
            : [],
        },
        updated.id,
        updated.display_name,
      ),
    );
    sendSuccess(res, result);
  } catch (err: any) {
    if (err instanceof CoursePublishGovernanceError || String(err?.message ?? '').includes('COURSE_PUBLISH_')) {
      const mapped = mapCoursePublishGovernanceError(err);
      res.status(mapped.statusCode).json({ success: false, code: mapped.code, message: mapped.message });
      return;
    }
    sendClientError(req, res, err, 'CourseAuthoring');
  }
}

/** DELETE /api/course-authoring/blocks/:blockId */
export async function deleteBlock(req: Request, res: Response) {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return sendError(res, 'tenant_id is required', 400);
    const block = await svc.getBlockInfo(req.params.blockId, tenantId);
    await requestBlockDeletion(
      req.params.blockId,
      tenantId,
      req.user!.id,
      createTransactionalAuditEntry(
        req,
        'DELETE',
        'course_block',
        { code: 'course.component.deleted', context: componentAuditContext(block) },
        block.id,
        block.display_name,
      ),
    );
    sendSuccess(res, { success: true });
  } catch (err) {
    sendClientError(req, res, err, 'CourseAuthoring');
  }
}

/** POST /api/course-authoring/blocks/:blockId/reorder */
export async function reorderChildren(req: Request, res: Response) {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);

  await runAuditedTransaction(
    async () => {
      await svc.reorderChildren(req.params.blockId, parsed.data.children, req.user!.tenantId);
      return svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
    },
    (block) => createTransactionalAuditEntry(
      req,
      'UPDATE',
      'course_block',
      {
        code: 'course.component.reordered',
        context: { ...componentAuditContext(block), affected_count: parsed.data.children.length },
      },
      block.id,
      block.display_name,
    ),
  );
  sendSuccess(res, { success: true });
}

/** GET /api/course-authoring/units/:unitId/children */
export async function getUnitChildren(req: Request, res: Response) {
  const result = await svc.getUnitChildren(req.params.unitId, req.user!.tenantId);
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
    let before: Awaited<ReturnType<typeof svc.getBlockInfo>> | undefined;
    const result = await runAuditedTransaction(
      async () => {
        before = await svc.getBlockInfo(req.params.blockId, req.user!.tenantId);
        // Component JSON from the editors: executable markup is removed from every string.
        return svc.studioSubmit(req.params.blockId, scrubMarkupDeep(req.body), req.user!.tenantId);
      },
      (submitted) => {
        const block = submitted.block;
        if (!block) throw new Error('Studio submit did not return the updated component');
        return createTransactionalAuditEntry(
          req,
          'UPDATE',
          'course_block',
          {
            code: 'course.component.updated',
            context: componentAuditContext(block),
            changes: before && before.display_name !== block.display_name
              ? [{ field: 'display_name', before: before.display_name, after: block.display_name }]
              : [],
          },
          block.id,
          block.display_name,
        );
      },
    );
    sendSuccess(res, result);
  } catch (err) {
    sendClientError(req, res, err, 'CourseAuthoring');
  }
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

  await runAuditedTransaction(
    async () => {
      await svc.createCourseWithRootBlock({
        courseId,
        tenantId,
        displayName: safeDisplayName,
        description: safeDescription,
        org: safeOrg,
        start,
        userId: req.user!.id,
      });
      return undefined;
    },
    () => createTransactionalAuditEntry(
      req,
      'CREATE',
      'course',
      { code: 'course.created' },
      courseId,
      safeDisplayName,
    ),
  );
  sendSuccess(res, {
    id: courseId,
    display_name: safeDisplayName,
    description: safeDescription,
    org: safeOrg,
    number: safeNumber,
    run: safeRun,
  }, undefined, 201);
}
