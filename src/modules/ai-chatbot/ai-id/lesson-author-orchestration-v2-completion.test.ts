import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import {
  validateOrchestrationV2Chapter,
  type OrchestrationV2ChapterReceipt,
} from './lesson-author-orchestration-v2-chapter.logic.js';
import { createOrchestrationV2ChapterRepository } from './lesson-author-orchestration-v2-chapter.repository.js';
import { runOrchestrationV2ChapterValidation } from './lesson-author-orchestration-v2-chapter.service.js';
import { finalizeOrchestrationV2Course, type OrchestrationV2FinalizationTask } from './lesson-author-orchestration-v2-finalization.logic.js';
import { createOrchestrationV2FinalizationRepository } from './lesson-author-orchestration-v2-finalization.repository.js';
import { runOrchestrationV2Finalization } from './lesson-author-orchestration-v2-finalization.service.js';
import { orchestrationV2DeterministicUuid } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash, sealOrchestrationV2PersistedManifest } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const hash = (value: unknown) => orchestrationV2Hash(value);

function chapterFixture(qualityEnvelope?: { content_origin: string; quality_state: string }) {
  const runId = id(1), snapshotHash = hash('snapshot'), assemblyBase = {
    contract_version: 2 as const, source_snapshot_hash: snapshotHash, skeleton_hash: hash('skeleton'),
    shard_hashes: [hash('shard')], admitted_fact_count: 2, allocated_fact_count: 2,
    duplicate_scope_count: 0 as const, unresolved_scope_count: 0 as const,
    chapter_count: 1, lesson_count: 1, unit_count: 1, component_plan_count: 1,
    architecture: { locale: 'vi' as const, title: 'Course', summary: 'Summary', target_audience: 'Leaders',
      prerequisites: [], learning_outcomes: ['Outcome'], assessment_strategy: 'Assessment', assumptions: [],
      chapters: [{ chapter_key: 'chapter-1', order: 1, title: 'Chapter', objective: 'Objective',
        source_scope_ids: ['scope-1'], lessons: [{ title: 'Lesson', objective: 'Lesson objective',
          learning_objectives: ['Objective'], learning_activities: ['Activity'], assessment: 'Assessment',
          units: [{ title: 'Unit', purpose: 'Explain', learning_objective_refs: ['lo_1'],
            source_scope_ids: ['scope-1'], media_brief: null,
            component_plan: [{ type: 'html' as const, title: 'Theory', rationale: 'Teach',
              source_scope_ids: ['scope-1'] }] }] }] }] },
  };
  const assembly = { ...assemblyBase, assembly_hash: hash(assemblyBase) } as OrchestrationV2ArchitectureAssembly;
  const unitPath = 'chapter_1.lesson_1.unit_1';
  const unitContent = { title: 'Unit', purpose: 'Explain', data: {}, implementation_notes: null };
  const componentContent = { title: 'Theory', purpose: 'explain', data: { html: '<p>Content</p>' },
    implementation_notes: null };
  const nodes = [{ path: unitPath, content: unitContent, content_hash: hash(unitContent) },
    { path: `${unitPath}.component_1`, content: componentContent, content_hash: hash(componentContent) }];
  const generatedUnit = { title: 'Unit', source_fact_ids: ['fact-1', 'fact-2'], components: [{}] };
  const artifactBase = { validation_contract: 'orchestration-unit-baseline-v2', unit_path: unitPath,
    source_snapshot_hash: snapshotHash, contract_hash: hash('unit-contract'), nodes, generated_unit: generatedUnit,
    ...(qualityEnvelope ?? {}) };
  const taskId = id(2), artifactHash = hash(artifactBase);
  const sourceFacts = [{ document_id: id(9), fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'One',
    fact_hash: hash('One'), source_ref: null, source_page: null, source_chunk: null, locator: {} },
  { document_id: id(9), fact_key: 'fact-2', scope_key: 'scope-1', fact_text: 'Two',
    fact_hash: hash('Two'), source_ref: null, source_page: null, source_chunk: null, locator: {} }];
  const receipt = validateOrchestrationV2Chapter({ run_id: runId, assembly, inventory_hash: hash('inventory'),
    chapter_key: 'chapter-1', chapter_node_id: orchestrationV2DeterministicUuid(runId, 'node:chapter_1'),
    source_facts: sourceFacts, units: [{ task_id: taskId, task_key: 'content:chapter-1:unit:1',
      node_id: orchestrationV2DeterministicUuid(runId, `node:${unitPath}`), artifact_hash: artifactHash,
      payload: { contract_version: 2, unit_path: unitPath, source_snapshot_hash: snapshotHash,
        contract_hash: artifactBase.contract_hash, nodes, generated_unit: generatedUnit,
        ...(qualityEnvelope ?? {}) } }],
    baselines: nodes.map((node, index) => ({ canonical_path: node.path,
      kind: index === 0 ? 'unit' as const : 'component' as const, content_hash: node.content_hash,
      revision: 0, operation_id: taskId })) });
  return { runId, assembly, receipt, sourceFacts, nodes, taskId, artifactHash };
}

