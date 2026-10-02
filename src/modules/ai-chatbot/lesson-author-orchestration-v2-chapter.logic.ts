import { Buffer } from 'node:buffer';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { orchestrationV2DeterministicUuid } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { ORCHESTRATION_V2_UNIT_CONTRACT } from './lesson-author-orchestration-v2-unit.logic.js';

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

export class OrchestrationV2ChapterError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_CHAPTER_INPUT_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_TOO_LARGE') {
    super(code);
    this.name = 'OrchestrationV2ChapterError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const fail = (code: OrchestrationV2ChapterError['code']): never => { throw new OrchestrationV2ChapterError(code); };
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
  if (!UUID.test(input.run_id) || !UUID.test(input.chapter_node_id) || !HASH.test(input.inventory_hash)
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
    if (!fact?.fact_key || !fact.scope_key || !HASH.test(fact.fact_hash) || factIds.has(fact.fact_key)
      || !chapter.source_scope_ids.includes(fact.scope_key)) fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
    factIds.add(fact.fact_key); representedScopes.add(fact.scope_key);
  }
  if (!facts.length || representedScopes.size !== chapter.source_scope_ids.length
    || chapter.source_scope_ids.some(scope => !representedScopes.has(scope))) {
    fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
  }

  const expectedUnits = chapter.lessons.flatMap((lesson, lessonIndex) => lesson.units.map((unit, unitIndex) => ({
    unit, path: `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`,
  })));
  if (input.units.length !== expectedUnits.length || expectedUnits.length < 1) {
    fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
  }
  const baselineByPath = new Map(input.baselines.map(item => [item.canonical_path, item]));
  if (baselineByPath.size !== input.baselines.length) fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
  const allocatedFacts: string[] = [], unitHashes: string[] = [], baselinePairs: Array<{ path: string; hash: string }> = [];
  let componentCount = 0;
  for (const [index, expected] of expectedUnits.entries()) {
    const evidence = input.units[index];
    if (!evidence || !UUID.test(evidence.task_id)
      || evidence.task_key !== `content:${input.chapter_key}:unit:${index + 1}`
      || evidence.node_id !== orchestrationV2DeterministicUuid(input.run_id, `node:${expected.path}`)
      || !HASH.test(evidence.artifact_hash)) fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
    const payload = evidence.payload, generated = record(payload.generated_unit);
    const nodes = Array.isArray(payload.nodes) ? payload.nodes.map(record) : [];
    const expectedFacts = facts.filter(fact => expected.unit.source_scope_ids.includes(fact.scope_key))
      .map(fact => fact.fact_key);
    const artifactBase = { validation_contract: ORCHESTRATION_V2_UNIT_CONTRACT,
      unit_path: payload.unit_path, source_snapshot_hash: payload.source_snapshot_hash,
      contract_hash: payload.contract_hash, nodes: payload.nodes, generated_unit: payload.generated_unit };
    if (payload.contract_version !== 2 || payload.unit_path !== expected.path
      || payload.source_snapshot_hash !== assembly.source_snapshot_hash || !HASH.test(String(payload.contract_hash))
      || orchestrationV2Hash(artifactBase) !== evidence.artifact_hash || !generated
      || !exact(generated.source_fact_ids, expectedFacts)
      || nodes.length !== expected.unit.component_plan.length + 1 || nodes.some(item => !item)) {
      fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
    }
    const acceptedGenerated = generated!;
    const generatedComponents = Array.isArray(acceptedGenerated.components) ? acceptedGenerated.components : [];
    if (generatedComponents.length !== expected.unit.component_plan.length) {
      fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
    }
    const expectedPaths = [expected.path, ...expected.unit.component_plan.map((_, componentIndex) =>
      `${expected.path}.component_${componentIndex + 1}`)];
    for (const [nodeIndex, path] of expectedPaths.entries()) {
      const artifactNode = nodes[nodeIndex]!, baseline = baselineByPath.get(path);
      if (artifactNode.path !== path || !HASH.test(String(artifactNode.content_hash))
        || orchestrationV2Hash(artifactNode.content) !== artifactNode.content_hash || !baseline
        || baseline.revision !== 0 || baseline.operation_id !== evidence.task_id
        || baseline.content_hash !== artifactNode.content_hash
        || baseline.kind !== (nodeIndex === 0 ? 'unit' : 'component')) {
        fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
      }
      baselinePairs.push({ path, hash: baseline!.content_hash });
    }
    allocatedFacts.push(...expectedFacts); componentCount += expected.unit.component_plan.length;
    unitHashes.push(evidence.artifact_hash);
  }
  if (baselinePairs.length !== input.baselines.length || allocatedFacts.length !== facts.length
    || new Set(allocatedFacts).size !== facts.length || allocatedFacts.some(id => !factIds.has(id))) {
    fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
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
