import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import { compileOrchestrationV2WorkspaceApply } from './lesson-author-orchestration-v2-apply.logic.js';
import { validateOrchestrationV2Chapter } from './lesson-author-orchestration-v2-chapter.logic.js';
import { prepareOrchestrationV2InventoryIdentity } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { acceptOrchestrationV2GeneratedUnit, prepareOrchestrationV2UnitGenerationContract,
  readOrchestrationV2UnitProviderResponse, orchestrationV2UnitArtifactHash } from './lesson-author-orchestration-v2-unit.logic.js';
import { workspaceApplyTargetHash, type WorkspaceApplyNode } from './lesson-author-workspace-apply.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: unknown) => orchestrationV2Hash(value);
const allowed = new Set<CourseComponentType>(['html']);

function fixture(withSemanticReview = false) {
  const source = hash('v2-apply-source');
  const skeleton = { contract_version: 2 as const, source_snapshot_hash: source, locale: 'vi' as const,
    title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
    learning_outcomes: ['Apply'], assessment_strategy: 'Practice', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn',
      learning_outcomes: ['Apply safely'], source_scope_ids: ['scope-1'],
    }] };
  const shard = { contract_version: 2 as const, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
    shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn', lessons: [{
      title: 'Lesson', objective: 'Learn', learning_objectives: ['Apply safely'], learning_activities: ['Read'],
      assessment: 'Check', units: [{ title: 'Unit', purpose: 'Teach safely', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [{ type: 'html' as const, title: 'Explanation',
          rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: null }] }] };
  const assembly = assembleOrchestrationV2Architecture(skeleton,
    [{ scope_key: 'scope-1', title: 'Scope', source_ref: 'doc.pdf', fact_count: 2, content_chars: 60 }],
    [{ artifact_hash: hash('v2-apply-shard'), shard }]);
  const facts: OrchestrationV2SourceFact[] = [
    { document_id: uuid(11), fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Read first.',
      source_ref: 'doc.pdf', source_page: 1, source_chunk: 0, locator: {} },
    { document_id: uuid(11), fact_key: 'fact-2', scope_key: 'scope-1', fact_text: 'Verify controls.',
      source_ref: 'doc.pdf', source_page: 1, source_chunk: 0, locator: {} },
  ];
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: facts });
  const plan = contract.component_plan[0]!;
  const wire = { contract_version: 2, source_snapshot_hash: source, unit_path: contract.unit_path,
    unit: { title: contract.unit_title, source_fact_ids: [...contract.unit_source_fact_ids], components: [{
      type: 'html', title: 'Explanation', data: '<p>Read first and verify every control before work.</p>',
      component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
      covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [], metadata: {
        component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
        covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [],
        learning_objective_refs: [...plan.learning_objective_refs],
      },
    }] }, usage_complete: true as const, usage_source: 'provider' as const, usage: {} };
  const semanticReview = { contract_version: 'semantic-review-v1', config_hash: 'a'.repeat(64), status: 'passed',
    quality_state: 'validated', finding_counts: { critical: 0, major: 0, minor: 0 }, findings: [],
    repair_attempted: false, repair_applied: false, repair_component_indices: [], failure_code: null };
  const response = readOrchestrationV2UnitProviderResponse(withSemanticReview
    ? { ...wire, semantic_review: semanticReview }
    : wire, contract);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response,
    normalizeProposal: raw => ({ summary: '', chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    allowed });
  const runId = uuid(1), workspaceId = uuid(2);
  const identity = prepareOrchestrationV2InventoryIdentity({ run_id: runId, assembly });
  const publicationByPath = new Map(publication.nodes.map(node => [node.path, node]));
  const taskId = uuid(20);
  const nodes: WorkspaceApplyNode[] = identity.nodes.filter(node => node.kind !== 'course').map(node => {
    const generated = publicationByPath.get(node.canonical_path);
    const content = generated?.content ?? node.baseline!;
    const contentHash = generated?.content_hash ?? hash(content);
    return { node_id: node.id, parent_id: node.parent_id!, kind: node.kind as WorkspaceApplyNode['kind'],
      canonical_path: node.canonical_path, sort_order: node.sort_order, content_state: 'content_ready',
      current_revision: 0, protected_contract: node.protected_contract, contract_hash: node.contract_hash,
      baseline: { content, content_hash: contentHash }, current: { content, content_hash: contentHash } };
  });
  const unitPayload = { contract_version: 2, unit_path: publication.unit_path,
    source_snapshot_hash: publication.source_snapshot_hash, contract_hash: publication.contract_hash,
    nodes: publication.nodes, generated_unit: publication.generated_unit,
    content_origin: publication.content_origin, quality_state: publication.quality_state,
    ...(publication.semantic_review ? { semantic_review: publication.semantic_review } : {}) };
  const unitArtifact = { task_id: taskId, task_key: 'content:chapter-1:unit:1',
    node_id: identity.unit_bindings[0]!.unit_node_id, chapter_key: 'chapter-1',
    artifact_hash: publication.result_hash, payload: unitPayload };
  const receipt = validateOrchestrationV2Chapter({ run_id: runId, assembly,
    inventory_hash: identity.inventory_hash, chapter_key: 'chapter-1',
    chapter_node_id: identity.unit_bindings[0]!.chapter_node_id,
    source_facts: facts.map(fact => ({ ...fact, fact_hash: hash(fact) })),
    units: [{ task_id: taskId, task_key: unitArtifact.task_key, node_id: unitArtifact.node_id,
      artifact_hash: unitArtifact.artifact_hash, payload: unitPayload }],
    baselines: publication.nodes.map((node, index) => ({ canonical_path: node.path,
      kind: index === 0 ? 'unit' as const : 'component' as const, content_hash: node.content_hash,
      revision: 0, operation_id: taskId })) });
  const root = uuid(30);
  const manifest = nodes.map(node => ({ node_id: node.node_id, revision: node.current_revision!,
    content_hash: node.current!.content_hash }));
  const targets = { course_root_id: root, course_root_hash: hash('root'), mappings: [] };
  return { input: { workspace_id: workspaceId, course_node_id: identity.nodes[0]!.id, run_id: runId,
    content_locale: 'vi' as const, event_head: 4, source_snapshot_hash: source,
    runtime_config_hash: hash('runtime'), architecture: assembly, architecture_hash: assembly.assembly_hash,
    inventory_hash: identity.inventory_hash, nodes, unit_artifacts: [unitArtifact], chapter_receipts: [{
      chapter_key: 'chapter-1', artifact_hash: receipt.receipt_hash, payload: { contract_version: 2, ...receipt },
    }], allowed, targets, request: { scope_node_id: identity.unit_bindings[0]!.chapter_node_id,
      expected_workspace_revision: 4, expected_revision_manifest: manifest,
      expected_target_snapshot_hash: workspaceApplyTargetHash(targets) } }, publication };
}

