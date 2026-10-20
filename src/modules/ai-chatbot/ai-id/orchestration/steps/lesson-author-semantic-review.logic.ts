export const ORCHESTRATION_V2_SEMANTIC_REVIEW_CONTRACT = 'semantic-review-v1' as const;

const CRITERIA = new Set([
  'evidence_fidelity', 'source_completeness', 'instructional_alignment',
  'assessment_quality', 'explanation_quality', 'component_fit',
]);
const CODES = new Set([
  'EVIDENCE_CONTRADICTION', 'EVIDENCE_CONDITION_OMITTED', 'REQUIRED_EVIDENCE_OMITTED',
  'STRUCTURED_RELATION_LOST', 'OBJECTIVE_ALIGNMENT_GAP', 'ASSESSMENT_ANSWER_UNGROUNDED',
  'ASSESSMENT_DISTRACTOR_INVALID', 'EXPLANATION_INCOHERENT', 'TERMINOLOGY_INCONSISTENT',
  'PREREQUISITE_GAP', 'DUPLICATE_FILLER', 'COMPONENT_SEMANTIC_MISMATCH',
  'REVIEW_EVIDENCE_INSUFFICIENT',
]);
const SEVERITIES = new Set(['critical', 'major', 'minor']);
const HASH = /^[0-9a-f]{64}$/;
const SHORT_HASH = /^[0-9a-f]{16}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const PATH = /^(?:unit|components\[(?:0|[1-9][0-9]*)](?:\.[A-Za-z0-9_.[\]-]+)?)$/;
const SUMMARY_KEYS = new Set(['contract_version', 'config_hash', 'status', 'quality_state', 'finding_counts',
  'findings', 'repair_attempted', 'repair_applied', 'repair_component_indices', 'failure_code']);
const FINDING_KEYS = new Set(['criterion', 'code', 'severity', 'scope', 'component_index', 'candidate_path',
  'source_fact_key_hashes', 'witness_sha256', 'repair_instruction_sha256']);
const record = (value: unknown): Record<string, unknown> | null => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value)
  && Number(value) >= min && Number(value) <= max;

export interface OrchestrationV2SemanticReviewFindingSummary {
  criterion: string;
  code: string;
  severity: 'critical' | 'major' | 'minor';
  scope: 'unit' | 'component';
  component_index: number | null;
  candidate_path: string;
  source_fact_key_hashes: string[];
  witness_sha256: string;
  repair_instruction_sha256: string;
}

export interface OrchestrationV2SemanticReviewSummary {
  contract_version: typeof ORCHESTRATION_V2_SEMANTIC_REVIEW_CONTRACT;
  config_hash: string;
  status: 'passed' | 'review_required' | 'unavailable';
  quality_state: 'validated' | 'review_required';
  finding_counts: Readonly<{ critical: number; major: number; minor: number }>;
  findings: readonly OrchestrationV2SemanticReviewFindingSummary[];
  repair_attempted: boolean;
  repair_applied: boolean;
  repair_component_indices: readonly number[];
  failure_code: string | null;
}

