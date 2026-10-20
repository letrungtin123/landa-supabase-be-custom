import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { LessonAuthorProposal } from '../../../../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../../../../tenants/tenant-course-components.constants.js';
import { assembleOrchestrationV2Architecture } from '../../orchestration/lesson-author-orchestration-v2-architecture.logic.js';
import { compileOrchestrationV2WorkspaceApply } from './lesson-author-orchestration-v2-apply.logic.js';
import { validateOrchestrationV2Chapter } from '../../orchestration/steps/lesson-author-orchestration-v2-chapter.logic.js';
import { prepareOrchestrationV2InventoryIdentity } from '../../orchestration/steps/lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from '../../shared/lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from '../../contracts/lesson-author-orchestration-v2-rag-contract.logic.js';
import { acceptOrchestrationV2GeneratedUnit, prepareOrchestrationV2UnitGenerationContract,
  readOrchestrationV2UnitProviderResponse, orchestrationV2UnitArtifactHash } from '../../orchestration/steps/lesson-author-orchestration-v2-unit.logic.js';
import { workspaceApplyMaterializationPlan, workspaceApplyTargetHash, type WorkspaceApplyMapping,
  type WorkspaceApplyNode } from './lesson-author-workspace-apply.logic.js';
import { workspaceApplyBlockMetadata } from './lesson-author-workspace-author-notes.logic.js';
import { WorkspaceApplyCompileError } from './lesson-author-workspace-apply.logic.js';
import { readWorkspaceApplyReason, WORKSPACE_APPLY_REASON_CATEGORIES, workspaceApplyLocation, workspaceApplyReasonFromCompileError,
  workspaceApplyReasonMessage } from './lesson-author-workspace-apply-reason.logic.js';
import { COURSE_AUTHOR_NOTES_KEY, readCourseAuthorNotes } from '../../../../course-authoring/course-author-notes.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: unknown) => orchestrationV2Hash(value);
const allowed = new Set<CourseComponentType>(['html']);

type AuthorReview = { purpose: string | null; example_scenario: string | null; visual_asset: string | null; user_behavior_navigation: string | null };
function fixture(withSemanticReview = false, authorReview?: AuthorReview) {
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
          rationale: 'Core teaching', source_scope_ids: ['scope-1'], ...(authorReview ? { author_review: authorReview } : {}) }],
        media_brief: null }] }] };
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

test('V2 Apply rewrites a course block edited after Apply only when the repository tolerates that exact drift', () => {
  const input: Parameters<typeof compileOrchestrationV2WorkspaceApply>[0] = fixture().input;
  const first = compileOrchestrationV2WorkspaceApply(input);
  const blockIds = new Map(first.writes.map((write, index) => [write.node_id, uuid(100 + index)]));
  const mappings: WorkspaceApplyMapping[] = first.writes.map((write, index) => ({ node_id: write.node_id,
    target_block_id: blockIds.get(write.node_id)!,
    target_parent_id: write.kind === 'chapter' ? input.targets.course_root_id : blockIds.get(write.parent_node_id)!,
    target_block_type: write.block_type, target_sort_order: write.sort_order, applied_revision: write.revision,
    applied_content_hash: write.content_hash, target_hash: hash(`applied-${index}`), actual_target_hash: hash(`applied-${index}`),
    receipt_revision_manifest: input.request.expected_revision_manifest.map(entry => ({ ...entry })) }));
  const useTargets = (next: WorkspaceApplyMapping[]) => {
    input.targets = { ...input.targets, mappings: next };
    input.request.expected_target_snapshot_hash = workspaceApplyTargetHash(input.targets);
  };
  useTargets(mappings);
  const unchanged = compileOrchestrationV2WorkspaceApply(input);
  assert.equal(workspaceApplyMaterializationPlan(unchanged.writes, mappings, input.request.scope_node_id).writes.length, 0);

  // The author renamed the chapter in the course after it was applied.
  const chapter = first.writes.find(write => write.kind === 'chapter')!;
  const edited = mappings.map(entry => entry.node_id === chapter.node_id ? { ...entry, actual_target_hash: hash('author-edit') } : entry);
  useTargets(edited);
  assert.throws(() => compileOrchestrationV2WorkspaceApply(input), { code: 'WORKSPACE_APPLY_TARGET_CHANGED' });
  const confirmed = compileOrchestrationV2WorkspaceApply({ ...input, tolerated_target_drift: [chapter.node_id] });
  const plan = workspaceApplyMaterializationPlan(confirmed.writes, edited, input.request.scope_node_id);
  assert.deepEqual(plan.writes.map(write => write.node_id), [chapter.node_id], 'only the edited block is rewritten');
  assert.equal(plan.writes[0]!.mapped_target?.before_hash, mappings[0]!.target_hash, 'receipt delta keeps the recorded hash');
  // Tolerating content drift never widens the identity fences.
  useTargets(edited.map(entry => entry.node_id === chapter.node_id ? { ...entry, target_parent_id: uuid(999) } : entry));
  assert.throws(() => compileOrchestrationV2WorkspaceApply({ ...input, tolerated_target_drift: [chapter.node_id] }),
    { code: 'WORKSPACE_APPLY_TARGET_CHANGED' });
});

