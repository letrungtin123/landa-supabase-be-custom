import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthUser } from '../../types/express.js';
import { coursePublishHash } from './course-publish-governance.logic.js';
import {
  approveCoursePublishCandidate,
  CoursePublishGovernanceError,
  beginCoursePublishCandidate,
  createCoursePublishCandidate,
  getCoursePublishCandidateEligibility,
  listCoursePublishReviewerOptions,
  type CoursePublishCandidateRow,
} from './course-publish-governance.repository.js';

const actorId = '00000000-0000-4000-8000-000000000001';
const tenantId = '00000000-0000-4000-8000-000000000002';
const targetBlockId = '00000000-0000-4000-8000-000000000003';
const idempotencyKey = '00000000-0000-4000-8000-000000000004';

const subject = {
  id: actorId,
  tenantId,
  role: 'staff',
  sessionMode: 'normal',
} as AuthUser;

function candidate(overrides: Partial<CoursePublishCandidateRow> = {}): CoursePublishCandidateRow {
  return {
    id: '00000000-0000-4000-8000-000000000005',
    tenant_id: tenantId,
    course_id: 'course-v1:Nesso+CP5+2026',
    target_block_id: targetBlockId,
    policy: 'standard',
    policy_version: 1,
    candidate_hash: '1'.repeat(64),
    structure_hash: '2'.repeat(64),
    content_hash: '3'.repeat(64),
    asset_dependency_hash: '4'.repeat(64),
    block_count: 1,
    asset_count: 0,
    created_by: actorId,
    idempotency_key: idempotencyKey,
    request_hash: '5'.repeat(64),
    status: 'open',
    expires_at: '2026-10-07T00:00:00.000Z',
    created_at: '2026-10-06T00:00:00.000Z',
    published_at: null,
    published_by: null,
    ...overrides,
  };
}

