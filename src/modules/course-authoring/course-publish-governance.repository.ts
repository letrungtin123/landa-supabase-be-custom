import { randomUUID } from 'node:crypto';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import type { AuthUser } from '../../types/express.js';
import {
  buildCoursePublishCandidateIdentity,
  coursePublishHash,
  evaluateCoursePublishEligibility,
  readCoursePublishPolicy,
  type CoursePublishAssetSnapshot,
  type CoursePublishBlockSnapshot,
  type CoursePublishEligibilityBlocker,
  type CoursePublishPolicy,
} from './course-publish-governance.logic.js';

type Sql = Pick<typeof import('../../config/database.js'), 'query'>['query'];
type TransactionRunner = <T>(work: () => Promise<T>) => Promise<T>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const databaseTransaction: TransactionRunner = (work) => withDatabaseTransaction(() => work());

export interface CoursePublishPolicyRow {
  course_id: string;
  tenant_id: string;
  policy: CoursePublishPolicy;
  policy_version: number;
  set_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface CoursePublishCandidateRow {
  id: string;
  tenant_id: string;
  course_id: string;
  target_block_id: string;
  policy: CoursePublishPolicy;
  policy_version: number;
  candidate_hash: string;
  structure_hash: string;
  content_hash: string;
  asset_dependency_hash: string;
  block_count: number;
  asset_count: number;
  created_by: string;
  idempotency_key: string;
  request_hash: string;
  status: 'open' | 'published';
  expires_at: string;
  created_at: string;
  published_at: string | null;
  published_by: string | null;
}

export interface CoursePublishCandidateEligibility {
  candidate_id: string;
  course_id: string;
  target_block_id: string;
  target_display_name: string;
  policy: CoursePublishPolicy;
  status: 'open' | 'published';
  eligible: boolean;
  blockers: readonly CoursePublishEligibilityBlocker[];
  required_quality_blocks: number;
  current_quality_blocks: number;
  open_assessment_obligations: number;
  unresolved_critical_findings: number;
}

type CandidateEligibilityRow = CoursePublishCandidateRow & {
  target_display_name: string;
  policy_current: boolean;
  candidate_expired: boolean;
  snapshot_current: boolean;
  approval_present: boolean;
  approval_current: boolean;
  reviewer_assignment_active: boolean;
  required_quality_blocks: string | number;
  observed_quality_blocks: string | number;
  current_quality_blocks: string | number;
  open_assessment_obligations: string | number;
  unresolved_critical_findings: string | number;
};

export class CoursePublishGovernanceError extends AppError {
  constructor(code: string, statusCode: number, message: string) {
    super(message, statusCode, code);
    this.name = 'CoursePublishGovernanceError';
  }
}

const messages: Record<string, { status: number; message: string }> = {
  COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE: { status: 503, message: 'Kiểm soát xuất bản chưa sẵn sàng.' },
  COURSE_PUBLISH_GOVERNANCE_REQUIRED: { status: 409, message: 'Khóa học này phải được xuất bản qua bản duyệt hiện hành.' },
  COURSE_PUBLISH_CANDIDATE_REQUIRED: { status: 409, message: 'Cần tạo hoặc chọn bản duyệt trước khi xuất bản.' },
  COURSE_PUBLISH_CANDIDATE_NOT_FOUND: { status: 404, message: 'Không tìm thấy bản duyệt xuất bản.' },
  COURSE_PUBLISH_CANDIDATE_EXPIRED: { status: 409, message: 'Bản duyệt đã hết hạn. Hãy tạo bản duyệt mới.' },
  COURSE_PUBLISH_CANDIDATE_STALE: { status: 409, message: 'Nội dung hoặc cấu trúc đã thay đổi. Hãy tạo bản duyệt mới.' },
  COURSE_PUBLISH_CANDIDATE_INVALID: { status: 400, message: 'Thông tin bản duyệt không hợp lệ.' },
  COURSE_PUBLISH_CANDIDATE_AUTHORITY_INVALID: { status: 403, message: 'Bạn không có quyền tạo bản duyệt cho khóa học này.' },
  COURSE_PUBLISH_CANDIDATE_MANIFEST_INCOMPLETE: { status: 409, message: 'Bản duyệt chưa ghi nhận đầy đủ nội dung phụ thuộc.' },
  COURSE_PUBLISH_POLICY_CHANGED: { status: 409, message: 'Chính sách xuất bản đã thay đổi. Hãy tạo bản duyệt mới.' },
  COURSE_PUBLISH_POLICY_INVALID: { status: 400, message: 'Chính sách xuất bản không hợp lệ.' },
  COURSE_PUBLISH_POLICY_DOWNGRADE_FORBIDDEN: { status: 409, message: 'Không thể hạ cấp chính sách khóa học HSE.' },
  COURSE_PUBLISH_APPROVAL_REQUIRED: { status: 409, message: 'Bản duyệt cần được chuyên gia được phân công phê duyệt.' },
  COURSE_PUBLISH_APPROVAL_FORBIDDEN: { status: 403, message: 'Bạn không đủ điều kiện phê duyệt phạm vi này.' },
  COURSE_PUBLISH_APPROVAL_CONFLICT: { status: 409, message: 'Bản duyệt đã có một quyết định phê duyệt khác.' },
  COURSE_PUBLISH_REVIEWER_INELIGIBLE: { status: 422, message: 'Người duyệt không có phạm vi hoặc quyền xem phù hợp.' },
  COURSE_PUBLISH_QUALITY_RECEIPT_STALE: { status: 422, message: 'Bằng chứng chất lượng không còn áp dụng cho nội dung hiện tại.' },
  COURSE_PUBLISH_ASSESSMENT_REVIEW_REQUIRED: { status: 422, message: 'Vẫn còn yêu cầu đánh giá cần được xử lý.' },
  COURSE_PUBLISH_CRITICAL_FINDINGS_UNRESOLVED: { status: 422, message: 'Vẫn còn phát hiện nghiêm trọng chưa được xử lý.' },
  COURSE_PUBLISH_COMMIT_INVALID: { status: 409, message: 'Nội dung thay đổi trong lúc xuất bản. Chưa có dữ liệu nào được công khai.' },
  COURSE_PUBLISH_COMMIT_RECEIPT_MISSING: { status: 409, message: 'Giao dịch xuất bản thiếu bằng chứng xác nhận.' },
  COURSE_PUBLISH_FORBIDDEN: { status: 403, message: 'Bạn không có quyền xuất bản khóa học này.' },
  COURSE_PUBLISH_POLICY_FORBIDDEN: { status: 403, message: 'Bạn không có quyền thay đổi chính sách xuất bản.' },
  COURSE_PUBLISH_ASSIGNMENT_FORBIDDEN: { status: 403, message: 'Bạn không có quyền phân công người duyệt.' },
  COURSE_PUBLISH_ASSIGNMENT_TRANSITION_INVALID: { status: 409, message: 'Trạng thái phân công người duyệt không hợp lệ.' },
  COURSE_PUBLISH_RECEIPT_MISSING: { status: 409, message: 'Bản duyệt đã xuất bản nhưng thiếu bằng chứng xác nhận.' },
};

export function mapCoursePublishGovernanceError(error: unknown): CoursePublishGovernanceError {
  if (error instanceof CoursePublishGovernanceError) return error;
  const raw = error instanceof Error ? error.message : '';
  const code = Object.keys(messages).find(candidate => raw.includes(candidate))
    ?? 'COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE';
  const mapped = messages[code]!;
  return new CoursePublishGovernanceError(code, mapped.status, mapped.message);
}

function requireContext(subject: AuthUser): { actorId: string; tenantId: string } {
  if (!UUID.test(subject.id) || !subject.tenantId || !UUID.test(subject.tenantId)
    || subject.sessionMode !== 'normal') {
    throw new CoursePublishGovernanceError('COURSE_PUBLISH_FORBIDDEN', 403, messages.COURSE_PUBLISH_FORBIDDEN!.message);
  }
  return { actorId: subject.id, tenantId: subject.tenantId };
}

export async function getCoursePublishPolicyForBlock(
  blockId: string,
  tenantId: string,
  sql: Sql = query,
): Promise<CoursePublishPolicyRow | null> {
  try {
    const result = await sql<CoursePublishPolicyRow>(`SELECT policy.*
      FROM course_blocks block JOIN courses course ON course.id=block.course_id
      LEFT JOIN course_publish_policies policy ON policy.course_id=block.course_id AND policy.tenant_id=course.tenant_id
      WHERE block.id=$1 AND block.deleted_at IS NULL AND course.deleted_at IS NULL AND course.tenant_id=$2`,
    [blockId, tenantId]);
    const row = result.rows[0];
    if (!row || !row.course_id) return null;
    return { ...row, policy: readCoursePublishPolicy(row.policy), policy_version: Number(row.policy_version) };
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function setCoursePublishPolicy(
  subject: AuthUser,
  courseId: string,
  policyInput: unknown,
  sql: Sql = query,
): Promise<CoursePublishPolicyRow> {
  const { actorId, tenantId } = requireContext(subject);
  const policy = readCoursePublishPolicy(policyInput);
  try {
    const result = await sql<CoursePublishPolicyRow>(`INSERT INTO course_publish_policies
        (course_id,tenant_id,policy,set_by,updated_by)
      VALUES($1,$2,$3,$4,$4)
      ON CONFLICT(course_id) DO UPDATE SET policy=EXCLUDED.policy,updated_by=EXCLUDED.updated_by
      RETURNING *`, [courseId, tenantId, policy, actorId]);
    if (result.rows.length !== 1) throw new Error('COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE');
    return { ...result.rows[0]!, policy: readCoursePublishPolicy(result.rows[0]!.policy),
      policy_version: Number(result.rows[0]!.policy_version) };
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function assignCoursePublishReviewer(
  subject: AuthUser,
  input: { courseId: string; scopeBlockId: string; reviewerId: string },
  sql: Sql = query,
) {
  const { actorId, tenantId } = requireContext(subject);
  try {
    const result = await sql(`INSERT INTO course_publish_reviewer_assignments
        (tenant_id,course_id,scope_block_id,reviewer_id,specialization,assigned_by)
      VALUES($1,$2,$3,$4,'hse_sme',$5) RETURNING *`,
    [tenantId, input.courseId, input.scopeBlockId, input.reviewerId, actorId]);
    if (result.rows.length !== 1) throw new Error('COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE');
    return result.rows[0];
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function revokeCoursePublishReviewer(
  subject: AuthUser,
  assignmentId: string,
  sql: Sql = query,
) {
  const { actorId, tenantId } = requireContext(subject);
  try {
    const result = await sql(`UPDATE course_publish_reviewer_assignments
      SET status='revoked',revoked_by=$3 WHERE id=$1 AND tenant_id=$2 AND status='active' RETURNING *`,
    [assignmentId, tenantId, actorId]);
    if (result.rows.length !== 1) throw new Error('COURSE_PUBLISH_ASSIGNMENT_FORBIDDEN');
    return result.rows[0];
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

type SnapshotRow = CoursePublishBlockSnapshot & { authoring_revision: string | number };
type AssetRow = CoursePublishAssetSnapshot & { authoring_revision: string | number };

async function loadBlockSnapshot(sql: Sql, tenantId: string, courseId: string, targetBlockId: string): Promise<SnapshotRow[]> {
  const result = await sql<SnapshotRow>(`WITH RECURSIVE subtree AS (
      SELECT block.id,block.parent_id,ARRAY[block.sort_order]::integer[] AS path,0 AS depth
      FROM course_blocks block JOIN courses course ON course.id=block.course_id
      WHERE block.id=$3 AND block.course_id=$2 AND course.tenant_id=$1
        AND block.deleted_at IS NULL AND course.deleted_at IS NULL
      UNION ALL
      SELECT child.id,child.parent_id,parent.path||child.sort_order,parent.depth+1
      FROM course_blocks child JOIN subtree parent ON child.parent_id=parent.id
      WHERE child.course_id=$2 AND child.deleted_at IS NULL
    ), ancestors AS (
      SELECT parent.id,parent.parent_id,1 AS depth FROM course_blocks target
      JOIN course_blocks parent ON parent.id=target.parent_id
      WHERE target.id=$3 AND target.course_id=$2 AND target.deleted_at IS NULL AND parent.deleted_at IS NULL
      UNION ALL
      SELECT parent.id,parent.parent_id,child.depth+1 FROM course_blocks parent
      JOIN ancestors child ON parent.id=child.parent_id
      WHERE parent.course_id=$2 AND parent.deleted_at IS NULL
    ), ordered AS (
      SELECT s.id,CASE WHEN s.id=$3 THEN 'target' ELSE 'descendant' END AS relation,
        CASE WHEN s.id=$3 THEN 0 ELSE 1 END AS group_order,s.path,s.depth FROM subtree s
      UNION ALL SELECT a.id,'ancestor',2,ARRAY[a.depth]::integer[],a.depth FROM ancestors a
    )
    SELECT block.id::text AS block_id,ordered.relation,0::integer AS ordinal,
      revision.authoring_revision,public.course_publish_block_draft_hash(block.id,$2,$1) AS draft_hash,
      (block.block_type::text NOT IN ('course','chapter','sequential','vertical')
        AND block.metadata->>'generated_by'='lesson_author_ai'
        AND block.metadata->>'workspace_id' IS NOT NULL) AS requires_quality
    FROM ordered JOIN course_blocks block ON block.id=ordered.id
    JOIN course_publish_block_revisions revision ON revision.block_id=block.id
      AND revision.tenant_id=$1 AND revision.course_id=$2
    ORDER BY ordered.group_order,ordered.path,block.id`, [tenantId, courseId, targetBlockId]);
  return result.rows.map((row, ordinal) => ({ ...row, ordinal,
    authoring_revision: Number(row.authoring_revision), requires_quality: row.requires_quality === true }));
}

async function loadAssetSnapshot(sql: Sql, tenantId: string, courseId: string, targetBlockId: string): Promise<AssetRow[]> {
  const result = await sql<AssetRow>(`WITH RECURSIVE subtree AS (
      SELECT id FROM course_blocks WHERE id=$3 AND course_id=$2 AND deleted_at IS NULL
      UNION ALL SELECT child.id FROM course_blocks child JOIN subtree parent ON child.parent_id=parent.id
        WHERE child.course_id=$2 AND child.deleted_at IS NULL
    ), referenced AS (
      SELECT DISTINCT asset.id FROM course_assets asset WHERE asset.course_id=$2 AND asset.tenant_id=$1
        AND EXISTS(SELECT 1 FROM subtree item JOIN course_blocks block ON block.id=item.id
          WHERE (COALESCE(asset.storage_path,'')<>'' AND (
              position(asset.storage_path in COALESCE(block.data::text,''))>0
              OR position(asset.storage_path in COALESCE(block.metadata::text,''))>0))
            OR (COALESCE(asset.url,'')<>'' AND (
              position(asset.url in COALESCE(block.data::text,''))>0
              OR position(asset.url in COALESCE(block.metadata::text,''))>0)))
    )
    SELECT asset.id::text AS asset_id,revision.authoring_revision,
      public.course_publish_asset_hash(asset.id,$2,$1) AS asset_hash
    FROM referenced JOIN course_assets asset ON asset.id=referenced.id
    JOIN course_publish_asset_revisions revision ON revision.asset_id=asset.id
      AND revision.tenant_id=$1 AND revision.course_id=$2
    ORDER BY asset.id`, [tenantId, courseId, targetBlockId]);
  return result.rows.map(row => ({ ...row, authoring_revision: Number(row.authoring_revision) }));
}

export async function createCoursePublishCandidate(
  subject: AuthUser,
  input: { courseId: string; targetBlockId: string; idempotencyKey: string; ttlMinutes?: number },
  sql: Sql = query,
  transaction: TransactionRunner = databaseTransaction,
): Promise<CoursePublishCandidateRow> {
  const { actorId, tenantId } = requireContext(subject);
  if (!UUID.test(input.targetBlockId) || !UUID.test(input.idempotencyKey)) {
    throw new CoursePublishGovernanceError('COURSE_PUBLISH_CANDIDATE_INVALID', 400, 'Thông tin bản duyệt không hợp lệ.');
  }
  const ttlMinutes = input.ttlMinutes ?? 1_440;
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 10_080) {
    throw new CoursePublishGovernanceError('COURSE_PUBLISH_CANDIDATE_INVALID', 400, 'Thời hạn bản duyệt không hợp lệ.');
  }
  try {
    return await transaction(async () => {
      await sql(`SELECT pg_advisory_xact_lock(hashtextextended('course:'||$1::text||':'||$2,20261006))`,
        [tenantId, input.courseId]);
      const policyResult = await sql<CoursePublishPolicyRow>(`SELECT * FROM course_publish_policies
        WHERE tenant_id=$1 AND course_id=$2 FOR SHARE`, [tenantId, input.courseId]);
      const policyRow = policyResult.rows[0];
      if (!policyRow) throw new Error('COURSE_PUBLISH_GOVERNANCE_REQUIRED');
      const policy = readCoursePublishPolicy(policyRow.policy);
      const policyVersion = Number(policyRow.policy_version);
      const requestHash = coursePublishHash({ contract: 'course-publish-candidate-request-1',
        tenant_id: tenantId, course_id: input.courseId, target_block_id: input.targetBlockId,
        policy, policy_version: policyVersion, actor_id: actorId, ttl_minutes: ttlMinutes });
      const existing = await sql<CoursePublishCandidateRow>(`SELECT * FROM course_publish_candidates
        WHERE tenant_id=$1 AND course_id=$2 AND idempotency_key=$3`,
      [tenantId, input.courseId, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new Error('COURSE_PUBLISH_CANDIDATE_STALE');
        }
        return existing.rows[0];
      }
      const blocks = await loadBlockSnapshot(sql, tenantId, input.courseId, input.targetBlockId);
      const assets = await loadAssetSnapshot(sql, tenantId, input.courseId, input.targetBlockId);
      const identity = buildCoursePublishCandidateIdentity({ tenant_id: tenantId, course_id: input.courseId,
        target_block_id: input.targetBlockId, policy, policy_version: policyVersion, blocks, assets });
      const candidateId = randomUUID();
      const inserted = await sql<CoursePublishCandidateRow>(`INSERT INTO course_publish_candidates
          (id,tenant_id,course_id,target_block_id,policy,policy_version,candidate_hash,structure_hash,
           content_hash,asset_dependency_hash,block_count,asset_count,created_by,idempotency_key,request_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          clock_timestamp()+($16::integer*INTERVAL '1 minute')) RETURNING *`,
      [candidateId, tenantId, input.courseId, input.targetBlockId, policy, policyVersion,
        identity.candidate_hash, identity.structure_hash, identity.content_hash, identity.asset_dependency_hash,
        identity.block_count, identity.asset_count, actorId, input.idempotencyKey, requestHash, ttlMinutes]);
      await sql(`INSERT INTO course_publish_candidate_blocks
          (candidate_id,tenant_id,course_id,block_id,relation,ordinal,authoring_revision,draft_hash,requires_quality)
        SELECT $1,$2,$3,item.block_id,item.relation,item.ordinal,item.authoring_revision,item.draft_hash,item.requires_quality
        FROM jsonb_to_recordset($4::jsonb) AS item(block_id uuid,relation varchar,ordinal integer,
          authoring_revision bigint,draft_hash varchar,requires_quality boolean)`,
      [candidateId, tenantId, input.courseId, JSON.stringify(blocks)]);
      if (assets.length > 0) await sql(`INSERT INTO course_publish_candidate_assets
          (candidate_id,tenant_id,course_id,asset_id,authoring_revision,asset_hash)
        SELECT $1,$2,$3,item.asset_id,item.authoring_revision,item.asset_hash
        FROM jsonb_to_recordset($4::jsonb) AS item(asset_id uuid,authoring_revision bigint,asset_hash varchar)`,
      [candidateId, tenantId, input.courseId, JSON.stringify(assets)]);
      return inserted.rows[0]!;
    });
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function approveCoursePublishCandidate(
  subject: AuthUser,
  candidateId: string,
  assignmentId: string,
  reasonInput: string,
  sql: Sql = query,
) {
  const { actorId, tenantId } = requireContext(subject);
  const reason = reasonInput.trim();
  if (reason.length < 8 || reason.length > 1_000 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new CoursePublishGovernanceError('COURSE_PUBLISH_APPROVAL_FORBIDDEN', 400,
      'Lý do phê duyệt phải từ 8 đến 1000 ký tự và không chứa ký tự điều khiển.');
  }
  try {
    const result = await sql(`INSERT INTO course_publish_approvals
        (candidate_id,tenant_id,course_id,reviewer_id,reviewer_role,assignment_id,candidate_hash,policy_version,reason)
      SELECT candidate.id,candidate.tenant_id,candidate.course_id,$3,reviewer.role::text,$4,
        candidate.candidate_hash,candidate.policy_version,$5
      FROM course_publish_candidates candidate JOIN users reviewer ON reviewer.id=$3
      WHERE candidate.id=$1 AND candidate.tenant_id=$2
      ON CONFLICT(candidate_id,reviewer_id) DO NOTHING RETURNING *`,
    [candidateId, tenantId, actorId, assignmentId, reason]);
    if (result.rows.length === 1) return result.rows[0];
    const replay = await sql(`SELECT * FROM course_publish_approvals
      WHERE candidate_id=$1 AND tenant_id=$2 AND reviewer_id=$3`, [candidateId, tenantId, actorId]);
    if (replay.rows.length !== 1) throw new Error('COURSE_PUBLISH_APPROVAL_FORBIDDEN');
    if (replay.rows[0]?.assignment_id !== assignmentId || replay.rows[0]?.reason !== reason) {
      throw new Error('COURSE_PUBLISH_APPROVAL_CONFLICT');
    }
    return replay.rows[0];
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function getCoursePublishGovernanceState(
  subject: AuthUser,
  courseId: string,
  sql: Sql = query,
) {
  const { tenantId } = requireContext(subject);
  try {
    const [policy, assignments, candidates, approvals] = await Promise.all([
      sql(`SELECT * FROM course_publish_policies WHERE tenant_id=$1 AND course_id=$2`, [tenantId, courseId]),
      sql(`SELECT assignment.*,reviewer.username AS reviewer_username
        FROM course_publish_reviewer_assignments assignment JOIN users reviewer ON reviewer.id=assignment.reviewer_id
        WHERE assignment.tenant_id=$1 AND assignment.course_id=$2 ORDER BY assignment.created_at DESC`, [tenantId, courseId]),
      sql(`SELECT candidate.*,target.display_name AS target_display_name,
          EXISTS(SELECT 1 FROM course_publish_approvals approval
          JOIN course_publish_reviewer_assignments assignment ON assignment.id=approval.assignment_id
          WHERE approval.candidate_id=candidate.id AND assignment.status='active') AS has_active_approval
        FROM course_publish_candidates candidate
        JOIN course_blocks target ON target.id=candidate.target_block_id
          AND target.course_id=candidate.course_id AND target.deleted_at IS NULL
        WHERE candidate.tenant_id=$1 AND candidate.course_id=$2
        ORDER BY candidate.created_at DESC LIMIT 50`, [tenantId, courseId]),
      sql(`SELECT approval.id,approval.candidate_id,approval.reviewer_id,approval.reviewer_role,
          approval.assignment_id,approval.candidate_hash,approval.policy_version,approval.reason,approval.approved_at,
          reviewer.username AS reviewer_username
        FROM course_publish_approvals approval JOIN users reviewer ON reviewer.id=approval.reviewer_id
        WHERE approval.tenant_id=$1 AND approval.course_id=$2 ORDER BY approval.approved_at DESC,approval.id DESC
        LIMIT 100`, [tenantId, courseId]),
    ]);
    return { policy: policy.rows[0] ?? null, assignments: assignments.rows,
      candidates: candidates.rows, approvals: approvals.rows };
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function listCoursePublishReviewerOptions(
  subject: AuthUser,
  courseId: string,
  searchInput = '',
  sql: Sql = query,
) {
  const { tenantId } = requireContext(subject);
  const search = searchInput.trim().slice(0, 100);
  try {
    const result = await sql(`SELECT reviewer.id,reviewer.username,reviewer.full_name,reviewer.email,reviewer.role
      FROM users reviewer
      JOIN courses course ON course.id=$2 AND course.tenant_id=$1 AND course.deleted_at IS NULL
      WHERE reviewer.tenant_id=$1 AND reviewer.is_active=true AND reviewer.deletion_requested_at IS NULL
        AND reviewer.role IN ('staff','superuser')
        AND public.course_publish_actor_has_permission(reviewer.id,$1,'can_view')
        AND ($3='' OR reviewer.username ILIKE '%'||$3||'%' OR reviewer.full_name ILIKE '%'||$3||'%'
          OR reviewer.email ILIKE '%'||$3||'%')
      ORDER BY lower(COALESCE(NULLIF(reviewer.full_name,''),reviewer.username)),reviewer.id
      LIMIT 50`, [tenantId, courseId, search]);
    return result.rows;
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function getCoursePublishCandidateEligibility(
  subject: AuthUser,
  candidateId: string,
  sql: Sql = query,
): Promise<CoursePublishCandidateEligibility> {
  const { tenantId } = requireContext(subject);
  if (!UUID.test(candidateId)) {
    throw new CoursePublishGovernanceError('COURSE_PUBLISH_CANDIDATE_INVALID', 400,
      messages.COURSE_PUBLISH_CANDIDATE_INVALID!.message);
  }
  try {
    const result = await sql<CandidateEligibilityRow>(`SELECT candidate.*,target.display_name AS target_display_name,
        (policy.course_id IS NOT NULL AND policy.policy=candidate.policy
          AND policy.policy_version=candidate.policy_version) AS policy_current,
        candidate.expires_at<=clock_timestamp() AS candidate_expired,
        public.course_publish_candidate_snapshot_matches(candidate.id) AS snapshot_current,
        EXISTS(SELECT 1 FROM course_publish_approvals approval
          WHERE approval.candidate_id=candidate.id) AS approval_present,
        EXISTS(SELECT 1 FROM course_publish_approvals approval
          WHERE approval.candidate_id=candidate.id AND approval.candidate_hash=candidate.candidate_hash
            AND approval.policy_version=candidate.policy_version) AS approval_current,
        EXISTS(SELECT 1 FROM course_publish_approvals approval
          JOIN course_publish_reviewer_assignments assignment ON assignment.id=approval.assignment_id
          JOIN users reviewer ON reviewer.id=approval.reviewer_id
          WHERE approval.candidate_id=candidate.id AND approval.candidate_hash=candidate.candidate_hash
            AND approval.policy_version=candidate.policy_version AND assignment.status='active'
            AND approval.reviewer_id<>candidate.created_by AND reviewer.is_active=true
            AND public.course_publish_actor_has_permission(reviewer.id,candidate.tenant_id,'can_view'))
          AS reviewer_assignment_active,
        (SELECT count(*) FROM course_publish_candidate_blocks snapshot
          WHERE snapshot.candidate_id=candidate.id AND snapshot.relation IN ('target','descendant')
            AND snapshot.requires_quality=true) AS required_quality_blocks,
        (SELECT count(DISTINCT snapshot.block_id)
          FROM course_publish_candidate_blocks snapshot
          JOIN lesson_author_workspace_apply_mappings mapping ON mapping.target_block_id=snapshot.block_id
            AND mapping.tenant_id=candidate.tenant_id AND mapping.course_id=candidate.course_id
          JOIN lesson_author_workspace_apply_receipts apply ON apply.id=mapping.receipt_id
            AND apply.workspace_id=mapping.workspace_id AND apply.tenant_id=mapping.tenant_id
            AND apply.course_id=mapping.course_id
          JOIN lesson_author_workspace_quality_receipts quality ON quality.id=apply.quality_receipt_id
            AND quality.workspace_id=apply.workspace_id AND quality.tenant_id=apply.tenant_id
            AND quality.course_id=apply.course_id
          WHERE snapshot.candidate_id=candidate.id AND snapshot.relation IN ('target','descendant')
            AND snapshot.requires_quality=true) AS observed_quality_blocks,
        (SELECT count(DISTINCT snapshot.block_id)
          FROM course_publish_candidate_blocks snapshot
          JOIN lesson_author_workspace_apply_mappings mapping ON mapping.target_block_id=snapshot.block_id
            AND mapping.tenant_id=candidate.tenant_id AND mapping.course_id=candidate.course_id
          JOIN lesson_author_workspace_apply_receipts apply ON apply.id=mapping.receipt_id
            AND apply.workspace_id=mapping.workspace_id AND apply.tenant_id=mapping.tenant_id
            AND apply.course_id=mapping.course_id
          JOIN lesson_author_workspace_quality_receipts quality ON quality.id=apply.quality_receipt_id
            AND quality.workspace_id=apply.workspace_id AND quality.tenant_id=apply.tenant_id
            AND quality.course_id=apply.course_id
          JOIN course_publish_block_revisions current_revision ON current_revision.block_id=snapshot.block_id
            AND current_revision.tenant_id=candidate.tenant_id AND current_revision.course_id=candidate.course_id
          WHERE snapshot.candidate_id=candidate.id AND snapshot.relation IN ('target','descendant')
            AND snapshot.requires_quality=true AND apply.validation_contract='workspace-scoped-apply-2'
            AND quality.revision_set_hash=apply.revision_set_hash AND quality.scope_node_id=apply.scope_node_id
            AND quality.source_snapshot_hash=apply.source_snapshot_hash AND quality.checks=apply.checks
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(quality.findings) finding
              WHERE finding->>'status' IN ('FAIL','ERROR'))
            AND current_revision.authoring_revision=snapshot.authoring_revision
            AND current_revision.updated_at<=mapping.updated_at) AS current_quality_blocks,
        (SELECT count(*) FROM lesson_author_workspace_v2_assessment_obligations obligation
          WHERE obligation.status='open' AND obligation.tenant_id=candidate.tenant_id
            AND obligation.course_id=candidate.course_id AND EXISTS(
              SELECT 1 FROM course_publish_candidate_blocks snapshot
              JOIN lesson_author_workspace_apply_mappings mapping ON mapping.target_block_id=snapshot.block_id
                AND mapping.tenant_id=candidate.tenant_id AND mapping.course_id=candidate.course_id
              JOIN lesson_author_workspace_nodes node ON node.workspace_id=mapping.workspace_id
                AND node.id=mapping.node_id AND node.tenant_id=mapping.tenant_id AND node.course_id=mapping.course_id
              WHERE snapshot.candidate_id=candidate.id AND snapshot.relation IN ('target','descendant')
                AND snapshot.requires_quality=true AND mapping.workspace_id=obligation.workspace_id
                AND obligation.unit_path=CASE WHEN node.kind='component'
                  THEN regexp_replace(node.canonical_path,'\\.component_[1-9][0-9]*$','') ELSE node.canonical_path END))
          AS open_assessment_obligations,
        (SELECT count(*) FROM (
          SELECT DISTINCT mapping.workspace_id,CASE WHEN node.kind='component'
              THEN regexp_replace(node.canonical_path,'\\.component_[1-9][0-9]*$','') ELSE node.canonical_path END AS unit_path
          FROM course_publish_candidate_blocks snapshot
          JOIN lesson_author_workspace_apply_mappings mapping ON mapping.target_block_id=snapshot.block_id
            AND mapping.tenant_id=candidate.tenant_id AND mapping.course_id=candidate.course_id
          JOIN lesson_author_workspace_nodes node ON node.workspace_id=mapping.workspace_id
            AND node.id=mapping.node_id AND node.tenant_id=mapping.tenant_id AND node.course_id=mapping.course_id
          WHERE snapshot.candidate_id=candidate.id AND snapshot.relation IN ('target','descendant')
            AND snapshot.requires_quality=true
        ) scoped_unit JOIN LATERAL (
          SELECT artifact.payload FROM lesson_author_workspace_v2_artifacts artifact
          WHERE artifact.workspace_id=scoped_unit.workspace_id AND artifact.tenant_id=candidate.tenant_id
            AND artifact.course_id=candidate.course_id AND artifact.artifact_kind='unit_baseline'
            AND artifact.payload->>'unit_path'=scoped_unit.unit_path
          ORDER BY artifact.created_at DESC,artifact.id DESC LIMIT 1
        ) current_artifact ON true
        WHERE COALESCE((current_artifact.payload->'semantic_review'->'finding_counts'->>'critical')::integer,0)>0)
          AS unresolved_critical_findings
      FROM course_publish_candidates candidate
      JOIN course_blocks target ON target.id=candidate.target_block_id
        AND target.course_id=candidate.course_id AND target.deleted_at IS NULL
      LEFT JOIN course_publish_policies policy ON policy.course_id=candidate.course_id
        AND policy.tenant_id=candidate.tenant_id
      WHERE candidate.id=$1 AND candidate.tenant_id=$2`, [candidateId, tenantId]);
    const row = result.rows[0];
    if (!row) throw new Error('COURSE_PUBLISH_CANDIDATE_NOT_FOUND');
    const requiredQuality = Number(row.required_quality_blocks);
    const observedQuality = Number(row.observed_quality_blocks);
    const currentQuality = Number(row.current_quality_blocks);
    const openObligations = Number(row.open_assessment_obligations);
    const criticalFindings = Number(row.unresolved_critical_findings);
    const evaluated = evaluateCoursePublishEligibility(readCoursePublishPolicy(row.policy), {
      policy_current: row.policy_current === true,
      candidate_expired: row.candidate_expired === true,
      snapshot_current: row.snapshot_current === true,
      approval_present: row.approval_present === true,
      approval_current: row.approval_current === true,
      reviewer_assignment_active: row.reviewer_assignment_active === true,
      quality_receipt_present: requiredQuality > 0 && observedQuality > 0,
      quality_receipt_current: requiredQuality > 0 && currentQuality === requiredQuality,
      unresolved_critical_findings: criticalFindings,
      open_assessment_obligations: openObligations,
    });
    return {
      candidate_id: row.id,
      course_id: row.course_id,
      target_block_id: row.target_block_id,
      target_display_name: row.target_display_name,
      policy: readCoursePublishPolicy(row.policy),
      status: row.status,
      eligible: row.status === 'open' && evaluated.eligible,
      blockers: row.status === 'open' ? evaluated.blockers : Object.freeze([]),
      required_quality_blocks: requiredQuality,
      current_quality_blocks: currentQuality,
      open_assessment_obligations: openObligations,
      unresolved_critical_findings: criticalFindings,
    };
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function beginCoursePublishCandidate(
  input: { candidateId: string; tenantId: string; courseId: string; targetBlockId: string; actorId: string },
  sql: Sql = query,
): Promise<{ already_published: boolean; policy: CoursePublishPolicy }> {
  if (![input.candidateId, input.tenantId, input.targetBlockId, input.actorId].every(value => UUID.test(value))) {
    throw new CoursePublishGovernanceError('COURSE_PUBLISH_CANDIDATE_INVALID', 400,
      messages.COURSE_PUBLISH_CANDIDATE_INVALID!.message);
  }
  try {
    const result = await sql<{ already_published: boolean; policy: CoursePublishPolicy }>(
      `SELECT * FROM begin_course_publish_candidate($1,$2,$3,$4,$5)`,
      [input.candidateId, input.tenantId, input.courseId, input.targetBlockId, input.actorId]);
    const row = result.rows[0];
    if (!row) throw new Error('COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE');
    return { already_published: row.already_published === true, policy: readCoursePublishPolicy(row.policy) };
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}

export async function finishCoursePublishCandidate(
  candidateId: string,
  actorId: string,
  sql: Sql = query,
): Promise<string> {
  try {
    const result = await sql<{ receipt_id: string }>(
      `SELECT finish_course_publish_candidate($1,$2)::text AS receipt_id`, [candidateId, actorId]);
    if (!result.rows[0]?.receipt_id) throw new Error('COURSE_PUBLISH_COMMIT_INVALID');
    return result.rows[0].receipt_id;
  } catch (error) { throw mapCoursePublishGovernanceError(error); }
}
