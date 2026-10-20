import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { LessonAuthorProposal } from '../../../../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../../../../tenants/tenant-course-components.constants.js';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from '../../shared/lesson-author-generation-job.logic.js';
import { compileOrchestrationV2WorkspaceApply } from '../../workspace/apply/lesson-author-orchestration-v2-apply.logic.js';
import { assembleOrchestrationV2Architecture,
  readOrchestrationV2ArchitectureAssembly } from '../lesson-author-orchestration-v2-architecture.logic.js';
import { ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH,
  orchestrationV2StoredArtifactHashMatches } from './lesson-author-orchestration-v2-artifact-hash.logic.js';
import { canonicalJson, toPersistedJson } from '../../shared/lesson-author-orchestration-v2-canonical-json.logic.js';
import { validateOrchestrationV2Chapter } from './lesson-author-orchestration-v2-chapter.logic.js';
import { finalizeOrchestrationV2Course,
  type OrchestrationV2FinalizationTask } from '../finalize/lesson-author-orchestration-v2-finalization.logic.js';
import { prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2StoredTask } from './lesson-author-orchestration-v2-inventory.logic.js';
import { createOrchestrationV2InventoryRepository } from './lesson-author-orchestration-v2-inventory.repository.js';
import { orchestrationV2Hash, sealOrchestrationV2PersistedManifest } from '../../shared/lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from '../../contracts/lesson-author-orchestration-v2-rag-contract.logic.js';
import { acceptOrchestrationV2GeneratedUnit, orchestrationV2UnitArtifactHash, prepareOrchestrationV2UnitGenerationContract,
  readOrchestrationV2UnitProviderResponse, type OrchestrationV2UnitPublication } from './lesson-author-orchestration-v2-unit.logic.js';
import { createOrchestrationV2UnitRepository } from './lesson-author-orchestration-v2-unit.repository.js';
import { createOrchestrationV2WorkerRepository,
  type OrchestrationV2TaskLease } from '../worker/lesson-author-orchestration-v2-worker.repository.js';
import { workspaceApplyTargetHash, type WorkspaceApplyNode } from '../../workspace/apply/lesson-author-workspace-apply.logic.js';
import { workspaceStoryboardBoundSeed } from '../../content/lesson-author-workspace-storyboard.logic.js';
import { workspaceHashMatches } from '../../content/lesson-author-workspace.logic.js';

/**
 * "Hash exactly what you persist": every V2 artifact, revision-zero baseline and node contract is
 * produced, sent through the JSON round trip jsonb applies, and verified by its real reader. Before
 * canonical-json.logic the unit hash was taken on the in-memory object, so a normalizer that left
 * `label: undefined` on a diagram edge produced a unit that failed chapter validation and Apply.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: unknown) => orchestrationV2Hash(value);
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Row = Record<string, unknown>;

/** The encoder orchestrationV2Hash used before canonical-json.logic (it wrote `"label":undefined`). */
const previousHash = (value: unknown) => createHash('sha256').update(canonicalJson(value, { strict: false })).digest('hex');

type Normalize = (raw: unknown) => LessonAuthorProposal;
const passThrough: Normalize = raw => ({ summary: '', chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });

/**
 * The html component passes through (as in lesson-author-orchestration-v2-apply.test.ts: its thin test text
 * is not a teaching unit); the la_diagram goes through the production normalizer, imported the way
 * lesson-author-orchestration-v2-unit.test.ts does it (no I/O).
 */
async function productionNormalizer(t: TestContext): Promise<Normalize> {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const production = (await import('../../legacy/proposal-normalize.logic.js')).normalizeLessonAuthorProposal;
  return raw => {
    // A normalizer returns a new proposal; acceptance re-reads the raw response afterwards.
    const proposal = passThrough(structuredClone(raw));
    const unit = proposal.chapters[0]!.lessons[0]!.units[0]!;
    unit.components = unit.components!.map(component => component.type !== 'la_diagram' ? component
      : production({ chapters: [{ title: 'Chương', lessons: [{ title: 'Bài', units: [{ title: unit.title,
        components: [component] }] }] }] }).chapters[0]!.lessons[0]!.units[0]!.components![0]!);
    return proposal;
  };
}