function replaceCurrent(input: ReturnType<typeof fixture>['input'], path: string,
  transform: (content: Record<string, unknown>) => Record<string, unknown>) {
  const node = input.nodes.find(candidate => candidate.canonical_path === path)!;
  const content = transform(structuredClone(node.current!.content) as Record<string, unknown>);
  node.current_revision = 1;
  node.current = { content, content_hash: hash(content) };
  input.request.expected_revision_manifest = input.nodes.map(candidate => ({ node_id: candidate.node_id,
    revision: candidate.current_revision!, content_hash: candidate.current!.content_hash }));
  return node;
}

function resealUnitArtifact(input: ReturnType<typeof fixture>['input']) {
  const artifact = input.unit_artifacts[0]!;
  const payload = artifact.payload as Record<string, unknown>;
  artifact.artifact_hash = orchestrationV2UnitArtifactHash(payload);
  const chapter = input.chapter_receipts[0]!;
  const receipt = chapter.payload as Record<string, any>;
  receipt.unit_artifact_hashes = [artifact.artifact_hash];
  const { contract_version: _version, receipt_hash: _oldHash, ...receiptBase } = receipt;
  receipt.receipt_hash = hash(receiptBase);
  chapter.artifact_hash = receipt.receipt_hash;
}

test('V2 Apply compiles a validated chapter into exact draft hierarchy writes', () => {
  const { input, publication } = fixture();
  const result = compileOrchestrationV2WorkspaceApply(input);
  assert.deepEqual(result.writes.map(write => write.block_type), ['chapter', 'sequential', 'vertical', 'html']);
  assert.equal(result.writes[3]!.component?.data, publication.generated_unit.components[0]!.data);
  assert.equal(result.acceptance.checks.coverage, 'PASS');
  assert.equal(result.acceptance.checks.pedagogy, 'NOT_RUN');
  assert.equal(result.acceptance.checks.dependencies, 'NOT_APPLICABLE');
  assert.equal(result.validation_contract, 'workspace-scoped-apply-2');
  assert.equal(result.quality_receipt.origin_summary.counts.provider, 1);
  assert.equal(result.quality_receipt.origin_summary.legacy_quality_status, 'NOT_RUN');
});

test('semantic review is covered by the shared unit artifact hash through chapter receipt and Apply', () => {
  const { input, publication } = fixture(true);
  assert.equal(publication.semantic_review?.status, 'passed');
  assert.doesNotThrow(() => compileOrchestrationV2WorkspaceApply(input));
});

