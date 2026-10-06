import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyQualityCompatibility, orchestrationV2OriginSummary, qualityReceiptApplicability,
  workspaceDraftQualityChecks, workspaceDraftQualityChecksAccepted } from './lesson-author-quality-receipt.logic.js';

const h = (value: string) => value.repeat(64).slice(0, 64);
const subject = (overrides: Record<string, string> = {}) => ({ scope_node_id: 'scope', revision_set_hash: h('a'),
  subject_content_hash: h('b'), source_snapshot_hash: h('c'), evidence_dependency_hash: h('d'),
  canonicalization_version: 'workspace-quality-subject-1', ...overrides });

test('legacy origin remains lineage and never becomes quality PASS', () => {
  assert.deepEqual(legacyQualityCompatibility('provider_validated'), {
    content_origin: 'provider', quality_status: 'NOT_RUN', reason_code: 'LEGACY_ORIGIN_IS_NOT_QUALITY_EVIDENCE',
  });
  assert.equal(legacyQualityCompatibility('structured_fallback').content_origin, 'deterministic');
  assert.equal(legacyQualityCompatibility('raw_source_fallback').content_origin, 'source_projection');
  assert.equal(legacyQualityCompatibility(undefined).content_origin, 'import');
});

test('draft Apply accepts only proven deterministic checks and honest semantic status', () => {
  const checks = workspaceDraftQualityChecks();
  assert.equal(checks.pedagogy, 'NOT_RUN');
  assert.equal(checks.dependencies, 'NOT_APPLICABLE');
  assert.equal(workspaceDraftQualityChecksAccepted(checks), true);
  assert.equal(workspaceDraftQualityChecksAccepted({ ...checks, security: 'NOT_RUN' }), false);
  assert.equal(workspaceDraftQualityChecksAccepted({ ...checks, pedagogy: 'ERROR' }), false);
});

test('receipt applicability is exact and never revives a historical revision', () => {
  assert.equal(qualityReceiptApplicability(null, subject()), 'MISSING');
  assert.equal(qualityReceiptApplicability(subject(), subject()), 'CURRENT');
  assert.equal(qualityReceiptApplicability(subject({ revision_set_hash: h('e') }), subject()), 'STALE');
  assert.equal(qualityReceiptApplicability(subject({ canonicalization_version: 'old' }), subject()), 'STALE');
});

test('origin summary records provider, fallback, import and author edit independently', () => {
  const summary = orchestrationV2OriginSummary(['provider_validated', 'structured_fallback', undefined], 2);
  assert.deepEqual(summary.counts, { provider: 1, deterministic: 1, source_projection: 0, user_edit: 2, import: 1 });
  assert.equal(summary.legacy_quality_status, 'NOT_RUN');
});