/** The diagram normalizer before b34bec4: an unlabeled edge kept a `label` key whose value is undefined. */
function withUndefinedEdgeLabels(normalize: Normalize): Normalize {
  return raw => {
    const proposal = normalize(raw);
    for (const component of proposal.chapters.flatMap(chapter => chapter.lessons.flatMap(lesson =>
      lesson.units.flatMap(unit => unit.components ?? [])))) {
      const diagrams = (component.metadata?.diagram_data as { diagrams?: Array<{ edges: Row[] }> } | undefined)?.diagrams;
      for (const edge of diagrams?.flatMap(diagram => diagram.edges) ?? []) if (!('label' in edge)) edge.label = undefined;
    }
    return proposal;
  };
}

const FACTS: OrchestrationV2SourceFact[] = [
  { document_id: uuid(11), fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Nhận diện mối nguy trước khi làm.',
    source_ref: 'quy-trinh.pdf', source_page: 1, source_chunk: 0, locator: { bbox: [0.00005, 0, 1, 0.5] } },
  { document_id: uuid(11), fact_key: 'fact-2', scope_key: 'scope-1', fact_text: 'Kiểm tra biện pháp kiểm soát.',
    source_ref: 'quy-trinh.pdf', source_page: 1, source_chunk: 1, locator: {} },
];

function architecture(types: readonly CourseComponentType[]) {
  const source = hash('hash-roundtrip-source');
  const skeleton = { contract_version: 2 as const, source_snapshot_hash: source, locale: 'vi' as const,
    title: 'An toàn lao động', summary: 'Tóm tắt', target_audience: 'Tổ trưởng', prerequisites: [],
    learning_outcomes: ['Áp dụng quy trình'], assessment_strategy: 'Thực hành', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chương 1', objective: 'Hiểu quy trình',
      learning_outcomes: ['Áp dụng an toàn'], source_scope_ids: ['scope-1'],
    }] };
  const shard = { contract_version: 2 as const, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
    shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chương 1', objective: 'Hiểu quy trình',
    lessons: [{ title: 'Bài 1', objective: 'Hiểu quy trình', learning_objectives: ['Áp dụng an toàn'],
      learning_activities: ['Đọc'], assessment: 'Kiểm tra', units: [{ title: 'Đơn vị 1', purpose: 'Dạy an toàn',
        learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], component_plan: types.map(type => ({
          type: type as 'html', title: type === 'html' ? 'Giải thích' : 'Sơ đồ quy trình', rationale: 'Dạy quy trình',
          source_scope_ids: ['scope-1'] })), media_brief: null }] }] };
  const scopes = [{ scope_key: 'scope-1', title: 'Phạm vi', source_ref: 'quy-trinh.pdf', fact_count: 2, content_chars: 60 }];
  const shardPayload = toPersistedJson({ contract_version: 2, shard, content_origin: 'provider_validated',
    quality_state: 'validated' });
  const shardHash = hash(shardPayload);
  const assembly = assembleOrchestrationV2Architecture(skeleton, scopes, [{ artifact_hash: shardHash, shard }]);
  return { source, skeleton, shard, scopes, shardPayload, shardHash, assembly };
}

