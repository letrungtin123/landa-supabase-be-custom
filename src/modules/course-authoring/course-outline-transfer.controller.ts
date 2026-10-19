// ═══════════════════════════════════════════════════════════════
// Course outline transfer controller: move or copy outline content between
// courses (superuser and superadmin only). Moved unchanged from
// course-authoring.controller.ts, which still re-exports every handler.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { AppError } from '../../utils/errors.js';
import {
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../tenants/tenant-data-quota.constants.js';
import {
  getCourseOutlineTransferJob,
  listTransferDestinationOptions,
  listTransferDestinationParents,
  listTransferTargetCourses,
  requestCourseOutlineTransfer,
  type CourseOutlineTransferOperation,
} from './course-outline-transfer.service.js';

function assertOutlineTransferOperator(req: Request, res: Response): boolean {
  const role = req.user?.role;
  if (role === 'superuser' || role === 'superadmin') return true;
  sendError(res, 'Chỉ quản trị viên cấp cao mới có thể chuyển hoặc nhân bản nội dung khóa học.', 403);
  return false;
}

function transferErrorStatus(error: unknown): number {
  const code = (error as { code?: unknown })?.code;
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) return 409;
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) return 503;
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function transferErrorMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) return TENANT_DATA_LIMIT_REACHED_MESSAGE;
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) return TENANT_DATA_QUOTA_RECONCILING_MESSAGE;
  return error instanceof AppError ? error.message : fallback;
}

/** GET /api/course-authoring/transfer-targets */
export async function getTransferTargets(req: Request, res: Response) {
  if (!assertOutlineTransferOperator(req, res)) return;
  try {
    const tenantId = req.user?.tenantId;
    const sourceCourseId = typeof req.query.source_course_id === 'string' ? req.query.source_course_id : '';
    if (!tenantId || !sourceCourseId) return sendError(res, 'Thiếu khóa học nguồn.', 400);
    const result = await listTransferTargetCourses(tenantId, sourceCourseId, req.query.search, req.query.cursor);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, transferErrorMessage(error, 'Không thể tải danh sách khóa học nhận nội dung.'), transferErrorStatus(error));
  }
}

/**
 * GET /api/course-authoring/transfer-destination-options
 *
 * Returns exactly one selectable level at a time. The source type and every
 * selected ancestor are resolved server-side so the client cannot flatten or
 * forge a destination path across courses/tenants.
 */
export async function getTransferDestinationOptions(req: Request, res: Response) {
  if (!assertOutlineTransferOperator(req, res)) return;
  try {
    const tenantId = req.user?.tenantId;
    const sourceBlockId = typeof req.query.source_block_id === 'string' ? req.query.source_block_id : '';
    const destinationCourseId = typeof req.query.destination_course_id === 'string' ? req.query.destination_course_id : '';
    const parentIds = typeof req.query.parent_ids === 'string' && req.query.parent_ids.length > 0
      ? req.query.parent_ids.split(',').filter(Boolean)
      : [];
    if (!tenantId || !sourceBlockId || !destinationCourseId) {
      return sendError(res, 'Thiếu thông tin nội dung nguồn hoặc khóa học nhận nội dung.', 400);
    }
    const result = await listTransferDestinationOptions(
      tenantId,
      sourceBlockId,
      destinationCourseId,
      parentIds,
      req.query.search,
      req.query.page_size,
      req.query.cursor,
    );
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, transferErrorMessage(error, 'Không thể tải vị trí nhận nội dung.'), transferErrorStatus(error));
  }
}

/** GET /api/course-authoring/transfer-destination-parents */
export async function getTransferDestinationParents(req: Request, res: Response) {
  if (!assertOutlineTransferOperator(req, res)) return;
  try {
    const tenantId = req.user?.tenantId;
    const destinationCourseId = typeof req.query.destination_course_id === 'string' ? req.query.destination_course_id : '';
    const sourceBlockType = typeof req.query.source_block_type === 'string' ? req.query.source_block_type : '';
    if (!tenantId || !destinationCourseId || !sourceBlockType) return sendError(res, 'Thiếu thông tin vị trí nhận nội dung.', 400);
    const result = await listTransferDestinationParents(
      tenantId,
      destinationCourseId,
      sourceBlockType,
      req.query.search,
      req.query.page_size,
    );
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, transferErrorMessage(error, 'Không thể tải vị trí nhận nội dung.'), transferErrorStatus(error));
  }
}

/** POST /api/course-authoring/transfers */
export async function createOutlineTransfer(req: Request, res: Response) {
  if (!assertOutlineTransferOperator(req, res)) return;
  try {
    const tenantId = req.user?.tenantId;
    const body = req.body || {};
    if (!tenantId || !req.user?.id) return sendError(res, 'Không xác định được doanh nghiệp đang thao tác.', 403);
    const operation = body.operation as CourseOutlineTransferOperation;
    const result = await requestCourseOutlineTransfer({
      tenantId,
      requestedBy: req.user.id,
      requestedUsername: req.user.username,
      requestedIp: req.ip || null,
      sourceBlockId: body.source_block_id,
      destinationCourseId: body.destination_course_id,
      destinationParentId: body.destination_parent_id,
      destinationPathIds: body.destination_path_ids,
      operation,
      idempotencyKey: body.idempotency_key,
    });
    sendSuccess(res, result, 'Yêu cầu đã được đưa vào hàng đợi xử lý.', 202);
  } catch (error) {
    sendError(res, transferErrorMessage(error, 'Không thể tạo yêu cầu chuyển nội dung.'), transferErrorStatus(error));
  }
}

/** GET /api/course-authoring/transfers/:jobId */
export async function getOutlineTransfer(req: Request, res: Response) {
  if (!assertOutlineTransferOperator(req, res)) return;
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return sendError(res, 'Không xác định được doanh nghiệp đang thao tác.', 403);
    sendSuccess(res, await getCourseOutlineTransferJob(tenantId, req.params.jobId));
  } catch (error) {
    sendError(res, transferErrorMessage(error, 'Không thể tải trạng thái yêu cầu.'), transferErrorStatus(error));
  }
}
