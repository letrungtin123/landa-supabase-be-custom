import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  acceptOrchestrationV2GeneratedUnit,
  prepareOrchestrationV2UnitGenerationContract,
  readOrchestrationV2UnitProviderResponse,
  type OrchestrationV2UnitComponentPlan,
} from './lesson-author-orchestration-v2-unit.logic.js';
import { executeOrchestrationV2UnitTask } from './lesson-author-orchestration-v2-unit.service.js';
import { createOrchestrationV2UnitRepository } from './lesson-author-orchestration-v2-unit.repository.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

const hash = (value: string) => orchestrationV2Hash(value);

function fixture() {
  const source = hash('unit-source');
  const skeleton = { contract_version: 2 as const, source_snapshot_hash: source, locale: 'vi' as const,
    title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
    learning_outcomes: ['Apply'], assessment_strategy: 'Practice', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn', source_scope_ids: ['scope-1'],
    }] };
  const shard = { contract_version: 2 as const, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
    shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn', lessons: [{
      title: 'Lesson', objective: 'Learn', learning_objectives: ['Apply safely'], learning_activities: ['Read'],
      assessment: 'Check', units: [{ title: 'Unit', purpose: 'Teach safely', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [{ type: 'html' as const, title: 'Explanation',
          rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: null }] }] };
  const assembly = assembleOrchestrationV2Architecture(skeleton,
    [{ scope_key: 'scope-1', title: 'Scope', source_ref: 'doc.pdf', fact_count: 2, content_chars: 60 }],
    [{ artifact_hash: hash('unit-shard'), shard }]);
  const sourceFacts: OrchestrationV2SourceFact[] = [
    { document_id: '00000000-0000-4000-8000-000000000011', fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Read the procedure first.',
      source_ref: 'doc.pdf', source_page: 1, source_chunk: 0, locator: {} },
    { document_id: '00000000-0000-4000-8000-000000000011', fact_key: 'fact-2', scope_key: 'scope-1', fact_text: 'Verify each safety control.',
      source_ref: 'doc.pdf', source_page: 1, source_chunk: 0, locator: {} },
  ];
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts });
  const plan = contract.component_plan[0]!;
  const responseWire = { contract_version: 2, source_snapshot_hash: source,
    unit_path: contract.unit_path, unit: { title: contract.unit_title,
      source_fact_ids: [...contract.unit_source_fact_ids], components: [{ type: 'html', title: 'Explanation',
        data: '<p>Read the complete procedure first, then verify every safety control before starting work.</p>',
        component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
        covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [],
        metadata: { component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
          covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [],
          learning_objective_refs: [...plan.learning_objective_refs] } }] },
    usage_complete: true as const, usage_source: 'provider' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  return { assembly, sourceFacts, contract, responseWire };
}

test('unit contract is deterministic, bounded and uses provider-compatible stable component IDs', () => {
  const { assembly, sourceFacts, contract } = fixture();
  const again = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: structuredClone(sourceFacts) });
  assert.deepEqual(contract, again);
  assert.match(contract.component_plan[0]!.component_plan_id, /^cp2_[a-f0-9]{32}$/);
  assert.deepEqual(contract.component_plan[0]!.source_fact_ids, ['fact-1', 'fact-2']);
  const { contract_hash: contractHash, ...base } = contract;
  assert.equal(contractHash, orchestrationV2Hash(base));
});

test('unit contract rejects facts outside its exact source scope', () => {
  const { assembly, sourceFacts } = fixture();
  sourceFacts[0]!.scope_key = 'scope-outside';
  assert.throws(() => prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts }),
  { code: 'ORCHESTRATION_V2_UNIT_CONTRACT_INVALID' });
});

test('provider response rejects provenance drift before normalization', () => {
  const { contract, responseWire } = fixture();
  const changed = structuredClone(responseWire);
  changed.unit.components[0]!.covered_source_fact_ids = ['fact-1'];
  assert.throws(() => readOrchestrationV2UnitProviderResponse(changed, contract),
    { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider response cannot publish when exact usage accounting is unavailable', () => {
  const { contract, responseWire } = fixture();
  const incomplete = { ...responseWire, usage_complete: false, usage_source: 'mixed_or_unavailable' };
  assert.throws(() => readOrchestrationV2UnitProviderResponse(incomplete, contract),
    { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider response accepts only the two server-owned fallback accounting contracts', () => {
  const { contract, responseWire } = fixture();
  const reserved = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: false, usage_source: 'reserved_upper_bound', usage: {} }, contract);
  assert.equal(reserved.usage_source, 'reserved_upper_bound');
  const deterministic = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: true, usage_source: 'deterministic_fallback', usage: {} }, contract);
  assert.equal(deterministic.usage_source, 'deterministic_fallback');
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: true, usage_source: 'reserved_upper_bound' }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: false, usage_source: 'deterministic_fallback' }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('accepted response becomes exact revision-zero unit and component baselines', () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const allowed = new Set<CourseComponentType>(['html']);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response, normalizeProposal, allowed });
  assert.equal(publication.nodes.length, 2);
  assert.deepEqual(publication.nodes.map(node => node.path),
    ['chapter_1.lesson_1.unit_1', 'chapter_1.lesson_1.unit_1.component_1']);
  assert.equal(publication.validation_contract, 'orchestration-unit-baseline-v2');
  assert.match(publication.result_hash, /^[a-f0-9]{64}$/);
});