function wireComponent(type: CourseComponentType, plan: { component_plan_id: string; source_fact_ids: string[];
  supporting_evidence_fact_ids: string[]; learning_objective_refs: string[] }) {
  const ids = { component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
    covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [...plan.supporting_evidence_fact_ids] };
  const body = type === 'html'
    ? { data: '<p>Nhận diện mối nguy trước khi làm và kiểm tra biện pháp kiểm soát trước mỗi ca.</p>' }
    : { nodes: [{ label: 'Nhận diện mối nguy' }, { label: 'Kiểm tra biện pháp' }, { label: 'Bắt đầu công việc' }],
      // The first edge has no label: the case of run 43fabc57.
      edges: [{ source: 'Nhận diện mối nguy', target: 'Kiểm tra biện pháp' },
        { source: 'Kiểm tra biện pháp', target: 'Bắt đầu công việc', label: 'đạt' }] };
  return { type, title: type === 'html' ? 'Giải thích' : 'Sơ đồ quy trình', ...body, ...ids,
    metadata: { ...ids, learning_objective_refs: [...plan.learning_objective_refs] } };
}

/** Unit acceptance → the unit_baseline payload exactly as the unit repository stores it. */
function acceptedUnit(input: ReturnType<typeof architecture>, types: readonly CourseComponentType[], normalize: Normalize) {
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly: input.assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: FACTS });
  const wire = { contract_version: 2, source_snapshot_hash: input.source, unit_path: contract.unit_path,
    unit: { title: contract.unit_title, source_fact_ids: [...contract.unit_source_fact_ids],
      components: contract.component_plan.map((plan, index) => wireComponent(types[index]!, plan)) },
    usage_complete: true as const, usage_source: 'provider' as const, usage: {} };
  const response = readOrchestrationV2UnitProviderResponse(wire, contract);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response, normalizeProposal: normalize,
    allowed: new Set<CourseComponentType>(types) });
  return { contract, publication, payload: unitPayload(publication) };
}

function unitPayload(publication: Readonly<OrchestrationV2UnitPublication>) {
  return { contract_version: 2, unit_path: publication.unit_path,
    source_snapshot_hash: publication.source_snapshot_hash, contract_hash: publication.contract_hash,
    nodes: publication.nodes, generated_unit: publication.generated_unit,
    content_origin: publication.content_origin, quality_state: publication.quality_state,
    ...(publication.semantic_review ? { semantic_review: publication.semantic_review } : {}) };
}

function existingTasks(): OrchestrationV2StoredTask[] {
  const provider = { input_tokens: 100_000, embedding_tokens: 0, max_output_tokens: 32_000,
    max_provider_attempts: 2, execution_budget_ms: 300_000 };
  const deterministic = { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
    max_provider_attempts: 0, execution_budget_ms: 60_000 };
  const values: Array<Pick<OrchestrationV2StoredTask, 'task_key' | 'kind' | 'chapter_key' | 'depends_on' | 'budget'>> = [
    { task_key: 'source:snapshot', kind: 'source_snapshot', chapter_key: null, depends_on: [], budget: deterministic },
    { task_key: 'architecture:course', kind: 'course_skeleton', chapter_key: null,
      depends_on: ['source:snapshot'], budget: provider },
    { task_key: 'architecture:chapter:chapter-1:shard:1', kind: 'chapter_blueprint', chapter_key: 'chapter-1',
      depends_on: ['architecture:course'], budget: provider },
    { task_key: 'architecture:validate', kind: 'validate_architecture', chapter_key: null,
      depends_on: ['architecture:chapter:chapter-1:shard:1'], budget: deterministic },
    { task_key: 'inventory:publish', kind: 'publish_inventory', chapter_key: null,
      depends_on: ['architecture:validate'], budget: deterministic },
  ];
  return values.map((value, ordinal) => ({ ...value, id: uuid(100 + ordinal), ordinal, node_id: null,
    contract_hash: hash(`contract-${ordinal}`), input_context_hash: hash(`input-${ordinal}`),
    priority: ordinal * 10, max_attempts: 2 }));
}