test('chapter validation seals exact unit artifacts, fact allocation and revision-zero baselines', () => {
  const { receipt } = chapterFixture();
  assert.equal(receipt.admitted_fact_count, 2);
  assert.equal(receipt.allocated_fact_count, 2);
  assert.equal(receipt.covered_fact_count, 2);
  assert.equal(receipt.unit_count, 1);
  assert.equal(receipt.component_count, 1);
  assert.equal(receipt.receipt_hash, hash((({ receipt_hash: _receipt, ...base }) => base)(receipt)));
});

test('chapter validation rejects incomplete baseline evidence', () => {
  const fixture = chapterFixture();
  assert.throws(() => validateOrchestrationV2Chapter({ run_id: fixture.runId, assembly: fixture.assembly,
    inventory_hash: hash('inventory'), chapter_key: 'chapter-1',
    chapter_node_id: fixture.receipt.chapter_node_id, source_facts: fixture.sourceFacts,
    units: [{ task_id: fixture.taskId, task_key: 'content:chapter-1:unit:1',
      node_id: orchestrationV2DeterministicUuid(fixture.runId, 'node:chapter_1.lesson_1.unit_1'),
      artifact_hash: fixture.artifactHash, payload: {} }], baselines: [] }), /ORCHESTRATION_V2_CHAPTER/);
});