test('Python deterministic fallback for every component type passes the production Node normalizer', async t => {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorProposal } = await import('./chat.service.js');
  const root = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const base = fixture().contract;
  const variants: OrchestrationV2UnitComponentPlan['type'][][] = [
    ['html', 'problem', 'la_faq', 'la_diagram'], ['html', 'la_sortable', 'la_crossword'],
  ];
  for (const types of variants) {
    const componentPlan = types.map((type, index) => ({ ...base.component_plan[0]!, type,
      component_plan_id: `cp2_${String(index + 1).padStart(32, '0')}`,
      title: `${type} fallback`, purpose: type === 'problem' ? 'assess' as const
        : type === 'la_sortable' ? 'sequence' as const : type === 'la_diagram' ? 'relationship' as const
          : type === 'la_crossword' ? 'terminology' as const : type === 'la_faq' ? 'clarify' as const : 'explain' as const }));
    const contractBase = { ...base, component_plan: componentPlan };
    const { contract_hash: _oldHash, ...withoutHash } = contractBase;
    const contract = { ...withoutHash, contract_hash: orchestrationV2Hash(withoutHash) };
    const out = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.orchestration_v2_unit_fallback_bridge'], {
      cwd: root, input: JSON.stringify({ contract, locale: 'vi' }), encoding: 'utf8', timeout: 20_000,
      maxBuffer: 4_000_000,
    });
    assert.equal(out.status, 0, out.error?.message ?? out.stderr);
    const fallbackUnit = JSON.parse(out.stdout);
    const response = readOrchestrationV2UnitProviderResponse({ contract_version: 2,
      source_snapshot_hash: contract.source_snapshot_hash, unit_path: contract.unit_path,
      unit: fallbackUnit, usage_complete: true, usage_source: 'deterministic_fallback', usage: {} }, contract);
    const normalized = normalizeLessonAuthorProposal({ chapters: [{ title: contract.chapter_title,
      lessons: [{ title: contract.lesson_title, units: [fallbackUnit] }] }] });
    assert.deepEqual(new Set(normalized.chapters[0]?.lessons[0]?.units[0]?.components
      ?.map(component => component.metadata?.component_plan_id)),
    new Set(componentPlan.map(plan => plan.component_plan_id)),
    `fallback normalization lost an instance for ${types.join(',')}`);
    const publication = acceptOrchestrationV2GeneratedUnit({ contract, response,
      normalizeProposal: normalizeLessonAuthorProposal, allowed: new Set<CourseComponentType>(types) });
    assert.deepEqual(publication.generated_unit.components.map(component => component.type), types);
  }
});

test('unit service persists dispatch before exactly one provider call and one completion', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000001', run_id: '00000000-0000-4000-8000-000000000002',
    workspace_id: '00000000-0000-4000-8000-000000000003', tenant_id: '00000000-0000-4000-8000-000000000004',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000005',
    contract_hash: hash('task-contract'), input_context_hash: hash('task-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000006', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000007', dispatch_epoch: 1,
    routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const events: string[] = [];
  const repository = { load: async () => { events.push('load'); return { authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000008', conversation_id: '00000000-0000-4000-8000-000000000009',
    correlation_id: '00000000-0000-4000-8000-000000000010', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000011',
      kb_id: '00000000-0000-4000-8000-000000000008', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }; }, complete: async (_lease: unknown, publication: { nodes: unknown[] }) => {
      events.push(`complete:${publication.nodes.length}`);
    } };
  const worker = { markProviderDispatched: async () => { events.push('dispatch'); } };
  const client = { generate: async () => { events.push('provider'); return response; } };
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const settleProvider = async () => undefined;
  const releaseUndispatched = async () => undefined;
  assert.equal(await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']) }, normalizeProposal,
    settleProvider as never, releaseUndispatched as never, new AbortController().signal), 'generate_unit');
  assert.deepEqual(events, ['load', 'dispatch', 'provider', 'complete:2']);
});