/** The whole in-memory chain; every artifact goes through the JSON round trip before its reader sees it. */
function chain(types: readonly CourseComponentType[], normalize: Normalize) {
  const runId = uuid(1), workspaceId = uuid(2), unitTaskId = uuid(20);
  const input = architecture(types);
  const { assembly } = input;
  const inventory = prepareOrchestrationV2InventoryPublication({ run_id: runId, assembly,
    existing_tasks: existingTasks(), budgets: { unit: existingTasks()[1]!.budget, chapter_validation_budget_ms: 60_000,
      finalization_budget_ms: 60_000 } });
  const unit = acceptedUnit(input, types, normalize);
  const storedUnit = roundTrip(unit.payload);
  const unitBinding = inventory.nodes.find(node => node.canonical_path === unit.publication.unit_path)!;
  const chapterNode = inventory.nodes.find(node => node.canonical_path === 'chapter_1')!;
  const receipt = validateOrchestrationV2Chapter({ run_id: runId, assembly: roundTrip(assembly),
    inventory_hash: inventory.inventory_hash, chapter_key: 'chapter-1', chapter_node_id: chapterNode.id,
    source_facts: roundTrip(FACTS).map(fact => ({ ...fact, fact_hash: hash(fact) })),
    units: [{ task_id: unitTaskId, task_key: 'content:chapter-1:unit:1', node_id: unitBinding.id,
      artifact_hash: unit.publication.result_hash, payload: storedUnit }],
    baselines: storedUnit.nodes.map((node, index) => ({ canonical_path: node.path,
      kind: index === 0 ? 'unit' as const : 'component' as const, content_hash: node.content_hash,
      revision: 0, operation_id: unitTaskId })) });
  const storedReceipt = roundTrip({ contract_version: 2, ...receipt });
  const generated = new Map(storedUnit.nodes.map(node => [node.path, node]));
  const nodes: WorkspaceApplyNode[] = roundTrip(inventory.nodes).filter(node => node.kind !== 'course').map(node => {
    const stored = generated.get(node.canonical_path);
    const content = stored?.content ?? node.baseline!;
    const contentHash = stored?.content_hash ?? hash(content);
    return { node_id: node.id, parent_id: node.parent_id!, kind: node.kind as WorkspaceApplyNode['kind'],
      canonical_path: node.canonical_path, sort_order: node.sort_order, content_state: 'content_ready',
      current_revision: 0, protected_contract: node.protected_contract, contract_hash: node.contract_hash,
      baseline: { content, content_hash: contentHash }, current: { content, content_hash: contentHash } };
  });
  const targets = { course_root_id: uuid(30), course_root_hash: hash('root'), mappings: [] };
  const applyInput = { workspace_id: workspaceId, course_node_id: inventory.nodes[0]!.id, run_id: runId,
    content_locale: 'vi' as const, event_head: 4, source_snapshot_hash: input.source, runtime_config_hash: hash('runtime'),
    architecture: roundTrip(assembly), architecture_hash: assembly.assembly_hash, inventory_hash: inventory.inventory_hash,
    nodes, unit_artifacts: [{ task_id: unitTaskId, task_key: 'content:chapter-1:unit:1', node_id: unitBinding.id,
      chapter_key: 'chapter-1', artifact_hash: unit.publication.result_hash, payload: storedUnit }],
    chapter_receipts: [{ chapter_key: 'chapter-1', artifact_hash: receipt.receipt_hash, payload: storedReceipt }],
    allowed: new Set<CourseComponentType>(types), targets, request: { scope_node_id: chapterNode.id,
      expected_workspace_revision: 4, expected_revision_manifest: nodes.map(node => ({ node_id: node.node_id,
        revision: node.current_revision!, content_hash: node.current!.content_hash })),
      expected_target_snapshot_hash: workspaceApplyTargetHash(targets) } };
  return { runId, input, assembly, inventory, unit, storedUnit, receipt, storedReceipt, applyInput };
}