test('candidate transaction takes the course lock before policy and immutable snapshots', async () => {
  const calls: string[] = [];
  const inserted = candidate();
  const sql = async (statement: string) => {
    calls.push(statement.replace(/\s+/g, ' ').trim());
    if (statement.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (statement.includes('FROM course_publish_policies')) return { rows: [{
      course_id: inserted.course_id, tenant_id: tenantId, policy: 'standard', policy_version: 1,
    }] };
    if (statement.includes('idempotency_key=$3')) return { rows: [] };
    if (statement.includes('WITH RECURSIVE subtree') && statement.includes('AS ordinal')) return { rows: [{
      block_id: targetBlockId, relation: 'target', ordinal: 0, authoring_revision: '7',
      draft_hash: 'a'.repeat(64), requires_quality: false,
    }] };
    if (statement.includes('WITH RECURSIVE subtree') && statement.includes('asset_hash')) return { rows: [] };
    if (statement.includes('INSERT INTO course_publish_candidates')) return { rows: [inserted] };
    if (statement.includes('INSERT INTO course_publish_candidate_blocks')) return { rows: [] };
    throw new Error(`unexpected SQL: ${statement}`);
  };
  let transactionCount = 0;
  const result = await createCoursePublishCandidate(subject, {
    courseId: inserted.course_id,
    targetBlockId,
    idempotencyKey,
  }, sql as never, async work => {
    transactionCount += 1;
    return work();
  });
  assert.equal(result.id, inserted.id);
  assert.equal(transactionCount, 1);
  assert.match(calls[0]!, /pg_advisory_xact_lock/);
  assert.ok(calls.findIndex(value => value.includes('FROM course_publish_policies'))
    < calls.findIndex(value => value.includes('WITH RECURSIVE subtree')));
  assert.ok(calls.findIndex(value => value.includes('WITH RECURSIVE subtree'))
    < calls.findIndex(value => value.includes('INSERT INTO course_publish_candidates')));
});

test('idempotency replay is actor and TTL bound and does not rebuild a snapshot', async () => {
  const courseId = 'course-v1:Nesso+CP5+2026';
  const requestHash = coursePublishHash({
    contract: 'course-publish-candidate-request-1', tenant_id: tenantId, course_id: courseId,
    target_block_id: targetBlockId, policy: 'standard', policy_version: 1,
    actor_id: actorId, ttl_minutes: 1_440,
  });
  let snapshotQueries = 0;
  const replay = candidate({ course_id: courseId, request_hash: requestHash });
  const sql = async (statement: string) => {
    if (statement.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (statement.includes('FROM course_publish_policies')) return { rows: [{
      course_id: courseId, tenant_id: tenantId, policy: 'standard', policy_version: 1,
    }] };
    if (statement.includes('idempotency_key=$3')) return { rows: [replay] };
    if (statement.includes('WITH RECURSIVE subtree')) snapshotQueries += 1;
    return { rows: [] };
  };
  const result = await createCoursePublishCandidate(subject, { courseId, targetBlockId, idempotencyKey },
    sql as never, async work => work());
  assert.equal(result.id, replay.id);
  assert.equal(snapshotQueries, 0);

  await assert.rejects(() => createCoursePublishCandidate(subject,
    { courseId, targetBlockId, idempotencyKey, ttlMinutes: 60 }, sql as never, async work => work()),
  (error: unknown) => error instanceof CoursePublishGovernanceError
    && error.code === 'COURSE_PUBLISH_CANDIDATE_STALE' && error.statusCode === 409);
});

test('invalid publish candidate identity is rejected before SQL', async () => {
  let called = false;
  await assert.rejects(() => beginCoursePublishCandidate({
    candidateId: 'not-a-uuid', tenantId, courseId: 'course-v1:Nesso+CP5+2026', targetBlockId, actorId,
  }, (async () => { called = true; return { rows: [] }; }) as never),
  (error: unknown) => error instanceof CoursePublishGovernanceError
    && error.code === 'COURSE_PUBLISH_CANDIDATE_INVALID' && error.statusCode === 400);
  assert.equal(called, false);
});

test('approval replay is immutable and conflicts when its assignment or reason changes', async () => {
  const assignmentId = '00000000-0000-4000-8000-000000000006';
  const existing = { assignment_id: assignmentId, reason: 'Đã đối chiếu phạm vi HSE.' };
  const sql = async (statement: string) => ({ rows: statement.includes('INSERT INTO') ? [] : [existing] });
  const replay = await approveCoursePublishCandidate(subject, candidate().id, assignmentId,
    existing.reason, sql as never);
  assert.equal(replay, existing);
  await assert.rejects(() => approveCoursePublishCandidate(subject, candidate().id, assignmentId,
    'Một quyết định phê duyệt khác.', sql as never),
  (error: unknown) => error instanceof CoursePublishGovernanceError
    && error.code === 'COURSE_PUBLISH_APPROVAL_CONFLICT' && error.statusCode === 409);
});

test('approval reason is bounded before SQL', async () => {
  let called = false;
  await assert.rejects(() => approveCoursePublishCandidate(subject, candidate().id,
    '00000000-0000-4000-8000-000000000006', 'ngắn',
    (async () => { called = true; return { rows: [] }; }) as never),
  (error: unknown) => error instanceof CoursePublishGovernanceError && error.statusCode === 400);
  assert.equal(called, false);
});

test('candidate eligibility is derived server-side without trusting a client readiness flag', async () => {
  const sql = async (statement: string) => {
    assert.match(statement, /course_publish_candidate_snapshot_matches/);
    assert.match(statement, /lesson_author_workspace_v2_assessment_obligations/);
    assert.match(statement, /semantic_review/);
    return { rows: [{
      ...candidate({ policy: 'high_risk_hse' }),
      target_display_name: 'Phạm vi HSE',
      policy_current: true,
      candidate_expired: false,
      snapshot_current: true,
      approval_present: false,
      approval_current: false,
      reviewer_assignment_active: false,
      required_quality_blocks: '2',
      observed_quality_blocks: '2',
      current_quality_blocks: '1',
      open_assessment_obligations: '1',
      unresolved_critical_findings: '2',
    }] };
  };
  const result = await getCoursePublishCandidateEligibility(subject, candidate().id, sql as never);
  assert.equal(result.eligible, false);
  assert.equal(result.target_display_name, 'Phạm vi HSE');
  assert.deepEqual(result.blockers, ['APPROVAL_REQUIRED', 'QUALITY_RECEIPT_STALE',
    'CRITICAL_FINDINGS_UNRESOLVED', 'ASSESSMENT_OBLIGATIONS_OPEN']);
  assert.equal(result.required_quality_blocks, 2);
  assert.equal(result.current_quality_blocks, 1);
});

test('published candidates remain viewable but never become an actionable eligible candidate', async () => {
  const sql = async () => ({ rows: [{
    ...candidate({ status: 'published' }),
    target_display_name: 'Đã xuất bản',
    policy_current: true,
    candidate_expired: false,
    snapshot_current: true,
    approval_present: false,
    approval_current: false,
    reviewer_assignment_active: false,
    required_quality_blocks: '0',
    observed_quality_blocks: '0',
    current_quality_blocks: '0',
    open_assessment_obligations: '0',
    unresolved_critical_findings: '0',
  }] });
  const result = await getCoursePublishCandidateEligibility(subject, candidate().id, sql as never);
  assert.equal(result.status, 'published');
  assert.equal(result.eligible, false);
  assert.deepEqual(result.blockers, []);
});

test('reviewer options are tenant-scoped, permission-checked and bounded', async () => {
  let params: unknown[] | undefined;
  const sql = async (statement: string, values?: unknown[]) => {
    params = values;
    assert.match(statement, /reviewer\.tenant_id=\$1/);
    assert.match(statement, /reviewer\.role IN \('staff','superuser'\)/);
    assert.match(statement, /course_publish_actor_has_permission\(reviewer\.id,\$1,'can_view'\)/);
    assert.match(statement, /LIMIT 50/);
    return { rows: [{ id: actorId, username: 'reviewer', full_name: 'Reviewer', role: 'staff' }] };
  };
  const result = await listCoursePublishReviewerOptions(subject, candidate().course_id, '  review  ', sql as never);
  assert.equal(result.length, 1);
  assert.deepEqual(params, [tenantId, candidate().course_id, 'review']);
});