test('unit service retries a rolled-back completion transaction without calling the provider again', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000201', run_id: '00000000-0000-4000-8000-000000000202',
    workspace_id: '00000000-0000-4000-8000-000000000203', tenant_id: '00000000-0000-4000-8000-000000000204',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000205',
    contract_hash: hash('retry-task-contract'), input_context_hash: hash('retry-task-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000206', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000207', dispatch_epoch: 1,
    routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  let providerCalls = 0;
  let completionAttempts = 0;
  const repository = { load: async () => ({ authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000208', conversation_id: '00000000-0000-4000-8000-000000000209',
    correlation_id: '00000000-0000-4000-8000-000000000210', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000211',
      kb_id: '00000000-0000-4000-8000-000000000208', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }), complete: async () => {
      completionAttempts += 1;
      if (completionAttempts === 1) throw Object.assign(new Error('safe test deadlock'), { code: '40P01' });
    } };
  const worker = { markProviderDispatched: async () => undefined };
  const client = { generate: async () => { providerCalls += 1; return response; } };
  await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']) },
    (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    (async () => undefined) as never, (async () => undefined) as never, new AbortController().signal);
  assert.equal(providerCalls, 1);
  assert.equal(completionAttempts, 2);
});

test('unit durable retry is fallback-only and never dispatches a second paid provider call', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: true, usage_source: 'deterministic_fallback', usage: {} }, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000101', run_id: '00000000-0000-4000-8000-000000000102',
    workspace_id: '00000000-0000-4000-8000-000000000103', tenant_id: '00000000-0000-4000-8000-000000000104',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000105',
    contract_hash: hash('retry-contract'), input_context_hash: hash('retry-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000106', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000107', dispatch_epoch: 2,
    routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const events: string[] = [];
  const repository = { load: async () => ({ authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000108', conversation_id: '00000000-0000-4000-8000-000000000109',
    correlation_id: '00000000-0000-4000-8000-000000000110', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000111',
      kb_id: '00000000-0000-4000-8000-000000000108', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }), complete: async (...args: unknown[]) => {
      events.push(`complete:${String(args[5])}`);
    } };
  const worker = { markProviderDispatched: async () => { events.push('dispatch'); } };
  const client = { generate: async (request: { fallback_only: boolean }) => {
    events.push(`generate:${String(request.fallback_only)}`); return response;
  } };
  await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client as never,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']) },
    (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    (async () => undefined) as never, (async () => undefined) as never, new AbortController().signal);
  assert.deepEqual(events, ['generate:true', 'complete:deterministic_fallback']);
});

test('unit service fails closed before load/provider when runtime is invalid', async () => {
  let called = false;
  await assert.rejects(() => executeOrchestrationV2UnitTask({} as OrchestrationV2TaskLease,
    { load: async () => { called = true; throw new Error('must not load'); } } as never,
    {} as never, { generate: async () => { called = true; throw new Error('must not call'); } },
    { embedding_model: '', embedding_dimensions: 0, allowed_component_types: new Set() },
    (() => ({ summary: '', chapters: [] })) as never, (async () => undefined) as never,
    (async () => undefined) as never,
    new AbortController().signal), { code: 'ORCHESTRATION_V2_UNIT_RUNTIME_INVALID' });
  assert.equal(called, false);
});