test('every V2 artifact kind: produced → JSON round trip → its reader re-hashes it to the stored hash', async t => {
  const types: CourseComponentType[] = ['html', 'la_diagram'];
  const c = chain(types, await productionNormalizer(t));
  const matches = (kind: Parameters<typeof orchestrationV2StoredArtifactHashMatches>[0], artifactHash: string,
    payload: unknown) => assert.ok(orchestrationV2StoredArtifactHashMatches(kind, artifactHash, roundTrip(payload)), kind);

  // source_catalog, course_skeleton, chapter_blueprint: the planning repository hashes the payload it stores.
  const catalog = toPersistedJson({ contract_version: 2, source_snapshot_hash: c.input.source,
    source_authority: { mode: 'model_designed', source: 'none', complete: true, confidence: 0, structure_hash: hash('s'),
      reason_codes: [], chapters: [] }, scopes: c.input.scopes });
  matches('source_catalog', hash(catalog), catalog);
  const skeleton = toPersistedJson({ contract_version: 2, skeleton: c.input.skeleton, scopes: c.input.scopes,
    shard_plans: [], content_origin: 'provider_validated', quality_state: 'validated' });
  matches('course_skeleton', hash(skeleton), skeleton);
  matches('chapter_blueprint', c.input.shardHash, c.input.shardPayload);

  // architecture_validation: the stored assembly is accepted by its reader.
  matches('architecture_validation', c.assembly.assembly_hash, c.assembly);
  assert.equal(readOrchestrationV2ArchitectureAssembly(roundTrip(c.assembly)).assembly_hash, c.assembly.assembly_hash);

  // inventory_receipt, and every node row: stored contract and baseline re-hash; storyboard bindings verify.
  const { inventory } = c;
  matches('inventory_receipt', inventory.receipt_hash, { contract_version: 2, contract: inventory.contract,
    assembly_hash: inventory.assembly_hash, inventory_hash: inventory.inventory_hash,
    manifest_hash: inventory.manifest.manifest_hash, receipt_hash: inventory.receipt_hash,
    admitted_fact_count: inventory.admitted_fact_count, node_count: inventory.node_count, unit_count: inventory.unit_count,
    component_count: inventory.component_count, media_brief_count: inventory.media_brief_count,
    task_count: inventory.manifest.tasks.length });
  for (const node of roundTrip(inventory.nodes)) {
    assert.equal(hash(node.protected_contract), node.contract_hash, node.canonical_path);
    assert.ok(workspaceHashMatches(node.protected_contract, node.contract_hash), node.canonical_path);
    if (node.baseline) {
      assert.equal(hash(node.baseline), node.protected_contract.baseline_hash, node.canonical_path);
      workspaceStoryboardBoundSeed({ kind: node.kind as 'course', canonical_path: node.canonical_path,
        parent_path: node.parent_path, sort_order: node.sort_order, binding: node.protected_contract, baseline: node.baseline });
    }
  }

  // unit_baseline and its revision-zero rows; chapter_receipt; Apply over the stored artifacts.
  matches('unit_baseline', c.unit.publication.result_hash, c.unit.payload);
  assert.equal(orchestrationV2UnitArtifactHash(c.storedUnit), c.unit.publication.result_hash);
  for (const node of c.storedUnit.nodes) assert.equal(hash(node.content), node.content_hash, node.path);
  matches('chapter_receipt', c.receipt.receipt_hash, c.storedReceipt);
  const compiled = compileOrchestrationV2WorkspaceApply(c.applyInput);
  assert.ok(compiled.writes.length > 0);

  // course_receipt: finalization of this chapter receipt.
  const definitions = [
    ['source:snapshot', 'source_snapshot', null, null, []],
    ['architecture:course', 'course_skeleton', null, null, ['source:snapshot']],
    ['architecture:chapter:chapter-1', 'chapter_blueprint', 'chapter-1', c.receipt.chapter_node_id, ['architecture:course']],
    ['architecture:validate', 'validate_architecture', null, null, ['architecture:chapter:chapter-1']],
    ['inventory:publish', 'publish_inventory', null, null, ['architecture:validate']],
    ['content:chapter-1:unit:1', 'generate_unit', 'chapter-1', uuid(20), ['inventory:publish']],
    ['content:chapter-1:validate', 'validate_chapter', 'chapter-1', c.receipt.chapter_node_id, ['content:chapter-1:unit:1']],
    ['course:finalize', 'finalize_course', null, null, ['content:chapter-1:validate']],
  ] as const;
  const budget = { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0, max_provider_attempts: 0,
    execution_budget_ms: 1000 };
  const providerBudget = { ...budget, input_tokens: 10, max_output_tokens: 10, max_provider_attempts: 1 };
  const tasks: OrchestrationV2FinalizationTask[] = definitions.map((item, ordinal) => ({ ordinal, task_key: item[0],
    kind: item[1], chapter_key: item[2], node_id: item[3], contract_hash: hash(`contract-${ordinal}`),
    input_context_hash: hash(`input-${ordinal}`), priority: ordinal * 10, max_attempts: 2, depends_on: [...item[4]],
    budget: ['course_skeleton', 'chapter_blueprint', 'generate_unit'].includes(item[1]) ? providerBudget : budget,
    status: item[1] === 'finalize_course' ? 'running' : 'succeeded',
    result_hash: item[1] === 'finalize_course' ? null : item[1] === 'validate_chapter' ? c.receipt.receipt_hash
      : hash(`result-${ordinal}`),
    validation_contract: item[1] === 'finalize_course' ? null : item[1] === 'validate_chapter' ? c.receipt.contract : 'test' }));
  const manifest = sealOrchestrationV2PersistedManifest({ source_snapshot_hash: c.receipt.source_snapshot_hash,
    tasks: tasks.map(({ status: _status, result_hash: _result, validation_contract: _contract, ...task }) => task) });
  const finalization = finalizeOrchestrationV2Course({ source_snapshot_hash: c.receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2, assembly_hash: c.receipt.assembly_hash,
    inventory_hash: c.receipt.inventory_hash, tasks, chapter_receipts: [c.receipt] });
  matches('course_receipt', finalization.course_artifact_hash, { contract_version: 2, ...finalization });

  // A payload whose stored JSON does not re-hash to the artifact hash is refused by the same rule.
  assert.equal(orchestrationV2StoredArtifactHashMatches('unit_baseline', hash('other'), roundTrip(c.unit.payload)), false);
  assert.equal(orchestrationV2StoredArtifactHashMatches('chapter_receipt', c.receipt.receipt_hash,
    roundTrip({ ...c.storedReceipt, unit_count: 2 })), false);
  assert.equal(orchestrationV2StoredArtifactHashMatches('architecture_validation', c.assembly.assembly_hash, null), false);
});