/** Admit only bounded, text-free semantic-review evidence from the AI service. */
export function readOrchestrationV2SemanticReviewSummary(
  value: unknown,
): Readonly<OrchestrationV2SemanticReviewSummary> {
  const item = record(value), counts = record(item?.finding_counts);
  if (!item || Object.keys(item).some(key => !SUMMARY_KEYS.has(key))
    || item.contract_version !== ORCHESTRATION_V2_SEMANTIC_REVIEW_CONTRACT
    || typeof item.config_hash !== 'string' || !HASH.test(item.config_hash)
    || !['passed', 'review_required', 'unavailable'].includes(String(item.status))
    || !['validated', 'review_required'].includes(String(item.quality_state))
    || !counts || Object.keys(counts).sort().join(',') !== 'critical,major,minor'
    || !Object.values(counts).every(valueCount => integer(valueCount, 0, 32))
    || !Array.isArray(item.findings) || item.findings.length > 32
    || typeof item.repair_attempted !== 'boolean' || typeof item.repair_applied !== 'boolean'
    || item.repair_applied && !item.repair_attempted
    || !Array.isArray(item.repair_component_indices) || item.repair_component_indices.length > 4
    || item.repair_component_indices.some(index => !integer(index, 0, 31))
    || new Set(item.repair_component_indices).size !== item.repair_component_indices.length
    || item.repair_attempted !== (item.repair_component_indices.length > 0)
    || !(item.failure_code === null || typeof item.failure_code === 'string' && CODE.test(item.failure_code))) {
    throw new Error('ORCHESTRATION_V2_SEMANTIC_REVIEW_INVALID');
  }
  const findings = item.findings.map(raw => {
    const finding = record(raw);
    if (!finding || Object.keys(finding).some(key => !FINDING_KEYS.has(key))
      || typeof finding.criterion !== 'string' || !CRITERIA.has(finding.criterion)
      || typeof finding.code !== 'string' || !CODES.has(finding.code)
      || typeof finding.severity !== 'string' || !SEVERITIES.has(finding.severity)
      || !['unit', 'component'].includes(String(finding.scope))
      || !(finding.component_index === null || integer(finding.component_index, 0, 31))
      || typeof finding.candidate_path !== 'string' || finding.candidate_path.length > 256
      || !PATH.test(finding.candidate_path)
      || !Array.isArray(finding.source_fact_key_hashes) || finding.source_fact_key_hashes.length > 64
      || finding.source_fact_key_hashes.some(hash => typeof hash !== 'string' || !SHORT_HASH.test(hash))
      || new Set(finding.source_fact_key_hashes).size !== finding.source_fact_key_hashes.length
      || typeof finding.witness_sha256 !== 'string' || !HASH.test(finding.witness_sha256)
      || typeof finding.repair_instruction_sha256 !== 'string' || !HASH.test(finding.repair_instruction_sha256)
      || (finding.scope === 'unit' ? finding.component_index !== null || finding.candidate_path !== 'unit'
        : finding.component_index === null || !finding.candidate_path.startsWith(`components[${finding.component_index}]`))) {
      throw new Error('ORCHESTRATION_V2_SEMANTIC_REVIEW_INVALID');
    }
    return Object.freeze({ ...finding }) as unknown as OrchestrationV2SemanticReviewFindingSummary;
  });
  const actual = { critical: 0, major: 0, minor: 0 };
  for (const finding of findings) actual[finding.severity] += 1;
  if (actual.critical !== counts.critical || actual.major !== counts.major || actual.minor !== counts.minor
    || item.status === 'passed' && (actual.critical > 0 || actual.major > 0)
    || item.status === 'unavailable' && item.failure_code === null
    || item.status === 'unavailable' && (findings.length > 0 || item.repair_attempted)
    || item.status === 'review_required'
      && actual.critical + actual.major === 0 && item.failure_code === null
    || item.status === 'passed' && item.failure_code !== null
    || item.quality_state === 'validated' && item.status !== 'passed') {
    throw new Error('ORCHESTRATION_V2_SEMANTIC_REVIEW_INVALID');
  }
  return Object.freeze({
    contract_version: ORCHESTRATION_V2_SEMANTIC_REVIEW_CONTRACT,
    config_hash: item.config_hash as string,
    status: item.status as OrchestrationV2SemanticReviewSummary['status'],
    quality_state: item.quality_state as OrchestrationV2SemanticReviewSummary['quality_state'],
    finding_counts: Object.freeze(actual), findings: Object.freeze(findings),
    repair_attempted: item.repair_attempted as boolean,
    repair_applied: item.repair_applied as boolean,
    repair_component_indices: Object.freeze((item.repair_component_indices as number[]).map(Number)),
    failure_code: item.failure_code as string | null,
  });
}
