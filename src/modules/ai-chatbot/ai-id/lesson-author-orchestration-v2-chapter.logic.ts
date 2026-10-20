import { Buffer } from 'node:buffer';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { orchestrationV2DeterministicUuid } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { orchestrationV2QualityPolicy } from './lesson-author-orchestration-v2-quality.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { orchestrationV2UnitArtifactHash } from './lesson-author-orchestration-v2-unit.logic.js';
import { UUID_PATTERN } from '../../../utils/uuid.js';

export const ORCHESTRATION_V2_CHAPTER_CONTRACT = 'orchestration-chapter-receipt-v2';

export interface OrchestrationV2ChapterUnitEvidence {
  task_id: string;
  task_key: string;
  node_id: string;
  artifact_hash: string;
  payload: Record<string, unknown>;
}

export interface OrchestrationV2ChapterBaselineEvidence {
  canonical_path: string;
  kind: 'unit' | 'component';
  content_hash: string;
  revision: number;
  operation_id: string;
}

export interface OrchestrationV2ChapterReceipt {
  contract: typeof ORCHESTRATION_V2_CHAPTER_CONTRACT;
  source_snapshot_hash: string;
  assembly_hash: string;
  inventory_hash: string;
  chapter_key: string;
  chapter_node_id: string;
  unit_count: number;
  component_count: number;
  admitted_fact_count: number;
  allocated_fact_count: number;
  covered_fact_count: number;
  duplicate_fact_count: 0;
  unresolved_fact_count: 0;
  unit_artifact_hashes: string[];
  fact_set_hash: string;
  baseline_set_hash: string;
  receipt_hash: string;
}

/**
 * Internal diagnosis of an ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID refusal.
 * Telemetry only (worker logs): the public failure_code, the receipt and every
 * contract hash stay exactly as they were. Values are fixed tokens; `path` is a
 * canonical workspace path (never content, fact text or provider output).
 */
export const ORCHESTRATION_V2_CHAPTER_EVIDENCE_REASONS = [
  'FACT_INVALID', 'DUPLICATE_FACT', 'FACT_SCOPE_MISMATCH', 'SCOPE_COVERAGE_MISMATCH', 'UNIT_COUNT_MISMATCH',
  'BASELINE_DUPLICATE_PATH', 'UNIT_IDENTITY_MISMATCH', 'QUALITY_INVALID', 'UNIT_PAYLOAD_INVALID',
  'ARTIFACT_HASH_MISMATCH', 'UNIT_FACTS_MISMATCH', 'NODE_COUNT_MISMATCH', 'COMPONENT_COUNT_MISMATCH',
  'ARTIFACT_NODE_INVALID', 'BASELINE_MISSING', 'BASELINE_MISMATCH', 'BASELINE_COUNT', 'COVERAGE_MISMATCH',
  'PLANNING_ARTIFACTS_MISSING', 'ARCHITECTURE_MISMATCH', 'INPUT_HASH_MISMATCH', 'UNIT_PATHS_INVALID',
  'UNIT_PAYLOAD_MISSING',
] as const;
export type OrchestrationV2ChapterEvidenceReason = typeof ORCHESTRATION_V2_CHAPTER_EVIDENCE_REASONS[number];
export interface OrchestrationV2ChapterEvidenceDiagnosis {
  reason: OrchestrationV2ChapterEvidenceReason;
  path: string | null;
}