test('V2 Apply admits structured source fallback for review but never raw diagnostic fallback', () => {
  const structured = fixture();
  Object.assign(structured.input.unit_artifacts[0]!.payload, {
    content_origin: 'structured_fallback', quality_state: 'review_required',
  });
  resealUnitArtifact(structured.input);
  assert.doesNotThrow(() => compileOrchestrationV2WorkspaceApply(structured.input));

  const raw = fixture();
  Object.assign(raw.input.unit_artifacts[0]!.payload, {
    content_origin: 'raw_source_fallback', quality_state: 'review_required',
  });
  assert.throws(() => compileOrchestrationV2WorkspaceApply(raw.input), { code: 'WORKSPACE_APPLY_VALIDATION_FAILED' });
});

test('V2 section, lesson and component scopes keep exact hierarchy boundaries', () => {
  const expected = ['chapter_1', 'chapter_1.lesson_1', 'chapter_1.lesson_1.unit_1', 'chapter_1.lesson_1.unit_1.component_1'];
  for (const path of ['chapter_1.lesson_1', 'chapter_1.lesson_1.unit_1', 'chapter_1.lesson_1.unit_1.component_1']) {
    const { input } = fixture();
    input.request.scope_node_id = input.nodes.find(node => node.canonical_path === path)!.node_id;
    assert.deepEqual(compileOrchestrationV2WorkspaceApply(input).writes.map(write => write.canonical_path), expected);
  }
});

test('V2 Apply materializes the current author-edited component revision without changing provenance', () => {
  const { input } = fixture();
  const component = input.nodes.find(node => node.kind === 'component')!;
  const edited = { ...component.current!.content as Record<string, unknown>, title: 'Edited explanation' };
  component.current_revision = 1;
  component.current = { content: edited, content_hash: hash(edited) };
  input.request.expected_revision_manifest = input.nodes.map(node => ({ node_id: node.node_id,
    revision: node.current_revision!, content_hash: node.current!.content_hash }));
  const result = compileOrchestrationV2WorkspaceApply(input);
  assert.equal(result.writes.find(write => write.kind === 'component')!.component!.title, 'Edited explanation');
  assert.deepEqual(result.writes.find(write => write.kind === 'component')!.component!.metadata!.source_fact_ids,
    ['fact-1', 'fact-2']);
});

test('V2 Apply materializes valid current chapter, lesson and unit title revisions', () => {
  const { input } = fixture();
  const edited = [
    ['chapter_1', 'Edited chapter'],
    ['chapter_1.lesson_1', 'Edited lesson'],
    ['chapter_1.lesson_1.unit_1', 'Edited unit'],
  ] as const;
  for (const [path, title] of edited) replaceCurrent(input, path, content => ({ ...content, title }));

  const result = compileOrchestrationV2WorkspaceApply(input);
  for (const [path, title] of edited) {
    const write = result.writes.find(candidate => candidate.canonical_path === path)!;
    const node = input.nodes.find(candidate => candidate.canonical_path === path)!;
    assert.equal(write.title, title);
    assert.equal(write.revision, 1);
    assert.equal(write.content_hash, node.current!.content_hash);
  }
  assert.deepEqual(result.writes.find(write => write.canonical_path === 'chapter_1')!.author_metadata.storyboard,
    (input.nodes.find(node => node.canonical_path === 'chapter_1')!.current!.content as { data: unknown }).data);
});

test('V2 Apply revalidates changed storyboard revisions without reinterpreting an unchanged accepted baseline', () => {
  const source = readFileSync(new URL('./lesson-author-orchestration-v2-apply.logic.ts', import.meta.url), 'utf8');
  assert.match(source, /stored\.kind !== 'component' && !same\(live, base\)/);
  assert.match(source, /workspaceStoryboardBoundSeed/);
  assert.match(source, /editWorkspaceStoryboard/);
});

test('V2 Apply rejects an edited storyboard revision that violates its protected field shape', () => {
  const { input } = fixture();
  replaceCurrent(input, 'chapter_1.lesson_1', content => ({ ...content,
    data: { ...(content.data as Record<string, unknown>), learning_objectives: [] } }));
  assert.throws(() => compileOrchestrationV2WorkspaceApply(input), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'WORKSPACE_APPLY_VALIDATION_FAILED');
    assert.deepEqual((error as { findings?: unknown }).findings,
      [{ code: 'WORKSPACE_APPLY_VALIDATION_FAILED', path: 'chapter_1.lesson_1' }]);
    return true;
  });
});

test('V2 Apply keeps revision-manifest fencing after a valid storyboard edit', () => {
  const { input } = fixture();
  replaceCurrent(input, 'chapter_1', content => ({ ...content, title: 'Edited chapter' }));
  input.request.expected_revision_manifest = input.request.expected_revision_manifest.map(entry =>
    entry.node_id === input.nodes.find(node => node.canonical_path === 'chapter_1')!.node_id
      ? { ...entry, revision: 0 }
      : entry);
  assert.throws(() => compileOrchestrationV2WorkspaceApply(input), { code: 'WORKSPACE_APPLY_REVISION_CONFLICT' });
});

