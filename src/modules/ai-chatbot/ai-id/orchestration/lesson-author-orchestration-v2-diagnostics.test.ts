import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { OrchestrationV2ChapterError, validateOrchestrationV2Chapter, type OrchestrationV2ChapterBaselineEvidence,
  type OrchestrationV2ChapterUnitEvidence } from './steps/lesson-author-orchestration-v2-chapter.logic.js';
import { OrchestrationV2ChapterRepositoryError } from './steps/lesson-author-orchestration-v2-chapter.repository.js';
import { atOrchestrationV2Stage, orchestrationV2ChapterEvidenceFields, orchestrationV2ErrorSite,
  orchestrationV2RunOutcomeFields } from './lesson-author-orchestration-v2-diagnostics.logic.js';
import { orchestrationV2DeterministicUuid } from './steps/lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from '../shared/lesson-author-orchestration-v2.logic.js';
import { executeOrchestrationV2PlanningTask } from './steps/lesson-author-orchestration-v2-planning.service.js';
import { orchestrationV2UnitArtifactHash } from './steps/lesson-author-orchestration-v2-unit.logic.js';
import { handleOrchestrationV2Delivery, type OrchestrationV2WorkerRuntimeDependencies } from './worker/lesson-author-orchestration-v2-worker.service.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './worker/lesson-author-orchestration-v2-worker.repository.js';
import { orchestrationV2DispatchEnvelope } from './dispatch/lesson-author-orchestration-v2-dispatch.logic.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: unknown) => orchestrationV2Hash(value);
type ChapterInput = Parameters<typeof validateOrchestrationV2Chapter>[0];
interface ChapterFixture {
  run_id: string; assembly: OrchestrationV2ArchitectureAssembly; inventory_hash: string; chapter_key: string; chapter_node_id: string;
  source_facts: Array<ChapterInput['source_facts'][number]>; units: OrchestrationV2ChapterUnitEvidence[];
  baselines: OrchestrationV2ChapterBaselineEvidence[];
}

