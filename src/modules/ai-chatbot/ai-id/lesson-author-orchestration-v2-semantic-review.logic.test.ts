import assert from 'node:assert/strict';
import test from 'node:test';
import { readOrchestrationV2SemanticReviewSummary } from './lesson-author-semantic-review.logic.js';

const hash = 'a'.repeat(64);
const summary = () => ({
  contract_version: 'semantic-review-v1', config_hash: hash, status: 'review_required',
  quality_state: 'review_required', finding_counts: { critical: 1, major: 0, minor: 0 },
  findings: [{ criterion: 'evidence_fidelity', code: 'EVIDENCE_CONTRADICTION', severity: 'critical',
    scope: 'component', component_index: 0, candidate_path: 'components[0].semantic_content.sections[0]',
    source_fact_key_hashes: ['b'.repeat(16)], witness_sha256: 'c'.repeat(64),
    repair_instruction_sha256: 'd'.repeat(64) }],
  repair_attempted: true, repair_applied: false, repair_component_indices: [0], failure_code: null,
});

test('admits bounded text-free semantic review evidence', () => {
  const result = readOrchestrationV2SemanticReviewSummary(summary());
  assert.equal(result.findings[0]?.code, 'EVIDENCE_CONTRADICTION');
  assert.equal(JSON.stringify(result).includes('source text'), false);
});

test('rejects raw text, count drift, contradictory status and invalid scope', () => {
  for (const candidate of [
    { ...summary(), raw_text: 'private' },
    { ...summary(), finding_counts: { critical: 0, major: 0, minor: 0 } },
    { ...summary(), status: 'passed' },
    { ...summary(), findings: [{ ...summary().findings[0], component_index: 1 }] },
    { ...summary(), failure_code: 'PRIVATE text' },
    { ...summary(), repair_attempted: false, repair_component_indices: [0] },
    { ...summary(), findings: [{ ...summary().findings[0],
      source_fact_key_hashes: ['b'.repeat(16), 'b'.repeat(16)] }] },
    { ...summary(), findings: [], finding_counts: { critical: 0, major: 0, minor: 0 } },
  ]) assert.throws(() => readOrchestrationV2SemanticReviewSummary(candidate), /SEMANTIC_REVIEW_INVALID/);
});

test('unavailable evidence requires a stable failure code', () => {
  const unavailable = { ...summary(), status: 'unavailable', findings: [],
    finding_counts: { critical: 0, major: 0, minor: 0 }, repair_attempted: false,
    repair_component_indices: [], failure_code: 'SEMANTIC_REVIEW_UNAVAILABLE' };
  assert.equal(readOrchestrationV2SemanticReviewSummary(unavailable).status, 'unavailable');
  assert.throws(() => readOrchestrationV2SemanticReviewSummary({ ...unavailable, failure_code: null }),
    /SEMANTIC_REVIEW_INVALID/);
});