export class OrchestrationV2ChapterError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_CHAPTER_INPUT_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_TOO_LARGE',
  readonly chapter_evidence: OrchestrationV2ChapterEvidenceDiagnosis | null = null) {
    super(code);
    this.name = 'OrchestrationV2ChapterError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const fail = (code: OrchestrationV2ChapterError['code']): never => { throw new OrchestrationV2ChapterError(code); };
/** Same public code as before; the diagnosis only reaches worker telemetry. */
const evidenceInvalid = (reason: OrchestrationV2ChapterEvidenceReason, path: string | null = null): never => {
  throw new OrchestrationV2ChapterError('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID', { reason, path });
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exact = (actual: unknown, expected: readonly string[]) => Array.isArray(actual)
  && actual.length === expected.length && actual.every((value, index) => value === expected[index]);

/**
 * Validate one complete chapter from immutable unit artifacts and revision-zero
 * baselines. This is deterministic: it performs no provider, DB or queue work.
 */
export function validateOrchestrationV2Chapter(input: {
  run_id: string;
  assembly: Readonly<OrchestrationV2ArchitectureAssembly>;
  inventory_hash: string;
  chapter_key: string;
  chapter_node_id: string;
  source_facts: readonly (OrchestrationV2SourceFact & { fact_hash: string })[];
  units: readonly OrchestrationV2ChapterUnitEvidence[];
  baselines: readonly OrchestrationV2ChapterBaselineEvidence[];
}): Readonly<OrchestrationV2ChapterReceipt> {
  const { assembly } = input;
  if (!UUID_PATTERN.test(input.run_id) || !UUID_PATTERN.test(input.chapter_node_id) || !HASH.test(input.inventory_hash)
    || !assembly || assembly.contract_version !== 2 || !HASH.test(assembly.assembly_hash)
    || input.chapter_key.length < 1 || input.chapter_key.length > 160) {
    fail('ORCHESTRATION_V2_CHAPTER_INPUT_INVALID');
  }
  const chapterIndex = assembly.architecture.chapters.findIndex(chapter => chapter.chapter_key === input.chapter_key);
  const chapter = assembly.architecture.chapters[chapterIndex];
  if (!chapter || input.chapter_node_id !== orchestrationV2DeterministicUuid(input.run_id, `node:chapter_${chapterIndex + 1}`)) {
    fail('ORCHESTRATION_V2_CHAPTER_INPUT_INVALID');
  }
  const facts = [...input.source_facts];
  const factIds = new Set<string>(), representedScopes = new Set<string>();
  for (const fact of facts) {
    if (!fact?.fact_key || !fact.scope_key || !HASH.test(fact.fact_hash)) evidenceInvalid('FACT_INVALID');
    if (factIds.has(fact.fact_key)) evidenceInvalid('DUPLICATE_FACT');
    if (!chapter.source_scope_ids.includes(fact.scope_key)) evidenceInvalid('FACT_SCOPE_MISMATCH');
    factIds.add(fact.fact_key); representedScopes.add(fact.scope_key);
  }
  if (!facts.length || representedScopes.size !== chapter.source_scope_ids.length
    || chapter.source_scope_ids.some(scope => !representedScopes.has(scope))) {
    evidenceInvalid('SCOPE_COVERAGE_MISMATCH', `chapter_${chapterIndex + 1}`);
  }

  const expectedUnits = chapter.lessons.flatMap((lesson, lessonIndex) => lesson.units.map((unit, unitIndex) => ({
    unit, path: `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`,
  })));
  if (input.units.length !== expectedUnits.length || expectedUnits.length < 1) {
    evidenceInvalid('UNIT_COUNT_MISMATCH', `chapter_${chapterIndex + 1}`);
  }
  const baselineByPath = new Map(input.baselines.map(item => [item.canonical_path, item]));
  if (baselineByPath.size !== input.baselines.length) evidenceInvalid('BASELINE_DUPLICATE_PATH', `chapter_${chapterIndex + 1}`);
  const allocatedFacts: string[] = [], unitHashes: string[] = [], baselinePairs: Array<{ path: string; hash: string }> = [];
  let componentCount = 0;
  for (const [index, expected] of expectedUnits.entries()) {
    const evidence = input.units[index];
    if (!evidence || !UUID_PATTERN.test(evidence.task_id)
      || evidence.task_key !== `content:${input.chapter_key}:unit:${index + 1}`
      || evidence.node_id !== orchestrationV2DeterministicUuid(input.run_id, `node:${expected.path}`)
      || !HASH.test(evidence.artifact_hash)) evidenceInvalid('UNIT_IDENTITY_MISMATCH', expected.path);
    const payload = evidence.payload, generated = record(payload.generated_unit);
    const nodes = Array.isArray(payload.nodes) ? payload.nodes.map(record) : [];
    const expectedFacts = facts.filter(fact => expected.unit.source_scope_ids.includes(fact.scope_key))
      .map(fact => fact.fact_key);
    const quality = orchestrationV2QualityPolicy(payload);
    if (!quality.evidence_valid) evidenceInvalid('QUALITY_INVALID', expected.path);
    // One refusal as before; the checks are split only to name which one failed.
    if (payload.contract_version !== 2 || payload.unit_path !== expected.path
      || payload.source_snapshot_hash !== assembly.source_snapshot_hash || !HASH.test(String(payload.contract_hash))
      || !generated) evidenceInvalid('UNIT_PAYLOAD_INVALID', expected.path);
    if (orchestrationV2UnitArtifactHash(payload) !== evidence.artifact_hash) evidenceInvalid('ARTIFACT_HASH_MISMATCH', expected.path);
    if (!exact(generated!.source_fact_ids, expectedFacts)) evidenceInvalid('UNIT_FACTS_MISMATCH', expected.path);
    if (nodes.length !== expected.unit.component_plan.length + 1 || nodes.some(item => !item)) {
      evidenceInvalid('NODE_COUNT_MISMATCH', expected.path);
    }
    const acceptedGenerated = generated!;
    const generatedComponents = Array.isArray(acceptedGenerated.components) ? acceptedGenerated.components : [];
    if (generatedComponents.length !== expected.unit.component_plan.length) {
      evidenceInvalid('COMPONENT_COUNT_MISMATCH', expected.path);
    }
    const expectedPaths = [expected.path, ...expected.unit.component_plan.map((_, componentIndex) =>
      `${expected.path}.component_${componentIndex + 1}`)];
    for (const [nodeIndex, path] of expectedPaths.entries()) {
      const artifactNode = nodes[nodeIndex]!, baseline = baselineByPath.get(path);
      if (artifactNode.path !== path || !HASH.test(String(artifactNode.content_hash))
        || orchestrationV2Hash(artifactNode.content) !== artifactNode.content_hash) evidenceInvalid('ARTIFACT_NODE_INVALID', path);
      if (!baseline) evidenceInvalid('BASELINE_MISSING', path);
      if (baseline!.revision !== 0 || baseline!.operation_id !== evidence.task_id
        || baseline!.content_hash !== artifactNode.content_hash
        || baseline!.kind !== (nodeIndex === 0 ? 'unit' : 'component')) {
        evidenceInvalid('BASELINE_MISMATCH', path);
      }
      baselinePairs.push({ path, hash: baseline!.content_hash });
    }
    allocatedFacts.push(...expectedFacts); componentCount += expected.unit.component_plan.length;
    unitHashes.push(evidence.artifact_hash);
  }
  if (baselinePairs.length !== input.baselines.length) evidenceInvalid('BASELINE_COUNT', `chapter_${chapterIndex + 1}`);
  if (allocatedFacts.length !== facts.length || new Set(allocatedFacts).size !== facts.length
    || allocatedFacts.some(id => !factIds.has(id))) {
    evidenceInvalid('COVERAGE_MISMATCH', `chapter_${chapterIndex + 1}`);
  }
  const base = { contract: ORCHESTRATION_V2_CHAPTER_CONTRACT as typeof ORCHESTRATION_V2_CHAPTER_CONTRACT,
    source_snapshot_hash: assembly.source_snapshot_hash, assembly_hash: assembly.assembly_hash,
    inventory_hash: input.inventory_hash, chapter_key: input.chapter_key,
    chapter_node_id: input.chapter_node_id, unit_count: expectedUnits.length, component_count: componentCount,
    admitted_fact_count: facts.length, allocated_fact_count: allocatedFacts.length,
    covered_fact_count: new Set(allocatedFacts).size, duplicate_fact_count: 0 as const,
    unresolved_fact_count: 0 as const, unit_artifact_hashes: unitHashes,
    fact_set_hash: orchestrationV2Hash(facts.map(fact => ({ fact_key: fact.fact_key, fact_hash: fact.fact_hash }))),
    baseline_set_hash: orchestrationV2Hash(baselinePairs) };
  if (Buffer.byteLength(JSON.stringify(base), 'utf8') > MAX_RECEIPT_BYTES) {
    fail('ORCHESTRATION_V2_CHAPTER_TOO_LARGE');
  }
  return Object.freeze({ ...base, receipt_hash: orchestrationV2Hash(base) });
}