test('chapter validation uses the shared quality-state compatibility matrix', () => {
  for (const quality of [
    { content_origin: 'provider_validated', quality_state: 'validated' },
    { content_origin: 'provider_validated', quality_state: 'review_required' },
    { content_origin: 'structured_fallback', quality_state: 'validated' },
    { content_origin: 'structured_fallback', quality_state: 'review_required' },
    { content_origin: 'raw_source_fallback', quality_state: 'review_required' },
  ]) assert.doesNotThrow(() => chapterFixture(quality), JSON.stringify(quality));

  for (const quality of [
    { content_origin: 'raw_source_fallback', quality_state: 'validated' },
    { content_origin: 'structured_fallback', quality_state: 'unknown' },
  ]) assert.throws(() => chapterFixture(quality), { code: 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID' });
});

function finalizationFixture(receipt: OrchestrationV2ChapterReceipt) {
  const provider = { input_tokens: 10, embedding_tokens: 0, max_output_tokens: 10,
    max_provider_attempts: 1, execution_budget_ms: 1000 };
  const deterministic = { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
    max_provider_attempts: 0, execution_budget_ms: 1000 };
  const definitions = [
    ['source:snapshot', 'source_snapshot', null, null, []],
    ['architecture:course', 'course_skeleton', null, null, ['source:snapshot']],
    ['architecture:chapter:chapter-1', 'chapter_blueprint', 'chapter-1', receipt.chapter_node_id, ['architecture:course']],
    ['architecture:validate', 'validate_architecture', null, null, ['architecture:chapter:chapter-1']],
    ['inventory:publish', 'publish_inventory', null, null, ['architecture:validate']],
    ['content:chapter-1:unit:1', 'generate_unit', 'chapter-1', id(20), ['inventory:publish']],
    ['content:chapter-1:validate', 'validate_chapter', 'chapter-1', receipt.chapter_node_id,
      ['content:chapter-1:unit:1']],
    ['course:finalize', 'finalize_course', null, null, ['content:chapter-1:validate']],
  ] as const;
  const tasks: OrchestrationV2FinalizationTask[] = definitions.map((item, ordinal) => ({ ordinal,
    task_key: item[0], kind: item[1], chapter_key: item[2], node_id: item[3],
    contract_hash: hash(`contract-${ordinal}`), input_context_hash: hash(`input-${ordinal}`),
    priority: ordinal * 10, max_attempts: 2, depends_on: [...item[4]],
    budget: ['course_skeleton', 'chapter_blueprint', 'generate_unit'].includes(item[1]) ? provider : deterministic,
    status: item[1] === 'finalize_course' ? 'running' : 'succeeded',
    result_hash: item[1] === 'finalize_course' ? null
      : item[1] === 'validate_chapter' ? receipt.receipt_hash : hash(`result-${ordinal}`),
    validation_contract: item[1] === 'finalize_course' ? null
      : item[1] === 'validate_chapter' ? receipt.contract : 'test-contract',
  }));
  const manifestTasks = tasks.map(({ status: _status, result_hash: _result,
    validation_contract: _contract, ...task }) => task);
  const manifest = sealOrchestrationV2PersistedManifest({ source_snapshot_hash: receipt.source_snapshot_hash,
    tasks: manifestTasks });
  return { tasks, manifest, manifestTasks };
}

test('persisted manifest ignores runtime-only database row fields', () => {
  const { receipt } = chapterFixture(), { manifest, manifestTasks } = finalizationFixture(receipt);
  const runtimeRows = manifestTasks.map((task, index) => ({
    ...task,
    id: id(100 + index),
    status: index === manifestTasks.length - 1 ? 'running' : 'succeeded',
    lease_token: id(200 + index),
  }));
  const sealed = sealOrchestrationV2PersistedManifest({
    source_snapshot_hash: receipt.source_snapshot_hash,
    tasks: runtimeRows,
  });
  assert.equal(sealed.manifest_hash, manifest.manifest_hash);
  assert.deepEqual(sealed.tasks, manifest.tasks);
  assert.ok(sealed.tasks.every(task => !Object.prototype.hasOwnProperty.call(task, 'id')));
});

test('course finalization requires every task and exact chapter/all-fact receipts', () => {
  const { receipt } = chapterFixture(), { tasks, manifest } = finalizationFixture(receipt);
  const result = finalizeOrchestrationV2Course({ source_snapshot_hash: receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2,
    assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [receipt] });
  assert.equal(result.completion.task_count, 8);
  assert.equal(result.completion.chapter_receipt_count, 1);
  assert.deepEqual(result.completion.checks, { tasks: 'PASS', allocation: 'PASS', coverage: 'PASS',
    duplicates: 'PASS', chapters: 'PASS' });
  assert.equal(result.course_artifact_hash,
    hash({ contract: result.contract, completion: result.completion,
      chapter_receipt_hashes: result.chapter_receipt_hashes }));
});

test('course finalization preserves fact-complete draft but requires review while assessment obligation is open', () => {
  const { receipt } = chapterFixture(), { tasks, manifest } = finalizationFixture(receipt);
  const result = finalizeOrchestrationV2Course({ source_snapshot_hash: receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2,
    assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [receipt], assessment_obligations: [{ planned_slot_key: `ao2_${'a'.repeat(32)}`,
      plan_revision_hash: receipt.assembly_hash, status: 'open', resolution_kind: null,
      resolution_evidence_hash: null }] });
  assert.equal(result.contract, 'orchestration-course-review-required-v1');
  if (result.contract !== 'orchestration-course-review-required-v1') assert.fail('review outcome expected');
  assert.equal(result.review.open_assessment_obligation_count, 1);
  assert.deepEqual(result.review.checks, { tasks: 'PASS', allocation: 'PASS', coverage: 'PASS',
    duplicates: 'PASS', chapters: 'PASS', assessments: 'REVIEW_REQUIRED' });
});

test('a resolved assessment obligation no longer blocks the ready completion contract', () => {
  const { receipt } = chapterFixture(), { tasks, manifest } = finalizationFixture(receipt);
  const result = finalizeOrchestrationV2Course({ source_snapshot_hash: receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2,
    assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [receipt], assessment_obligations: [{ planned_slot_key: `ao2_${'b'.repeat(32)}`,
      plan_revision_hash: receipt.assembly_hash, status: 'resolved', resolution_kind: 'valid_assessment',
      resolution_evidence_hash: hash('assessment-resolution') }] });
  assert.equal(result.contract, 'orchestration-course-finalization-v2');
});

test('course finalization refuses a missing or unverified chapter receipt', () => {
  const { receipt } = chapterFixture(), { tasks, manifest } = finalizationFixture(receipt);
  assert.throws(() => finalizeOrchestrationV2Course({ source_snapshot_hash: receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2,
    assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [] }), /ORCHESTRATION_V2_FINALIZATION_INCOMPLETE/);
});

function lease(kind: 'validate_chapter' | 'finalize_course'): OrchestrationV2TaskLease {
  return { task_id: id(30), run_id: id(1), workspace_id: id(31), tenant_id: id(32),
    course_id: 'course-v1:test+1+2026', task_key: kind === 'validate_chapter'
      ? 'content:chapter-1:validate' : 'course:finalize', kind,
    chapter_key: kind === 'validate_chapter' ? 'chapter-1' : null,
    node_id: kind === 'validate_chapter' ? orchestrationV2DeterministicUuid(id(1), 'node:chapter_1') : null,
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: id(33),
    source_snapshot_hash: hash('snapshot'), runtime_config_hash: hash('runtime'), model: 'model', locale: 'vi', max_output_tokens: 0,
    provider_max_attempts: 0, execution_budget_ms: 1000, lease_token: id(34), dispatch_epoch: 1,
    provider_replay_required: false,
    routing_shard: 2, ai_reservation_id: null };
}

test('deterministic services load then atomically complete exactly once', async () => {
  const chapterLease = lease('validate_chapter'), finalLease = lease('finalize_course');
  const chapterReceipt = chapterFixture().receipt;
  const finalization = { contract: 'orchestration-course-finalization-v2' as const,
    completion: {} as never, chapter_receipt_hashes: [], course_artifact_hash: hash('course') };
  const calls: string[] = [];
  await runOrchestrationV2ChapterValidation(chapterLease, {
    load: async () => { calls.push('chapter:load'); return chapterReceipt; },
    complete: async () => { calls.push('chapter:complete'); },
  });
  await runOrchestrationV2Finalization(finalLease, {
    load: async () => { calls.push('course:load'); return finalization; },
    complete: async () => { calls.push('course:complete'); },
  });
  assert.deepEqual(calls, ['chapter:load', 'chapter:complete', 'course:load', 'course:complete']);
});

test('chapter completion publishes receipt before releasing the finalizer', async () => {
  const chapterLease = lease('validate_chapter'), receipt = { ...chapterFixture().receipt,
    source_snapshot_hash: chapterLease.source_snapshot_hash, chapter_node_id: chapterLease.node_id! };
  const queries: string[] = [];
  const tx = { async query<T extends Record<string, unknown>>(sql: string) {
    queries.push(sql);
    const rows = sql.includes("candidate.kind='finalize_course'") ? [{ id: id(40) }]
      : sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox') ? [{ id: id(41) }] : [];
    return { rows: rows as unknown as T[], rowCount: rows.length };
  } } as GenerationJobSql;
  const db = { transaction: async <T>(work: (value: GenerationJobSql) => Promise<T>) => work(tx) } as GenerationJobDatabase;
  let artifact = '';
  const worker = { succeed: async (...args: unknown[]) => {
    artifact = String((args[4] as { artifact_kind: string }).artifact_kind);
    await (args[6] as { afterSuccess(tx: GenerationJobSql): Promise<void> }).afterSuccess(tx);
  } };
  await createOrchestrationV2ChapterRepository(db, worker as never, () => id(41)).complete(chapterLease, receipt);
  assert.equal(artifact, 'chapter_receipt');
  assert.ok(queries[0]!.includes("candidate.kind='finalize_course'"));
  assert.ok(queries[1]!.includes('lesson_author_workspace_v2_dispatch_outbox'));
});

test('course completion composes task success, receipt, event and ready transitions in one transaction', async () => {
  const finalLease = lease('finalize_course'), receipt = chapterFixture().receipt;
  const { tasks, manifest } = finalizationFixture(receipt);
  const finalization = finalizeOrchestrationV2Course({ source_snapshot_hash: receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2,
    assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [receipt] });
  const queries: string[] = [];
  const tx = { async query<T extends Record<string, unknown>>(sql: string) {
    queries.push(sql); return { rows: [{ id: id(50), sequence: 1 }] as unknown as T[], rowCount: 1 };
  } } as GenerationJobSql;
  const db = { transaction: async <T>(work: (value: GenerationJobSql) => Promise<T>) => work(tx) } as GenerationJobDatabase;
  let artifact = '';
  const worker = { succeed: async (...args: unknown[]) => {
    artifact = String((args[4] as { artifact_kind: string }).artifact_kind);
    const hooks = args[6] as { beforeSuccess(tx: GenerationJobSql): Promise<void>;
      afterSuccess(tx: GenerationJobSql): Promise<void> };
    await hooks.beforeSuccess(tx); await hooks.afterSuccess(tx);
  } };
  await createOrchestrationV2FinalizationRepository(db, worker as never, () => id(50))
    .complete(finalLease, finalization);
  assert.equal(artifact, 'course_receipt');
  assert.ok(queries[0]!.includes("status='finalizing'"));
  assert.ok(queries[1]!.includes('lesson_author_workspace_v2_completion_receipts'));
  assert.ok(queries[2]!.includes("'run_ready'"));
  assert.ok(queries[3]!.includes("status='ready'"));
  assert.ok(queries[4]!.includes("lesson_author_workspaces SET status='ready'"));
});

test('review-required completion commits a durable receipt and needs-action states without claiming ready', async () => {
  const finalLease = lease('finalize_course'), receipt = chapterFixture().receipt;
  const { tasks, manifest } = finalizationFixture(receipt);
  const finalization = finalizeOrchestrationV2Course({ source_snapshot_hash: receipt.source_snapshot_hash,
    expected_manifest_hash: manifest.manifest_hash, admitted_fact_count: 2,
    assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [receipt], assessment_obligations: [{ planned_slot_key: `ao2_${'c'.repeat(32)}`,
      plan_revision_hash: receipt.assembly_hash, status: 'open', resolution_kind: null,
      resolution_evidence_hash: null }] });
  assert.equal(finalization.contract, 'orchestration-course-review-required-v1');
  const queries: string[] = [];
  const tx = { async query<T extends Record<string, unknown>>(sql: string) {
    queries.push(sql); return { rows: [{ id: id(60), sequence: 1 }] as unknown as T[], rowCount: 1 };
  } } as GenerationJobSql;
  const db = { transaction: async <T>(work: (value: GenerationJobSql) => Promise<T>) => work(tx) } as GenerationJobDatabase;
  let contract = '';
  const worker = { succeed: async (...args: unknown[]) => {
    contract = String(args[2]);
    const hooks = args[6] as { beforeSuccess(tx: GenerationJobSql): Promise<void>;
      afterSuccess(tx: GenerationJobSql): Promise<void> };
    await hooks.beforeSuccess(tx); await hooks.afterSuccess(tx);
  } };
  await createOrchestrationV2FinalizationRepository(db, worker as never, () => id(60))
    .complete(finalLease, finalization);
  assert.equal(contract, 'orchestration-course-review-required-v1');
  assert.ok(queries.some(sql => sql.includes('lesson_author_workspace_v2_review_receipts')));
  assert.ok(queries.some(sql => sql.includes("'run_needs_action'")));
  assert.ok(queries.some(sql => sql.includes("status='needs_action'")));
  assert.ok(!queries.some(sql => sql.includes("'run_ready'")));
});
