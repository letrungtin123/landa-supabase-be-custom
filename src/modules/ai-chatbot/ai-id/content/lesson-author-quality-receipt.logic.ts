export const QUALITY_CHECK_STATUSES = [
  'PASS', 'FAIL', 'NOT_RUN', 'NOT_APPLICABLE', 'ERROR',
] as const;

export type QualityCheckStatus = (typeof QUALITY_CHECK_STATUSES)[number];
export type QualityReceiptApplicability = 'CURRENT' | 'STALE' | 'MISSING';
export type CanonicalContentOrigin = 'provider' | 'deterministic' | 'source_projection' | 'user_edit' | 'import';

export type WorkspaceDraftQualityChecks = Readonly<Record<
  'schema' | 'security' | 'evidence' | 'pedagogy' | 'coverage' | 'duplicates' | 'dependencies' | 'registry',
  QualityCheckStatus
>>;

export interface QualityReceiptSubjectIdentity {
  scope_node_id: string;
  revision_set_hash: string;
  subject_content_hash: string;
  source_snapshot_hash: string;
  evidence_dependency_hash: string;
  canonicalization_version: string;
}

export interface LegacyQualityCompatibility {
  content_origin: CanonicalContentOrigin;
  quality_status: 'NOT_RUN';
  reason_code: 'LEGACY_ORIGIN_IS_NOT_QUALITY_EVIDENCE';
}

const HASH = /^[0-9a-f]{64}$/;

/** Origin records lineage only. A historical `validated` label is deliberately
 * not promoted to current quality evidence without a subject-bound receipt. */
export function legacyQualityCompatibility(contentOrigin: unknown): LegacyQualityCompatibility {
  const content_origin: CanonicalContentOrigin = contentOrigin === 'provider_validated'
    ? 'provider'
    : contentOrigin === 'structured_fallback'
      ? 'deterministic'
      : contentOrigin === 'raw_source_fallback'
        ? 'source_projection'
        : 'import';
  return { content_origin, quality_status: 'NOT_RUN', reason_code: 'LEGACY_ORIGIN_IS_NOT_QUALITY_EVIDENCE' };
}

export function orchestrationV2OriginSummary(
  origins: readonly unknown[],
  authorEditedNodeCount: number,
): Readonly<{ contract_version: 1; counts: Readonly<Record<CanonicalContentOrigin, number>>;
  legacy_quality_status: 'NOT_RUN'; legacy_quality_reason: 'LEGACY_ORIGIN_IS_NOT_QUALITY_EVIDENCE' }> {
  if (!Number.isSafeInteger(authorEditedNodeCount) || authorEditedNodeCount < 0) {
    throw new TypeError('QUALITY_ORIGIN_SUMMARY_INVALID');
  }
  const counts: Record<CanonicalContentOrigin, number> = {
    provider: 0, deterministic: 0, source_projection: 0, user_edit: authorEditedNodeCount, import: 0,
  };
  for (const origin of origins) counts[legacyQualityCompatibility(origin).content_origin] += 1;
  return Object.freeze({ contract_version: 1, counts: Object.freeze(counts), legacy_quality_status: 'NOT_RUN',
    legacy_quality_reason: 'LEGACY_ORIGIN_IS_NOT_QUALITY_EVIDENCE' });
}

/** CP1 draft policy. These statuses describe checks that actually ran at the
 * Apply compiler boundary; semantic pedagogy is intentionally not inferred. */
export function workspaceDraftQualityChecks(): WorkspaceDraftQualityChecks {
  return Object.freeze({ schema: 'PASS', security: 'PASS', evidence: 'PASS', pedagogy: 'NOT_RUN',
    coverage: 'PASS', duplicates: 'PASS', dependencies: 'NOT_APPLICABLE', registry: 'PASS' });
}

export function workspaceDraftQualityChecksAccepted(checks: WorkspaceDraftQualityChecks): boolean {
  return ['schema', 'security', 'evidence', 'coverage', 'duplicates', 'registry']
    .every(key => checks[key as keyof WorkspaceDraftQualityChecks] === 'PASS')
    && (checks.dependencies === 'PASS' || checks.dependencies === 'NOT_APPLICABLE')
    && (checks.pedagogy === 'PASS' || checks.pedagogy === 'NOT_RUN' || checks.pedagogy === 'NOT_APPLICABLE');
}

/** Freshness is derived, never stored as a mutable flag. Exact revision is part
 * of the identity, so editing A -> B -> A does not revive an older receipt. */
export function qualityReceiptApplicability(
  receipt: QualityReceiptSubjectIdentity | null | undefined,
  subject: QualityReceiptSubjectIdentity,
): QualityReceiptApplicability {
  if (!receipt) return 'MISSING';
  const values = [receipt.revision_set_hash, receipt.subject_content_hash, receipt.source_snapshot_hash,
    receipt.evidence_dependency_hash, subject.revision_set_hash, subject.subject_content_hash,
    subject.source_snapshot_hash, subject.evidence_dependency_hash];
  if (!values.every(value => HASH.test(value)) || !receipt.scope_node_id || !subject.scope_node_id
    || !receipt.canonicalization_version || !subject.canonicalization_version) return 'STALE';
  return receipt.scope_node_id === subject.scope_node_id
    && receipt.revision_set_hash === subject.revision_set_hash
    && receipt.subject_content_hash === subject.subject_content_hash
    && receipt.source_snapshot_hash === subject.source_snapshot_hash
    && receipt.evidence_dependency_hash === subject.evidence_dependency_hash
    && receipt.canonicalization_version === subject.canonicalization_version
    ? 'CURRENT' : 'STALE';
}