test('regression (run 43fabc57): an unlabeled la_diagram edge passes acceptance → JSON round trip → chapter validation → Apply', async t => {
  const normalize = await productionNormalizer(t);
  const types: CourseComponentType[] = ['html', 'la_diagram'];
  for (const [name, normalizer] of [['current normalizer', normalize],
    ['pre-b34bec4 normalizer (label: undefined)', withUndefinedEdgeLabels(normalize)]] as const) {
    const c = chain(types, normalizer);
    const diagram = c.storedUnit.generated_unit.components[1] as unknown as Row;
    const edges = ((diagram.metadata as Row).diagram_data as { diagrams: Array<{ edges: Row[] }> }).diagrams[0]!.edges;
    assert.ok(edges.some(edge => !('label' in edge)), `${name}: an unlabeled edge is stored without a label key`);
    assert.equal(orchestrationV2UnitArtifactHash(c.storedUnit), c.unit.publication.result_hash, name);
    assert.equal(c.receipt.unit_artifact_hashes[0], c.unit.publication.result_hash, name);
    assert.ok(compileOrchestrationV2WorkspaceApply(c.applyInput).writes.length > 0, name);
  }
  // The pre-fix normalizer output is exactly the value the old hash got wrong: the previous encoder hashes
  // its in-memory form differently from the JSON the database stores.
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly: architecture(types).assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: FACTS });
  const raw = { chapters: [{ title: contract.chapter_title, lessons: [{ title: contract.lesson_title, units: [{
    title: contract.unit_title, components: contract.component_plan.map((plan, index) => wireComponent(types[index]!, plan)),
  }] }] }] };
  const inMemory = withUndefinedEdgeLabels(normalize)(raw);
  assert.notEqual(previousHash(inMemory), previousHash(roundTrip(inMemory)));
  assert.equal(hash(toPersistedJson(inMemory)), previousHash(roundTrip(inMemory)));
});

