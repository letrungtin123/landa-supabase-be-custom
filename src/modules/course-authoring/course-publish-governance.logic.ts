import { createHash } from 'node:crypto';

export const COURSE_PUBLISH_POLICIES = ['standard', 'high_risk_hse'] as const;
export type CoursePublishPolicy = (typeof COURSE_PUBLISH_POLICIES)[number];

export const COURSE_PUBLISH_GOVERNANCE_CONTRACT = 'course-publish-governance-1' as const;
export const COURSE_PUBLISH_MAX_BLOCKS = 32_768;
export const COURSE_PUBLISH_MAX_ASSETS = 4_096;

export type CoursePublishBlockSnapshot = Readonly<{
  block_id: string;
  relation: 'target' | 'descendant' | 'ancestor';
  ordinal: number;
  draft_hash: string;
  requires_quality: boolean;
}>;

export type CoursePublishAssetSnapshot = Readonly<{
  asset_id: string;
  asset_hash: string;
}>;

export interface CoursePublishCandidateIdentityInput {
  tenant_id: string;
  course_id: string;
  target_block_id: string;
  policy: CoursePublishPolicy;
  policy_version: number;
  blocks: readonly CoursePublishBlockSnapshot[];
  assets: readonly CoursePublishAssetSnapshot[];
}

export interface CoursePublishCandidateIdentity {
  candidate_hash: string;
  structure_hash: string;
  content_hash: string;
  asset_dependency_hash: string;
  block_count: number;
  asset_count: number;
}

export type CoursePublishEligibilityBlocker =
  | 'POLICY_CHANGED'
  | 'CANDIDATE_EXPIRED'
  | 'CANDIDATE_STALE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'REVIEWER_ASSIGNMENT_REVOKED'
  | 'QUALITY_RECEIPT_MISSING'
  | 'QUALITY_RECEIPT_STALE'
  | 'CRITICAL_FINDINGS_UNRESOLVED'
  | 'ASSESSMENT_OBLIGATIONS_OPEN';

export interface CoursePublishEligibilityEvidence {
  policy_current: boolean;
  candidate_expired: boolean;
  snapshot_current: boolean;
  approval_present: boolean;
  approval_current: boolean;
  reviewer_assignment_active: boolean;
  quality_receipt_present: boolean;
  quality_receipt_current: boolean;
  unresolved_critical_findings: number;
  open_assessment_obligations: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

export function coursePublishHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function readCoursePublishPolicy(value: unknown): CoursePublishPolicy {
  if (!COURSE_PUBLISH_POLICIES.includes(value as CoursePublishPolicy)) {
    throw new TypeError('COURSE_PUBLISH_POLICY_INVALID');
  }
  return value as CoursePublishPolicy;
}

/** High-risk enrollment is intentionally one-way. A reviewed future migration
 * may introduce an explicit declassification workflow; ordinary editors and
 * policy APIs must never silently downgrade it. */
export function assertCoursePublishPolicyTransition(
  current: CoursePublishPolicy | null,
  next: CoursePublishPolicy,
): void {
  readCoursePublishPolicy(next);
  if (current === 'high_risk_hse' && next !== current) {
    throw new Error('COURSE_PUBLISH_POLICY_DOWNGRADE_FORBIDDEN');
  }
}

export function buildCoursePublishCandidateIdentity(
  input: CoursePublishCandidateIdentityInput,
): Readonly<CoursePublishCandidateIdentity> {
  const policy = readCoursePublishPolicy(input.policy);
  if (!input.tenant_id || !input.course_id || !input.target_block_id
    || !Number.isSafeInteger(input.policy_version) || input.policy_version < 1
    || input.blocks.length < 1 || input.blocks.length > COURSE_PUBLISH_MAX_BLOCKS
    || input.assets.length > COURSE_PUBLISH_MAX_ASSETS) {
    throw new TypeError('COURSE_PUBLISH_CANDIDATE_INVALID');
  }
  const blocks = [...input.blocks].sort((left, right) => left.ordinal - right.ordinal
    || left.block_id.localeCompare(right.block_id));
  const assets = [...input.assets].sort((left, right) => left.asset_id.localeCompare(right.asset_id));
  if (new Set(blocks.map(item => item.block_id)).size !== blocks.length
    || new Set(assets.map(item => item.asset_id)).size !== assets.length
    || blocks.some((item, index) => !item.block_id || item.ordinal !== index
      || !/^[0-9a-f]{64}$/.test(item.draft_hash))
    || assets.some(item => !item.asset_id || !/^[0-9a-f]{64}$/.test(item.asset_hash))
    || blocks.filter(item => item.relation === 'target').length !== 1
    || blocks.find(item => item.relation === 'target')?.block_id !== input.target_block_id) {
    throw new TypeError('COURSE_PUBLISH_CANDIDATE_INVALID');
  }
  const structureHash = coursePublishHash(blocks.map(item => ({
    block_id: item.block_id,
    relation: item.relation,
    ordinal: item.ordinal,
  })));
  const contentHash = coursePublishHash(blocks.map(item => ({
    block_id: item.block_id,
    draft_hash: item.draft_hash,
    requires_quality: item.requires_quality,
  })));
  const assetDependencyHash = coursePublishHash(assets);
  const candidateHash = coursePublishHash({
    contract: COURSE_PUBLISH_GOVERNANCE_CONTRACT,
    tenant_id: input.tenant_id,
    course_id: input.course_id,
    target_block_id: input.target_block_id,
    policy,
    policy_version: input.policy_version,
    structure_hash: structureHash,
    content_hash: contentHash,
    asset_dependency_hash: assetDependencyHash,
  });
  return Object.freeze({
    candidate_hash: candidateHash,
    structure_hash: structureHash,
    content_hash: contentHash,
    asset_dependency_hash: assetDependencyHash,
    block_count: blocks.length,
    asset_count: assets.length,
  });
}

export function evaluateCoursePublishEligibility(
  policy: CoursePublishPolicy,
  evidence: Readonly<CoursePublishEligibilityEvidence>,
): Readonly<{ eligible: boolean; blockers: readonly CoursePublishEligibilityBlocker[] }> {
  const blockers: CoursePublishEligibilityBlocker[] = [];
  if (!evidence.policy_current) blockers.push('POLICY_CHANGED');
  if (evidence.candidate_expired) blockers.push('CANDIDATE_EXPIRED');
  if (!evidence.snapshot_current) blockers.push('CANDIDATE_STALE');
  if (policy === 'high_risk_hse') {
    if (!evidence.approval_present) blockers.push('APPROVAL_REQUIRED');
    else if (!evidence.approval_current) blockers.push('APPROVAL_STALE');
    if (evidence.approval_present && !evidence.reviewer_assignment_active) {
      blockers.push('REVIEWER_ASSIGNMENT_REVOKED');
    }
    if (!evidence.quality_receipt_present) blockers.push('QUALITY_RECEIPT_MISSING');
    else if (!evidence.quality_receipt_current) blockers.push('QUALITY_RECEIPT_STALE');
    if (evidence.unresolved_critical_findings > 0) blockers.push('CRITICAL_FINDINGS_UNRESOLVED');
    if (evidence.open_assessment_obligations > 0) blockers.push('ASSESSMENT_OBLIGATIONS_OPEN');
  }
  return Object.freeze({ eligible: blockers.length === 0, blockers: Object.freeze(blockers) });
}

