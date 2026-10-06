import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCoursePublishPolicyTransition,
  buildCoursePublishCandidateIdentity,
  evaluateCoursePublishEligibility,
} from './course-publish-governance.logic.js';

const hash = (letter: string) => letter.repeat(64);
const base = () => ({
  tenant_id: 'tenant', course_id: 'course-v1:TEST+CP5+2026', target_block_id: 'target',
  policy: 'standard' as const, policy_version: 1,
  blocks: [
    { block_id: 'target', relation: 'target' as const, ordinal: 0, draft_hash: hash('a'), requires_quality: false },
    { block_id: 'child', relation: 'descendant' as const, ordinal: 1, draft_hash: hash('b'), requires_quality: true },
  ],
  assets: [{ asset_id: 'asset', asset_hash: hash('c') }],
});

test('candidate identity is deterministic but changes for content, structure, assets and policy revision', () => {
  const identity = buildCoursePublishCandidateIdentity(base());
  assert.deepEqual(identity, buildCoursePublishCandidateIdentity(base()));
  const changed = [
    { ...base(), blocks: base().blocks.map((item, index) => index ? { ...item, draft_hash: hash('d') } : item) },
    { ...base(), blocks: [base().blocks[0]!] },
    { ...base(), assets: [{ asset_id: 'asset', asset_hash: hash('d') }] },
    { ...base(), policy_version: 2 },
  ];
  for (const value of changed) {
    assert.notEqual(buildCoursePublishCandidateIdentity(value).candidate_hash, identity.candidate_hash);
  }
});

test('candidate rejects duplicate identities, gaps and oversized or malformed hashes', () => {
  assert.throws(() => buildCoursePublishCandidateIdentity({ ...base(), blocks: [base().blocks[0]!, base().blocks[0]!] }));
  assert.throws(() => buildCoursePublishCandidateIdentity({ ...base(), blocks: [{ ...base().blocks[0]!, ordinal: 2 }] }));
  assert.throws(() => buildCoursePublishCandidateIdentity({ ...base(), blocks: [{ ...base().blocks[0]!, draft_hash: 'bad' }] }));
});

test('high-risk policy cannot be downgraded through the ordinary policy transition', () => {
  assert.doesNotThrow(() => assertCoursePublishPolicyTransition(null, 'standard'));
  assert.doesNotThrow(() => assertCoursePublishPolicyTransition('standard', 'high_risk_hse'));
  assert.throws(() => assertCoursePublishPolicyTransition('high_risk_hse', 'standard'), /DOWNGRADE_FORBIDDEN/);
});

const evidence = () => ({ policy_current: true, candidate_expired: false, snapshot_current: true,
  approval_present: true, approval_current: true, reviewer_assignment_active: true,
  quality_receipt_present: true, quality_receipt_current: true,
  unresolved_critical_findings: 0, open_assessment_obligations: 0 });

test('standard requires a current candidate while high-risk additionally requires current quality and SME approval', () => {
  assert.deepEqual(evaluateCoursePublishEligibility('standard', evidence()), { eligible: true, blockers: [] });
  const highRisk = evaluateCoursePublishEligibility('high_risk_hse', {
    ...evidence(), approval_present: false, quality_receipt_present: false,
    unresolved_critical_findings: 1, open_assessment_obligations: 2,
  });
  assert.equal(highRisk.eligible, false);
  assert.deepEqual(highRisk.blockers, ['APPROVAL_REQUIRED', 'QUALITY_RECEIPT_MISSING',
    'CRITICAL_FINDINGS_UNRESOLVED', 'ASSESSMENT_OBLIGATIONS_OPEN']);
});

test('revoked reviewer, policy drift and stale snapshot are independent blockers', () => {
  const result = evaluateCoursePublishEligibility('high_risk_hse', {
    ...evidence(), policy_current: false, snapshot_current: false, reviewer_assignment_active: false,
  });
  assert.deepEqual(result.blockers, ['POLICY_CHANGED', 'CANDIDATE_STALE', 'REVIEWER_ASSIGNMENT_REVOKED']);
});