test('unit completion writes all revision-zero baselines and only then unlocks chapter validation', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response,
    normalizeProposal: (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    allowed: new Set<CourseComponentType>(['html']) });
  const lease = { task_id: '00000000-0000-4000-8000-000000000021', run_id: '00000000-0000-4000-8000-000000000022',
    workspace_id: '00000000-0000-4000-8000-000000000023', tenant_id: '00000000-0000-4000-8000-000000000024',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000025',
    contract_hash: hash('task-contract'), input_context_hash: hash('task-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000026', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000027', dispatch_epoch: 1,
    routing_shard: 3, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const componentId = '00000000-0000-4000-8000-000000000028';
  const queries: string[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string) {
    queries.push(sql);
    let rows: Array<Record<string, unknown>> = [];
    if (sql.includes('FROM lesson_author_workspace_nodes WHERE')) rows = [
      { id: lease.node_id, canonical_path: publication.nodes[0]!.path, kind: 'unit', content_state: 'planned', current_revision: null },
      { id: componentId, canonical_path: publication.nodes[1]!.path, kind: 'component', content_state: 'planned', current_revision: null },
    ];
    else if (sql.includes('INSERT INTO lesson_author_workspace_revisions')) rows = [
      { node_id: lease.node_id, revision: 0 }, { node_id: componentId, revision: 0 },
    ];
    else if (sql.includes('INSERT INTO lesson_author_workspace_events')) rows = [{ sequence: 1 }];
    else if (sql.includes("candidate.kind='validate_chapter'")) rows = [{ id: '00000000-0000-4000-8000-000000000029' }];
    else if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) rows = [
      { id: '00000000-0000-4000-8000-000000000030' },
    ];
    else assert.fail(`unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    return work(tx);
  } };
  let artifactKind = '';
  const worker = { succeed: async (...args: unknown[]) => {
    artifactKind = String((args[4] as { artifact_kind: string }).artifact_kind);
    const hooks = args[6] as { beforeSuccess(tx: GenerationJobSql): Promise<void>;
      afterSuccess(tx: GenerationJobSql): Promise<void> };
    await hooks.beforeSuccess(tx); await hooks.afterSuccess(tx);
  } };
  const repository = createOrchestrationV2UnitRepository(db, worker as never,
    () => '00000000-0000-4000-8000-000000000030');
  await repository.complete(lease, publication, response.usage ?? {},
    (async () => undefined) as never, (async () => undefined) as never, 'provider');
  assert.equal(artifactKind, 'unit_baseline');
  assert.ok(queries.findIndex(sql => sql.includes('INSERT INTO lesson_author_workspace_revisions'))
    < queries.findIndex(sql => sql.includes("candidate.kind='validate_chapter'")));
  assert.equal(queries.filter(sql => sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')).length, 1);
});

test('unit repository reloads exact authority, architecture, inventory and source facts under the live lease', async () => {
  const { assembly, sourceFacts, contract } = fixture();
  const inventoryHash = hash('inventory');
  const unitContractHash = hash('unit-node-contract');
  const lease = { task_id: '00000000-0000-4000-8000-000000000041', run_id: '00000000-0000-4000-8000-000000000042',
    workspace_id: '00000000-0000-4000-8000-000000000043', tenant_id: '00000000-0000-4000-8000-000000000044',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000045',
    contract_hash: hash('task-contract'), input_context_hash: '',
    source_snapshot_id: '00000000-0000-4000-8000-000000000046', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000047', dispatch_epoch: 1,
    routing_shard: 3, ai_reservation_id: '00000000-0000-4000-8000-000000000048' } as OrchestrationV2TaskLease;
  lease.input_context_hash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash, inventory_hash: inventoryHash,
    node_id: lease.node_id, contract_hash: unitContractHash, source_scope_ids: ['scope-1'] });
  const componentContract = { component_type: 'html', metadata: {
    component_plan_id: contract.component_plan[0]!.component_plan_id, source_scope_ids: ['scope-1'] } };
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    seen.push({ sql, params });
    let rows: Array<Record<string, unknown>> = [];
    if (sql.includes('SELECT w.kb_id::text')) rows = [{
      kb_id: '00000000-0000-4000-8000-000000000049',
      conversation_id: '00000000-0000-4000-8000-000000000050',
      correlation_id: '00000000-0000-4000-8000-000000000051', content_locale: 'vi',
      source_document_ids: ['00000000-0000-4000-8000-000000000011'], canonical_path: contract.unit_path,
      node_contract_hash: unitContractHash, content_state: 'planned', current_revision: null,
      task_key: lease.task_key,
    }];
    else if (sql.includes('FROM kb_documents')) rows = [{ document_id: '00000000-0000-4000-8000-000000000011',
      kb_id: '00000000-0000-4000-8000-000000000049', name: 'source.pdf', type: 'pdf', status: 'learned' }];
    else if (sql.includes('FROM lesson_author_workspace_v2_artifacts a')) rows = [
      { artifact_kind: 'architecture_validation', artifact_hash: assembly.assembly_hash, payload: assembly },
      { artifact_kind: 'inventory_receipt', artifact_hash: hash('inventory-receipt'),
        payload: { inventory_hash: inventoryHash } },
    ];
    else if (sql.includes('FROM lesson_author_workspace_source_facts')) {
      rows = sourceFacts as unknown as Array<Record<string, unknown>>;
    }
    else if (sql.includes("parent_id=$4 AND kind='component'")) rows = [{
      id: '00000000-0000-4000-8000-000000000052', canonical_path: `${contract.unit_path}.component_1`,
      sort_order: 0, protected_contract: componentContract, contract_hash: orchestrationV2Hash(componentContract),
      content_state: 'planned', current_revision: null,
    }];
    else assert.fail(`unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    return work(tx);
  } };
  const loaded = await createOrchestrationV2UnitRepository(db, {} as never).load(lease);
  assert.equal(loaded.contract.contract_hash, contract.contract_hash);
  assert.deepEqual(loaded.contract.unit_source_fact_ids, ['fact-1', 'fact-2']);
  const factQuery = seen.find(query => query.sql.includes('FROM lesson_author_workspace_source_facts'));
  assert.deepEqual(factQuery?.params[4], ['scope-1']);
  assert.ok(seen[0]!.sql.includes('lease_expires_at>clock_timestamp()'));
});