test('V2 Apply accepts a component revision hashed by either encoder (author edit vs AI baseline)', async t => {
  const c = chain(['html', 'la_diagram'], await productionNormalizer(t));
  const component = c.applyInput.nodes.find(node => node.canonical_path === 'chapter_1.lesson_1.unit_1.component_1')!;
  const content = structuredClone(component.current!.content);
  // An author edit is written with generationSnapshotHash (prepareWorkspaceEdit).
  component.current_revision = 1;
  component.current = { content, content_hash: generationSnapshotHash(content) };
  c.applyInput.request.expected_revision_manifest = c.applyInput.nodes.map(node => ({ node_id: node.node_id,
    revision: node.current_revision!, content_hash: node.current!.content_hash }));
  assert.ok(compileOrchestrationV2WorkspaceApply(c.applyInput).writes.length > 0);
});

// --- Write-time guards ---------------------------------------------------------------------------------------

function lease(kind: OrchestrationV2TaskLease['kind']): OrchestrationV2TaskLease {
  return { task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: `task:${kind}`, kind, chapter_key: 'chapter-1', node_id: uuid(6), contract_hash: hash('contract'),
    input_context_hash: hash('input'), source_snapshot_id: uuid(7), source_snapshot_hash: hash('hash-roundtrip-source'),
    runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi', max_output_tokens: 0,
    provider_max_attempts: 0, execution_budget_ms: 60_000, lease_token: uuid(9), dispatch_epoch: 1,
    provider_replay_required: false, routing_shard: 1, ai_reservation_id: null };
}

function recordingDatabase(route: (sql: string) => Row[] | undefined) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = route(sql);
      assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows!.length };
    },
  };
  const db: GenerationJobDatabase = { transaction: async work => work(tx) };
  return { db, queries };
}

test('worker.succeed refuses an artifact whose stored JSON would not re-hash, before any SQL', async () => {
  const receipt = { contract: 'orchestration-chapter-receipt-v2', chapter_key: 'chapter-1', unit_count: 1,
    labels: [{ id: 'edge_1', label: undefined as string | undefined }] };
  // The old producer: hash taken on the in-memory object by the previous encoder.
  const staleHash = previousHash(receipt);
  const stale = recordingDatabase(() => undefined);
  await assert.rejects(createOrchestrationV2WorkerRepository(stale.db).succeed(lease('validate_chapter'), staleHash,
    'orchestration-chapter-receipt-v2', {}, { artifact_kind: 'chapter_receipt', artifact_hash: staleHash,
      payload: { contract_version: 2, ...receipt, receipt_hash: staleHash },
      validation_contract: 'orchestration-chapter-receipt-v2' }, async () => undefined),
  { code: 'ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH' });
  assert.equal(stale.queries.length, 0);

  // Hashed as persisted: stored, and the stored text is exactly the JSON that was checked.
  const freshHash = hash(toPersistedJson(receipt));
  const payload = { contract_version: 2, ...receipt, receipt_hash: freshHash };
  const fresh = recordingDatabase(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) return [{ id: uuid(3) }];
    if (/INSERT INTO lesson_author_workspace_v2_artifacts/.test(sql)) return [{ id: uuid(11) }];
    if (/SET status='succeeded'/.test(sql)) return [{ id: uuid(3) }];
    return undefined;
  });
  await createOrchestrationV2WorkerRepository(fresh.db).succeed(lease('validate_chapter'), freshHash,
    'orchestration-chapter-receipt-v2', {}, { artifact_kind: 'chapter_receipt', artifact_hash: freshHash, payload,
      validation_contract: 'orchestration-chapter-receipt-v2' }, async () => undefined);
  const insert = fresh.queries.find(query => /INSERT INTO lesson_author_workspace_v2_artifacts/.test(query.sql))!;
  assert.equal(insert.params[7], JSON.stringify(payload));
  assert.ok(orchestrationV2StoredArtifactHashMatches('chapter_receipt', freshHash, JSON.parse(String(insert.params[7]))));
});