test('V2 Apply accepts an artifact-bound historical baseline after sanitizer rules evolve', () => {
  const { input } = fixture();
  const component = input.nodes.find(node => node.kind === 'component')!;
  const legacy = { ...(component.baseline!.content as Record<string, unknown>),
    data: '<p>Read first and verify every control before work.</p><p><br></p>' };
  const legacyHash = hash(legacy);
  component.baseline = { content: legacy, content_hash: legacyHash };
  component.current = { content: legacy, content_hash: legacyHash };

  const artifact = input.unit_artifacts[0]!;
  delete (artifact.payload as Record<string, unknown>).content_origin;
  delete (artifact.payload as Record<string, unknown>).quality_state;
  const payload = artifact.payload as { unit_path: string; source_snapshot_hash: string; contract_hash: string;
    nodes: Array<{ path: string; content: unknown; content_hash: string }>; generated_unit: unknown };
  const artifactNode = payload.nodes.find(node => node.path === component.canonical_path)!;
  artifactNode.content = legacy;
  artifactNode.content_hash = legacyHash;
  artifact.artifact_hash = orchestrationV2UnitArtifactHash(artifact.payload as Record<string, unknown>);

  const chapter = input.chapter_receipts[0]!;
  const receipt = chapter.payload as Record<string, any>;
  receipt.unit_artifact_hashes = [artifact.artifact_hash];
  const { contract_version: _version, receipt_hash: _oldHash, ...receiptBase } = receipt;
  receipt.receipt_hash = hash(receiptBase);
  chapter.artifact_hash = receipt.receipt_hash;
  input.request.expected_revision_manifest = input.nodes.map(node => ({ node_id: node.node_id,
    revision: node.current_revision!, content_hash: node.current!.content_hash }));

  const result = compileOrchestrationV2WorkspaceApply(input);
  assert.equal(result.writes.find(write => write.kind === 'component')!.component!.data,
    '<p>Read first and verify every control before work.</p><p><br /></p>');
});

test('V2 Apply does not invent prerequisites from canonical presentation order', () => {
  const source = readFileSync(new URL('./lesson-author-orchestration-v2-apply.logic.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /prerequisiteUnits|orderedUnits\.slice/);
  assert.match(source, /const required: WorkspaceApplyNode\[\] = \[\]/);
});

test('V2 Apply rejects artifact drift before producing course writes', () => {
  const { input } = fixture();
  input.unit_artifacts[0]!.artifact_hash = hash('tampered');
  assert.throws(() => compileOrchestrationV2WorkspaceApply(input), { code: 'WORKSPACE_APPLY_VALIDATION_FAILED' });
});

test('production Apply repository routes blueprint-null V2 workspaces through validated artifacts', () => {
  const source = readFileSync(new URL('./lesson-author-workspace-apply.repository.ts', import.meta.url), 'utf8');
  assert.match(source, /LEFT JOIN lesson_author_workspace_v2_runs v2/);
  assert.match(source, /w\.blueprint_id === null && typeof w\.v2_run_id === 'string'/);
  assert.match(source, /artifact_kind='unit_baseline'/);
  assert.match(source, /artifact_kind='chapter_receipt'/);
  assert.match(source, /compileOrchestrationV2WorkspaceApply\(/);
  assert.match(source, /INSERT INTO lesson_author_workspace_quality_receipts/);
  assert.match(source, /quality_receipt_id,validation_contract/);
  assert.match(source, /compiled\.validation_contract/);
  assert.doesNotMatch(source, /workspace-scoped-apply-1[^\n]*JSON\.stringify\(compiled\.acceptance\.checks\)/);
  assert.match(source, /ORDER BY n\.canonical_path FOR UPDATE OF n/);
  assert.doesNotMatch(source, /FOR UPDATE OF n,b,r/);
  assert.match(source, /JOIN lesson_author_workspace_nodes mapped_node ON mapped_node\.workspace_id=m\.workspace_id AND mapped_node\.id=m\.node_id/);
  assert.match(source, /substring\(mapped_node\.canonical_path from '\^chapter_\(\[0-9\]\+\)'\)\)::integer <= \$4/);
  assert.match(source, /\[target\.workspaceId, target\.tenantId, target\.courseId, chapterCount\]/);
  assert.match(source, /authorityCode === 'WORKSPACE_SOURCE_CHANGED'.*WORKSPACE_APPLY_SOURCE_CHANGED/s);
  assert.doesNotMatch(source, /FROM lesson_author_workspaces w JOIN lesson_author_blueprints b/);
});
