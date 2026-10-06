import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { sendSuccess } from '../../utils/response.js';
import {
  approveCoursePublishCandidate,
  assignCoursePublishReviewer,
  CoursePublishGovernanceError,
  createCoursePublishCandidate,
  getCoursePublishCandidateEligibility,
  getCoursePublishGovernanceState,
  listCoursePublishReviewerOptions,
  mapCoursePublishGovernanceError,
  revokeCoursePublishReviewer,
  setCoursePublishPolicy,
} from './course-publish-governance.repository.js';
import { ensureCoursePublishGovernanceSchema } from './course-publish-governance-schema.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendGovernanceError(res: Response, error: unknown): void {
  const mapped = mapCoursePublishGovernanceError(error);
  res.status(mapped.statusCode).json({ success: false, code: mapped.code, message: mapped.message });
}

async function assertEnabled(): Promise<void> {
  if (!env.COURSE_PUBLISH_GOVERNANCE_ENABLED) {
    throw new CoursePublishGovernanceError(
      'COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE',
      503,
      'Kiểm soát xuất bản chưa được bật.',
    );
  }
  await ensureCoursePublishGovernanceSchema();
}

function assertPolicyAdmin(req: Request): void {
  if (!req.user || !['superuser', 'superadmin'].includes(req.user.role)) {
    throw new CoursePublishGovernanceError(
      'COURSE_PUBLISH_POLICY_FORBIDDEN',
      403,
      'Bạn không có quyền quản lý chính sách xuất bản.',
    );
  }
}

export async function getState(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    sendSuccess(res, await getCoursePublishGovernanceState(req.user!, req.params.courseId));
  } catch (error) { sendGovernanceError(res, error); }
}

export async function getCandidateEligibility(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    sendSuccess(res, await getCoursePublishCandidateEligibility(req.user!, req.params.candidateId));
  } catch (error) { sendGovernanceError(res, error); }
}

export async function listReviewerOptions(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    assertPolicyAdmin(req);
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    sendSuccess(res, await listCoursePublishReviewerOptions(req.user!, req.params.courseId, search));
  } catch (error) { sendGovernanceError(res, error); }
}

export async function setPolicy(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    assertPolicyAdmin(req);
    sendSuccess(res, await setCoursePublishPolicy(req.user!, req.params.courseId, req.body?.policy));
  } catch (error) { sendGovernanceError(res, error); }
}

export async function assignReviewer(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    assertPolicyAdmin(req);
    const scopeBlockId = String(req.body?.scope_block_id ?? '');
    const reviewerId = String(req.body?.reviewer_id ?? '');
    if (!UUID.test(scopeBlockId) || !UUID.test(reviewerId)) {
      throw new CoursePublishGovernanceError('COURSE_PUBLISH_REVIEWER_INELIGIBLE', 400,
        'Thông tin người duyệt hoặc phạm vi không hợp lệ.');
    }
    sendSuccess(res, await assignCoursePublishReviewer(req.user!, {
      courseId: req.params.courseId,
      scopeBlockId,
      reviewerId,
    }), undefined, 201);
  } catch (error) { sendGovernanceError(res, error); }
}

export async function revokeReviewer(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    assertPolicyAdmin(req);
    if (!UUID.test(req.params.assignmentId)) {
      throw new CoursePublishGovernanceError('COURSE_PUBLISH_ASSIGNMENT_FORBIDDEN', 400,
        'Mã phân công không hợp lệ.');
    }
    sendSuccess(res, await revokeCoursePublishReviewer(req.user!, req.params.assignmentId));
  } catch (error) { sendGovernanceError(res, error); }
}

export async function createCandidate(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    const targetBlockId = String(req.body?.target_block_id ?? '');
    const idempotencyKey = String(req.body?.idempotency_key ?? '');
    if (!UUID.test(targetBlockId) || !UUID.test(idempotencyKey)) {
      throw new CoursePublishGovernanceError('COURSE_PUBLISH_CANDIDATE_INVALID', 400,
        'Thông tin bản duyệt không hợp lệ.');
    }
    sendSuccess(res, await createCoursePublishCandidate(req.user!, {
      courseId: req.params.courseId,
      targetBlockId,
      idempotencyKey,
      ...(req.body?.ttl_minutes !== undefined ? { ttlMinutes: Number(req.body.ttl_minutes) } : {}),
    }), undefined, 201);
  } catch (error) { sendGovernanceError(res, error); }
}

export async function approveCandidate(req: Request, res: Response): Promise<void> {
  try {
    await assertEnabled();
    const assignmentId = String(req.body?.assignment_id ?? '');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    if (!UUID.test(req.params.candidateId) || !UUID.test(assignmentId)) {
      throw new CoursePublishGovernanceError('COURSE_PUBLISH_APPROVAL_FORBIDDEN', 400,
        'Thông tin phê duyệt không hợp lệ.');
    }
    sendSuccess(res, await approveCoursePublishCandidate(
      req.user!, req.params.candidateId, assignmentId, reason,
    ), undefined, 201);
  } catch (error) { sendGovernanceError(res, error); }
}