test('unit and inventory completion refuse rows whose stored JSON would not re-hash, before any write', async t => {
  const c = chain(['html', 'la_diagram'], await productionNormalizer(t));
  const noDatabase: GenerationJobDatabase = { transaction: async () => assert.fail('no transaction expected') };
  const calls: unknown[][] = [];
  const worker = { succeed: async (...args: unknown[]) => { calls.push(args); } } as unknown as
    ReturnType<typeof createOrchestrationV2WorkerRepository>;

  const units = createOrchestrationV2UnitRepository(noDatabase, worker);
  const unitLease = { ...lease('generate_unit'), source_snapshot_hash: c.unit.publication.source_snapshot_hash };
  const tampered = { ...c.unit.publication, nodes: c.unit.publication.nodes.map((node, index) => index === 1
    ? { ...node, content_hash: previousHash({ ...node.content, data: undefined }) } : node) };
  await assert.rejects(units.complete(unitLease, tampered, {}, async () => undefined, async () => undefined, 'provider'),
    { code: ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH });
  assert.equal(calls.length, 0);
  await units.complete(unitLease, c.unit.publication, {}, async () => undefined, async () => undefined, 'provider');
  assert.equal(calls.length, 1);
  const artifact = calls[0]![4] as { artifact_kind: 'unit_baseline'; artifact_hash: string; payload: Row };
  assert.ok(orchestrationV2StoredArtifactHashMatches(artifact.artifact_kind, artifact.artifact_hash,
    roundTrip(artifact.payload)));

  const inventories = createOrchestrationV2InventoryRepository(noDatabase, worker);
  const inventoryLease = { ...lease('publish_inventory'), input_context_hash: c.inventory.assembly_hash,
    source_snapshot_hash: c.inventory.manifest.source_snapshot_hash };
  const course = c.inventory.nodes.find(node => node.kind === 'course')!;
  const staleBaseline = { ...c.inventory, nodes: c.inventory.nodes.map(node => node === course
    ? { ...node, protected_contract: { ...node.protected_contract,
      baseline_hash: previousHash({ ...node.baseline, purpose: undefined }) } } : node) };
  await assert.rejects(inventories.complete(inventoryLease, staleBaseline), { code: ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH });
  const staleContract = { ...c.inventory, nodes: c.inventory.nodes.map(node => node === course
    ? { ...node, contract_hash: hash('other') } : node) };
  await assert.rejects(inventories.complete(inventoryLease, staleContract), { code: ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH });
  assert.equal(calls.length, 1);
  await inventories.complete(inventoryLease, c.inventory);
  assert.equal(calls.length, 2);
  const receipt = calls[1]![4] as { artifact_kind: 'inventory_receipt'; artifact_hash: string; payload: Row };
  assert.ok(orchestrationV2StoredArtifactHashMatches(receipt.artifact_kind, receipt.artifact_hash, roundTrip(receipt.payload)));
});