/** One valid chapter (1 lesson, 1 unit, 1 component, 2 facts) as validation input. */
function chapterInput(): ChapterFixture {
  const runId = id(1), snapshotHash = hash('snapshot');
  const assemblyBase = { contract_version: 2 as const, source_snapshot_hash: snapshotHash, skeleton_hash: hash('skeleton'),
    shard_hashes: [hash('shard')], admitted_fact_count: 2, allocated_fact_count: 2, duplicate_scope_count: 0 as const,
    unresolved_scope_count: 0 as const, chapter_count: 1, lesson_count: 1, unit_count: 1, component_plan_count: 1,
    architecture: { locale: 'vi' as const, title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
      learning_outcomes: ['Outcome'], assessment_strategy: 'Assessment', assumptions: [],
      chapters: [{ chapter_key: 'chapter-1', order: 1, title: 'Chapter', objective: 'Objective', source_scope_ids: ['scope-1'],
        lessons: [{ title: 'Lesson', objective: 'Lesson objective', learning_objectives: ['Objective'],
          learning_activities: ['Activity'], assessment: 'Assessment', units: [{ title: 'Unit', purpose: 'Explain',
            learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], media_brief: null,
            component_plan: [{ type: 'html' as const, title: 'Theory', rationale: 'Teach', source_scope_ids: ['scope-1'] }] }] }] }] } };
  const assembly = { ...assemblyBase, assembly_hash: hash(assemblyBase) } as OrchestrationV2ArchitectureAssembly;
  const unitPath = 'chapter_1.lesson_1.unit_1';
  const unitContent = { title: 'Unit', purpose: 'Explain', data: {}, implementation_notes: null };
  const componentContent = { title: 'Theory', purpose: 'explain', data: { html: '<p>Content</p>' }, implementation_notes: null };
  const nodes = [{ path: unitPath, content: unitContent, content_hash: hash(unitContent) },
    { path: `${unitPath}.component_1`, content: componentContent, content_hash: hash(componentContent) }];
  const payload: Record<string, unknown> = { contract_version: 2, unit_path: unitPath, source_snapshot_hash: snapshotHash,
    contract_hash: hash('unit-contract'), nodes, generated_unit: { title: 'Unit', source_fact_ids: ['fact-1', 'fact-2'], components: [{}] } };
  const taskId = id(2);
  const fact = (key: string, scope: string, text: string) => ({ document_id: id(9), fact_key: key, scope_key: scope, fact_text: text,
    fact_hash: hash(text), source_ref: null, source_page: null, source_chunk: null, locator: {} });
  return { run_id: runId, assembly, inventory_hash: hash('inventory'), chapter_key: 'chapter-1',
    chapter_node_id: orchestrationV2DeterministicUuid(runId, 'node:chapter_1'),
    source_facts: [fact('fact-1', 'scope-1', 'One'), fact('fact-2', 'scope-1', 'Two')],
    units: [{ task_id: taskId, task_key: 'content:chapter-1:unit:1', node_id: orchestrationV2DeterministicUuid(runId, `node:${unitPath}`),
      artifact_hash: orchestrationV2UnitArtifactHash(payload), payload }],
    baselines: nodes.map((node, index) => ({ canonical_path: node.path, kind: index === 0 ? 'unit' as const : 'component' as const,
      content_hash: node.content_hash, revision: 0, operation_id: taskId })) };
}
/** Re-seal the unit artifact after editing its payload, so only the intended check fails. */
function reseal(input: ChapterFixture) {
  input.units[0] = { ...input.units[0]!, artifact_hash: orchestrationV2UnitArtifactHash(input.units[0]!.payload) };
}
function diagnosis(input: ChapterInput) {
  try { validateOrchestrationV2Chapter(input); } catch (error) {
    assert.ok(error instanceof OrchestrationV2ChapterError);
    assert.equal(error.code, 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID', 'the public failure code never changes');
    return error.chapter_evidence;
  }
  return assert.fail('expected a chapter evidence refusal');
}
const UNIT = 'chapter_1.lesson_1.unit_1', COMPONENT = `${UNIT}.component_1`;

test('chapter validation names each evidence refusal with a fixed reason and a canonical path', () => {
  const valid = validateOrchestrationV2Chapter(chapterInput());
  assert.deepEqual(Object.keys(valid).sort(), ['admitted_fact_count', 'allocated_fact_count', 'assembly_hash', 'baseline_set_hash',
    'chapter_key', 'chapter_node_id', 'component_count', 'contract', 'covered_fact_count', 'duplicate_fact_count', 'fact_set_hash',
    'inventory_hash', 'receipt_hash', 'source_snapshot_hash', 'unit_artifact_hashes', 'unit_count', 'unresolved_fact_count'],
  'the receipt has no diagnostic field');
  const cases: Array<[string, (input: ChapterFixture) => void, string, string | null]> = [
    ['invalid fact hash', input => { input.source_facts[0] = { ...input.source_facts[0]!, fact_hash: 'x' }; }, 'FACT_INVALID', null],
    ['duplicate fact', input => { input.source_facts.push(input.source_facts[0]!); }, 'DUPLICATE_FACT', null],
    ['fact outside the chapter', input => { input.source_facts[1] = { ...input.source_facts[1]!, scope_key: 'scope-9' }; },
      'FACT_SCOPE_MISMATCH', null],
    ['no facts', input => { input.source_facts.length = 0; }, 'SCOPE_COVERAGE_MISMATCH', 'chapter_1'],
    ['missing unit', input => { input.units.length = 0; }, 'UNIT_COUNT_MISMATCH', 'chapter_1'],
    ['duplicate baseline', input => { input.baselines.push(input.baselines[0]!); }, 'BASELINE_DUPLICATE_PATH', 'chapter_1'],
    ['foreign task key', input => { input.units[0] = { ...input.units[0]!, task_key: 'content:chapter-1:unit:2' }; },
      'UNIT_IDENTITY_MISMATCH', UNIT],
    ['invalid quality envelope', input => { Object.assign(input.units[0]!.payload,
      { content_origin: 'raw_source_fallback', quality_state: 'validated' }); }, 'QUALITY_INVALID', UNIT],
    ['other unit path', input => { input.units[0]!.payload.unit_path = 'chapter_1.lesson_1.unit_2'; reseal(input); },
      'UNIT_PAYLOAD_INVALID', UNIT],
    ['artifact hash drift', input => { input.units[0] = { ...input.units[0]!, artifact_hash: hash('drift') }; },
      'ARTIFACT_HASH_MISMATCH', UNIT],
    ['unit facts drift', input => { input.units[0]!.payload.generated_unit = { title: 'Unit', source_fact_ids: ['fact-1'], components: [{}] };
      reseal(input); }, 'UNIT_FACTS_MISMATCH', UNIT],
    ['node count', input => { input.units[0]!.payload.nodes = (input.units[0]!.payload.nodes as unknown[]).slice(0, 1); reseal(input); },
      'NODE_COUNT_MISMATCH', UNIT],
    ['component count', input => { input.units[0]!.payload.generated_unit = { title: 'Unit', source_fact_ids: ['fact-1', 'fact-2'],
      components: [] }; reseal(input); }, 'COMPONENT_COUNT_MISMATCH', UNIT],
    ['artifact node hash', input => { const nodes = structuredClone(input.units[0]!.payload.nodes) as Array<Record<string, unknown>>;
      nodes[1]!.content_hash = hash('other'); input.units[0]!.payload.nodes = nodes; reseal(input); }, 'ARTIFACT_NODE_INVALID', COMPONENT],
    ['missing baseline', input => { input.baselines.pop(); }, 'BASELINE_MISSING', COMPONENT],
    ['edited baseline', input => { input.baselines[1] = { ...input.baselines[1]!, revision: 1 }; }, 'BASELINE_MISMATCH', COMPONENT],
    ['extra baseline', input => { input.baselines.push({ ...input.baselines[1]!, canonical_path: `${UNIT}.component_9` }); },
      'BASELINE_COUNT', 'chapter_1'],
    ['unallocated fact', input => {
      const chapter = input.assembly.architecture.chapters[0]! as unknown as { source_scope_ids: string[] };
      chapter.source_scope_ids = ['scope-1', 'scope-2'];
      input.source_facts.push({ ...input.source_facts[0]!, fact_key: 'fact-3', scope_key: 'scope-2', fact_hash: hash('Three') });
    }, 'COVERAGE_MISMATCH', 'chapter_1'],
  ];
  for (const [name, mutate, reason, path] of cases) {
    const input = chapterInput();
    mutate(input);
    assert.deepEqual(diagnosis(input), { reason, path }, name);
  }
});

test('chapter repository refusals carry their own diagnosis under the same public code', () => {
  const error = new OrchestrationV2ChapterRepositoryError('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID',
    { reason: 'INPUT_HASH_MISMATCH', path: null });
  assert.equal(error.code, 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
  assert.deepEqual(orchestrationV2ChapterEvidenceFields(error), { chapter_reason: 'INPUT_HASH_MISMATCH' });
  assert.deepEqual(orchestrationV2ChapterEvidenceFields({ chapter_evidence: { reason: 'Fact text <b>', path: 'chapter_1' } }), {});
  assert.deepEqual(orchestrationV2ChapterEvidenceFields({ chapter_evidence: { reason: 'QUALITY_INVALID', path: '../etc' } }),
    { chapter_reason: 'QUALITY_INVALID' });
});

// ── Error site: file:line of the top in-repo frame, never the message ──

const stackOf = (message: string, frames: string[]) => Object.assign(new TypeError(message), {
  stack: [`TypeError: ${message}`, ...frames.map(frame => `    at ${frame}`)].join('\n') });

test('error site is the top in-repo frame as a relative file:line', () => {
  assert.equal(orchestrationV2ErrorSite(stackOf('x', [
    'Object.parse (D:\\app\\landa-backend\\node_modules\\pg\\lib\\result.js:10:5)',
    'node:internal/process/task_queues:105:5',
    'executeOrchestrationV2PlanningTask (D:\\LANDA\\landa-backend\\dist\\modules\\ai-chatbot\\ai-id\\orchestration\\steps\\lesson-author-orchestration-v2-planning.service.js:143:15)',
    'async handle (D:\\LANDA\\landa-backend\\dist\\modules\\x.js:1:1)',
  ])), 'modules/ai-chatbot/ai-id/orchestration/steps/lesson-author-orchestration-v2-planning.service.js:143');
  assert.equal(orchestrationV2ErrorSite(stackOf('y', ['file:///D:/wt/landa-backend/src/modules/ai-chatbot/ai-id/a.ts:12:3'])),
    'modules/ai-chatbot/ai-id/a.ts:12');
  assert.equal(orchestrationV2ErrorSite(stackOf('z', ['Array.map (<anonymous>)', 'C:\\other\\tool.js:3:1'])), null);
  assert.equal(orchestrationV2ErrorSite('boom'), null);
  assert.equal(orchestrationV2ErrorSite({ stack: 'at D:/app/src/modules/a.ts:1:1' }), null, 'only real Error objects');
  // A multi-line message that imitates a frame is never read.
  const forged = stackOf('Provider said:\n    at secret (D:/app/src/modules/provider-text-here.ts:9:9)', []);
  assert.equal(orchestrationV2ErrorSite(forged), null);
});

const envelope = orchestrationV2DispatchEnvelope({ outbox_id: id(41), run_id: id(42), task_id: id(43), dispatch_epoch: 0, routing_shard: 1 });
const raw = Buffer.from(JSON.stringify(envelope));
const lease: OrchestrationV2TaskLease = {
  task_id: id(43), run_id: id(42), workspace_id: id(44), tenant_id: id(45), course_id: 'course-v1:test+1+2026',
  task_key: 'validate:chapter-1', kind: 'validate_chapter', chapter_key: 'chapter-1', node_id: id(46),
  contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: id(47),
  source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi',
  max_output_tokens: 0, provider_max_attempts: 0, execution_budget_ms: 60_000, lease_token: id(48), dispatch_epoch: 1,
  provider_replay_required: false, routing_shard: 1, ai_reservation_id: null,
};
function worker(execute: OrchestrationV2WorkerRuntimeDependencies['execute'], claimed: OrchestrationV2TaskLease = lease) {
  const events: Record<string, unknown>[] = [];
  const repository = { claimExact: async () => ({ disposition: 'claimed', lease: claimed }), renew: async () => true,
    recoverClaimFailure: async () => 'failed' as const, wakeOneCapacityDeferred: async () => null,
  } as unknown as ReturnType<typeof createOrchestrationV2WorkerRepository>;
  return { events, deps: { repository, limits: { global_concurrency_limit: 8, provider_concurrency_limit: 2, lease_seconds: 30 },
    reserveProvider: async () => id(49), releaseUndispatched: async () => undefined, releaseRejected: async () => undefined,
    holdUnknown: async () => undefined, execute, report: (event: Record<string, unknown>) => { events.push(event); } } };
}

test('an uncoded failure logs its error site and stage, never its message text', async () => {
  const secret = 'Lesson text from the provider: Đo điện trở bằng đồng hồ vạn năng';
  const run = worker(async () => atOrchestrationV2Stage('chapter_publication', async () => {
    throw new TypeError(secret);
  }));
  await handleOrchestrationV2Delivery(raw, run.deps);
  for (const name of ['worker_claim_failure_finalized', 'worker_task_failed']) {
    const event = run.events.find(candidate => candidate.event === name)!;
    assert.equal(event.failure_code, 'ORCHESTRATION_V2_TASK_EXECUTION_FAILED');
    assert.equal(event.error_name, 'TypeError');
    assert.equal(event.execution_stage, 'chapter_publication');
    assert.match(String(event.error_site), /^modules\/ai-chatbot\/ai-id\/orchestration\/lesson-author-orchestration-v2-diagnostics\.test\.ts:\d+$/);
  }
  assert.equal(JSON.stringify(run.events).includes('Đo điện trở'), false);
  assert.equal(JSON.stringify(run.events).includes('Lesson text'), false);

  // A coded failure keeps its code and gets no site.
  const coded = worker(async () => { throw Object.assign(new Error('x'), { code: 'ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID' }); });
  await handleOrchestrationV2Delivery(raw, coded.deps);
  const event = coded.events.find(candidate => candidate.event === 'worker_task_failed')!;
  assert.equal(event.failure_code, 'ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
  assert.equal('error_site' in event, false);
});

test('a chapter evidence refusal reaches the worker log with its reason and path, same failure code', async () => {
  const input = chapterInput();
  input.baselines.pop();
  const run = worker(async () => { validateOrchestrationV2Chapter(input); });
  await handleOrchestrationV2Delivery(raw, run.deps);
  for (const name of ['worker_claim_failure_finalized', 'worker_task_failed']) {
    const event = run.events.find(candidate => candidate.event === name)!;
    assert.deepEqual({ code: event.failure_code, reason: event.chapter_reason, path: event.chapter_reason_path },
      { code: 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID', reason: 'BASELINE_MISSING', path: COMPONENT });
    assert.equal('error_site' in event, false);
  }
});

test('planning steps tag the step an error escaped from', async () => {
  const planningLease = { ...lease, kind: 'validate_architecture' as const, task_key: 'architecture:validate', chapter_key: null, node_id: null };
  const runtime = { embedding_model: 'embedding', embedding_dimensions: 768, budgets: { inventory_publish_budget_ms: 1000 } } as never;
  const fail = () => { throw new Error('boom'); };
  const run = async (planning: Record<string, unknown>, kind: OrchestrationV2TaskLease = planningLease) => {
    try {
      await executeOrchestrationV2PlanningTask(kind, planning as never, {} as never, {} as never, runtime, (async () => undefined) as never,
        new AbortController().signal);
    } catch (error) { return (error as { orchestration_stage?: string }).orchestration_stage; }
    return assert.fail('expected a failure');
  };
  assert.equal(await run({ loadArchitectureInput: async () => fail() }), 'architecture_input_load');
  assert.equal(await run({ loadArchitectureInput: async () => ({ skeleton: {}, scopes: [], shard_artifacts: [] }) }), 'architecture_assembly');
  assert.equal(await run({ loadAuthority: async () => fail() }, { ...planningLease, kind: 'course_skeleton', task_key: 'architecture:course' }),
    'planning_authority_load');
  // A stage already set by an inner step wins.
  const inner = Object.assign(new Error('inner'), { orchestration_stage: 'provider_dispatch_fence' });
  assert.equal(await run({ loadArchitectureInput: async () => { throw inner; } }), 'provider_dispatch_fence');
});

test('a review-required finish is reported as a completed run with review', async () => {
  assert.deepEqual(orchestrationV2RunOutcomeFields('finalize_course', 'completed_with_review'), { run_outcome: 'completed_with_review' });
  assert.deepEqual(orchestrationV2RunOutcomeFields('generate_unit', 'completed'), {});
  const finalizer = worker(async () => 'completed_with_review', { ...lease, kind: 'finalize_course', task_key: 'finalize:course' });
  await handleOrchestrationV2Delivery(raw, finalizer.deps);
  assert.equal(finalizer.events.find(event => event.event === 'worker_task_succeeded')?.run_outcome, 'completed_with_review');
});