test('V2 author review and storyboard reach only the author notes key, never the learner component (N6)', () => {
  const review = { purpose: 'REVIEW_PURPOSE_ONLY', example_scenario: 'REVIEW_EXAMPLE_ONLY', visual_asset: null, user_behavior_navigation: null };
  const { input } = fixture(false, review);
  const result = compileOrchestrationV2WorkspaceApply(input);
  const component = result.writes.find(write => write.kind === 'component')!;
  assert.deepEqual(component.author_metadata.author_review, review);
  const context = { workspace_id: input.workspace_id, content_locale: input.content_locale };
  const stored = workspaceApplyBlockMetadata(component, context);
  assert.deepEqual(readCourseAuthorNotes(stored[COURSE_AUTHOR_NOTES_KEY])!.author_review, review);
  const { [COURSE_AUTHOR_NOTES_KEY]: _notes, ...learnerMetadata } = stored;
  assert.equal(JSON.stringify({ data: component.component?.data, learnerMetadata }).includes('_ONLY'), false);
  const lesson = readCourseAuthorNotes(workspaceApplyBlockMetadata(result.writes.find(write => write.kind === 'lesson')!, context)[COURSE_AUTHOR_NOTES_KEY])!;
  assert.deepEqual(lesson.storyboard, { assessment: 'Check', learning_activities: ['Read'], learning_objectives: ['Apply safely'], objective: 'Learn' });
  assert.equal(lesson.content_locale, 'vi');
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

// ── Author-facing Apply reasons: every refusal names what to fix and where ──

function refusal(input: ReturnType<typeof fixture>['input']) {
  try {
    compileOrchestrationV2WorkspaceApply(input);
  } catch (error) {
    assert.ok(error instanceof WorkspaceApplyCompileError);
    return { code: error.code, reason: workspaceApplyReasonFromCompileError(error, input.nodes) };
  }
  return assert.fail('expected an Apply refusal');
}
const where = {
  chapter: { number: 1, title: 'Chapter' }, lesson: { number: 1, title: 'Lesson' }, unit: { number: 1, title: 'Unit' },
};

test('Apply reason: a chapter without its final check names that chapter', () => {
  const { input } = fixture();
  input.chapter_receipts = [];
  assert.deepEqual(refusal(input), { code: 'WORKSPACE_APPLY_VALIDATION_FAILED', reason: { category: 'CHAPTER_NOT_COMPLETED',
    location: { chapter: where.chapter, lesson: null, unit: null, component: null } } });
  const tampered = fixture().input;
  (tampered.chapter_receipts[0]!.payload as Record<string, unknown>).covered_fact_count = 1;
  assert.equal(refusal(tampered).reason?.category, 'CHAPTER_NOT_COMPLETED');
  const foreign = fixture().input;
  (foreign.chapter_receipts[0]!.payload as Record<string, unknown>).inventory_hash = hash('other-inventory');
  assert.deepEqual(refusal(foreign).reason?.location?.chapter, where.chapter);
});

test('Apply reason: a missing lesson draft, a raw-source fallback and a drifted artifact are told apart', () => {
  const missing = fixture().input;
  missing.unit_artifacts = [];
  assert.deepEqual(refusal(missing), { code: 'WORKSPACE_APPLY_VALIDATION_FAILED', reason: { category: 'UNIT_NOT_GENERATED',
    location: { ...where, component: null } } });

  const raw = fixture().input;
  Object.assign(raw.unit_artifacts[0]!.payload as Record<string, unknown>, {
    content_origin: 'raw_source_fallback', quality_state: 'review_required' });
  assert.deepEqual(refusal(raw).reason, { category: 'UNIT_FALLBACK_NOT_APPLICABLE', location: { ...where, component: null } });

  const renamedTask = fixture().input;
  renamedTask.unit_artifacts[0]!.task_key = 'content:chapter-1:unit:9';
  assert.deepEqual(refusal(renamedTask).reason, { category: 'CONTENT_CHANGED', location: { ...where, component: null } });

  const drifted = fixture().input;
  drifted.unit_artifacts[0]!.artifact_hash = hash('tampered');
  assert.deepEqual(refusal(drifted), { code: 'WORKSPACE_APPLY_VALIDATION_FAILED',
    reason: { category: 'CONTENT_CHANGED', location: { ...where, component: null } } });
});

test('Apply reason: edited content, unfinished content and changed baselines are located by title', () => {
  const edited = fixture().input;
  replaceCurrent(edited, 'chapter_1.lesson_1', content => ({ ...content, title: 'Edited lesson',
    data: { ...(content.data as Record<string, unknown>), learning_objectives: [] } }));
  assert.deepEqual(refusal(edited).reason, { category: 'CONTENT_EDIT_INVALID',
    location: { chapter: where.chapter, lesson: { number: 1, title: 'Edited lesson' }, unit: null, component: null } });

  const unfinished = fixture().input;
  unfinished.nodes.find(node => node.canonical_path === 'chapter_1.lesson_1.unit_1')!.content_state = 'generating';
  assert.deepEqual(refusal(unfinished), { code: 'WORKSPACE_APPLY_CONTEXT_INCOMPLETE',
    reason: { category: 'CONTENT_INCOMPLETE', location: { ...where, component: null } } });

  const rebased = fixture().input;
  const component = rebased.nodes.find(node => node.kind === 'component')!;
  const other = { ...(component.baseline!.content as Record<string, unknown>), data: '<p>Other baseline text for the check.</p>' };
  component.baseline = { content: other, content_hash: hash(other) };
  component.current = { content: other, content_hash: hash(other) };
  assert.deepEqual(refusal(rebased), { code: 'WORKSPACE_APPLY_BINDING_INVALID', reason: { category: 'CONTENT_CHANGED',
    location: { ...where, component: { number: 1, title: 'Explanation' } } } });
});

test('Apply reason: structural refusals carry no location; conflicts keep their own answer', () => {
  const inventory = fixture().input;
  inventory.inventory_hash = hash('other');
  assert.deepEqual(refusal(inventory), { code: 'WORKSPACE_APPLY_BINDING_INVALID', reason: { category: 'STRUCTURE_INVALID', location: null } });
  const scope = fixture().input;
  scope.request.scope_node_id = uuid(999);
  assert.deepEqual(refusal(scope), { code: 'WORKSPACE_APPLY_SCOPE_INVALID', reason: { category: 'STRUCTURE_INVALID', location: null } });
  const revision = fixture().input;
  revision.request.expected_revision_manifest = revision.request.expected_revision_manifest.map(entry => ({ ...entry, revision: 7 }));
  assert.deepEqual(refusal(revision), { code: 'WORKSPACE_APPLY_REVISION_CONFLICT', reason: null });
  const target = fixture().input;
  target.request.expected_target_snapshot_hash = hash('other-target');
  assert.deepEqual(refusal(target), { code: 'WORKSPACE_APPLY_TARGET_CHANGED', reason: null });
});

test('Apply reason messages are plain VI/EN sentences that say what to do next', () => {
  const chapter = { category: 'CHAPTER_NOT_COMPLETED' as const,
    location: { chapter: { number: 4, title: 'An toàn điện' }, lesson: null, unit: null, component: null } };
  assert.equal(workspaceApplyReasonMessage(chapter, 'vi'),
    "Chương 4 «An toàn điện» chưa hoàn tất bước kiểm tra cuối, nên chưa áp dụng được. Bạn có thể dùng 'Viết lại chương' hoặc tự soạn phần này trong khoá học.");
  assert.equal(workspaceApplyReasonMessage(chapter, 'en'),
    "Chapter 4 \"An toàn điện\" did not finish its final check, so it cannot be applied yet. You can use 'Rewrite chapter' or write this part yourself in the course.");
  const unit = { category: 'UNIT_FALLBACK_NOT_APPLICABLE' as const, location: { chapter: { number: 2, title: 'C' },
    lesson: { number: 1, title: 'S' }, unit: { number: 3, title: 'Đo điện trở' }, component: null } };
  assert.match(workspaceApplyReasonMessage(unit, 'vi'), /^Bài học «Đo điện trở» \(Chương 2\) chỉ có bản nháp chép từ tài liệu nguồn/);
  assert.match(workspaceApplyReasonMessage(unit, 'en'), /^Lesson "Đo điện trở" \(Chapter 2\) only has a draft copied from the source/);
  for (const category of WORKSPACE_APPLY_REASON_CATEGORIES) {
    for (const location of [null, unit.location]) {
      for (const locale of ['vi', 'en'] as const) {
        const message = workspaceApplyReasonMessage({ category, location }, locale);
        assert.ok(message.length > 20);
        assert.doesNotMatch(message, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\b(4\d\d|5\d\d)\b|undefined|null/);
        assert.doesNotMatch(message, /\b(AI ID|workspace|revision|hash|snapshot|receipt|artifact|chapter_\d)\b/i);
        if (locale === 'vi') assert.doesNotMatch(message, /\b(course|draft|apply|file|lesson|chapter)\b/i);
      }
    }
  }
});

test('Apply reason reader keeps only a well-formed category and location', () => {
  assert.equal(readWorkspaceApplyReason({ category: 'NOPE', location: null }), null);
  assert.equal(readWorkspaceApplyReason('CHAPTER_NOT_COMPLETED'), null);
  assert.deepEqual(readWorkspaceApplyReason({ category: 'STRUCTURE_INVALID' }), { category: 'STRUCTURE_INVALID', location: null });
  assert.equal(readWorkspaceApplyReason({ category: 'CONTENT_CHANGED', location: { chapter: { number: 0, title: 'x' },
    lesson: null, unit: null, component: null } }), null);
  assert.equal(readWorkspaceApplyReason({ category: 'CONTENT_CHANGED', location: { chapter: { number: 1, title: 'x' } } }), null);
  const long = workspaceApplyLocation('chapter_1', [{ canonical_path: 'chapter_1', baseline: null,
    current: { content: { title: `  ${'T'.repeat(500)}\n` }, content_hash: hash('x') } }])!;
  assert.equal(long.chapter!.title!.length, 200);
  assert.deepEqual(readWorkspaceApplyReason({ category: 'CONTENT_CHANGED', location: long })?.location, long);
  // V1 validator findings append a JSON path after the node path.
  assert.deepEqual(workspaceApplyLocation('chapter_2.lesson_1.unit_3.component_1.data[0]', []),
    { chapter: { number: 2, title: null }, lesson: { number: 1, title: null }, unit: { number: 3, title: null },
      component: { number: 1, title: null } });
  assert.equal(workspaceApplyLocation('chapter-2', []), null);
});

test('Apply HTTP answer adds the refused compile reason and its message, never on a conflict', async () => {
  const { createWorkspaceApplyHandler, WORKSPACE_APPLY_ERRORS } = await import('./lesson-author-workspace-apply.controller.js');
  const { WorkspaceApplyError } = await import('./lesson-author-workspace-apply.repository.js');
  const reason = { category: 'UNIT_NOT_GENERATED' as const, location: { chapter: { number: 3, title: 'Đo lường' },
    lesson: { number: 1, title: 'Cơ bản' }, unit: { number: 2, title: 'Đồng hồ vạn năng' }, component: null } };
  const events: Array<Record<string, unknown>> = [];
  let failure: unknown = new WorkspaceApplyError('WORKSPACE_APPLY_VALIDATION_FAILED', reason);
  const handler = createWorkspaceApplyHandler({ enabled: () => true, report: event => { events.push(event); },
    apply: async () => { throw failure; } });
  const call = async (locale: 'vi' | 'en') => {
    const res = { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; }, setHeader() { /* headers are not asserted here */ } };
    await handler({ user: { id: uuid(70), role: 'staff', tenantId: uuid(71), username: 'editor', sessionMode: 'normal' },
      params: { courseId: 'course-v1:N+1+2026', conversationId: uuid(72), workspaceId: uuid(73), nodeId: uuid(74) },
      query: { ui_locale: locale }, body: { operation_id: uuid(75), expected_workspace_revision: 4 } } as never, res as never);
    return res as { statusCode: number; body: Record<string, unknown> };
  };
  const vi = await call('vi');
  assert.equal(vi.statusCode, 422);
  assert.equal(vi.body.code, 'WORKSPACE_APPLY_VALIDATION_FAILED', 'the compatibility code is unchanged');
  assert.equal(vi.body.message, WORKSPACE_APPLY_ERRORS.WORKSPACE_APPLY_VALIDATION_FAILED[1]);
  assert.deepEqual(vi.body.reason, { ...reason, message:
    "Bài học «Đồng hồ vạn năng» (Chương 3) chưa được AI soạn xong, nên chưa áp dụng được. Bạn có thể dùng 'Viết lại chương' hoặc tự soạn phần này trong khoá học." });
  assert.equal(events.at(-1)!.reason_category, 'UNIT_NOT_GENERATED');
  assert.equal(JSON.stringify(events).includes('Đồng hồ'), false, 'titles never reach telemetry');
  const en = await call('en');
  assert.match(String((en.body.reason as { message: string }).message), /^Lesson "Đồng hồ vạn năng" \(Chapter 3\) was not finished by the AI/);

  failure = new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY', { category: 'STRUCTURE_INVALID', location: null });
  const notReady = await call('vi');
  assert.equal(notReady.statusCode, 409);
  assert.equal((notReady.body.reason as { category: string }).category, 'STRUCTURE_INVALID');

  failure = Object.assign(new WorkspaceApplyError('WORKSPACE_APPLY_REVISION_CONFLICT'), { reason });
  const conflict = await call('vi');
  assert.equal(conflict.body.code, 'WORKSPACE_APPLY_CONFLICT');
  assert.equal('reason' in conflict.body, false, 'a conflict keeps its own answer');
  failure = Object.assign(new Error('x'), { code: 'WORKSPACE_APPLY_VALIDATION_FAILED', reason: { category: 'EVIL', location: null } });
  assert.equal('reason' in (await call('vi')).body, false, 'an unknown reason is dropped');
});

test('production Apply repository attaches the reason only to a compile refusal, with the nodes it compiled', () => {
  const source = readFileSync(new URL('./lesson-author-workspace-apply.repository.ts', import.meta.url), 'utf8');
  assert.match(source, /compiledNodes = nodes;\s+const compiled = isV1/);
  assert.match(source, /failureStage === 'compile' \? workspaceApplyReasonFromCompileError\(error, compiledNodes\) : null/);
  assert.match(source, /'WORKSPACE_APPLY_NOT_READY', reason\);/);
});
