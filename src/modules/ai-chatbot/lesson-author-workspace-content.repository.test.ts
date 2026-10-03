import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { GenerationJobSql, GenerationJobDatabase } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { createWorkspaceComponentAcceptance, type WorkspaceContentDiagnostic } from './lesson-author-workspace-content.repository.js';
import { createWorkspaceEditRepository, type WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import { prepareWorkspaceEdit, prepareWorkspaceReset } from './lesson-author-workspace.logic.js';
import { workspaceComponentStorage } from './lesson-author-workspace-component.logic.js';
import { encodeWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { tenantId: uuid(1), userId: uuid(2), workspaceId: uuid(3), conversationId: uuid(4), nodeId: uuid(14), operationId: uuid(5), courseId: 'course-v1:TEST+EDIT+2026' };
const allowed = new Set<CourseComponentType>(['html', 'problem']);
const safeCode = (code: string) => (e: unknown) => e instanceof Error && e.message === code;
type Row = Record<string, any>;
function fixture() {
  const components: LessonAuthorComponentProposal[] = [
    { type: 'html', title: 'Synthetic teaching', data: '<p>Read the approved instructions before starting the work. Check every item carefully in the stated order and then confirm completion.</p>',
      metadata: { component_plan_id: 'plan_1', source_fact_ids: ['fact_1'], supporting_evidence_fact_ids: [], covered_source_fact_ids: ['fact_1'], learning_objective_refs: ['lo_1'] } },
    { type: 'problem', title: 'Synthetic assessment', data: encodeWorkspaceProblem({ kind: 'multiple_choice', question: 'Which activity comes first?', explanation: 'Reading comes first.', choices: [{ text: 'Read', correct: true }, { text: 'Skip', correct: false }] }),
      metadata: { component_plan_id: 'plan_2', source_fact_ids: [], supporting_evidence_fact_ids: ['fact_1'], covered_source_fact_ids: [], learning_objective_refs: ['lo_1'] } },
    { type: 'html', title: 'Next unit', data: '<p>Use a checklist to document each completed action. The written record supports follow-up review and helps the team identify any omitted steps.</p>',
      metadata: { component_plan_id: 'plan_3', source_fact_ids: ['fact_2'], supporting_evidence_fact_ids: [], covered_source_fact_ids: ['fact_2'], learning_objective_refs: ['lo_2'] } },
  ];
  const stores = components.map(c => workspaceComponentStorage(c, allowed));
  const blueprint = { architecture_contract_version: 5, content_contract_version: 1, chapters: [{ title: 'Synthetic chapter', lessons: [{
    title: 'Synthetic lesson', learning_objectives: ['Identify the first activity.', 'Describe documentation.'],
    assessment_required: true, assessment_objective_refs: ['lo_1'], units: [
      { title: 'Unit one', source_fact_ids: ['fact_1'], supporting_evidence_fact_ids: ['fact_1'], learning_objective_refs: ['lo_1'], component_plan: components.slice(0, 2).map(c => ({ type: c.type, ...c.metadata })) },
      { title: 'Unit two', source_fact_ids: ['fact_2'], supporting_evidence_fact_ids: [], learning_objective_refs: ['lo_2'], component_plan: [{ type: 'html', ...components[2].metadata }] },
    ],
  }] }] };
  function node(n: number, path: string, kind: string, parent: number, order: number, ready: boolean, stored?: typeof stores[number]): Row {
    const contract = stored?.binding ?? {};
    return { id: uuid(n), parent_id: uuid(parent), kind, canonical_path: path, sort_order: order,
      content_state: ready ? 'content_ready' : 'planned', current_revision: ready ? 0 : null,
      protected_contract: contract, contract_hash: hash(contract), baseline_origin: ready ? 'ai_baseline' : null, baseline_modified: ready ? false : null,
      baseline_content: ready ? stored?.content ?? null : null, baseline_hash: ready && stored ? hash(stored.content) : null,
      current_content: ready ? stored?.content ?? null : null, current_hash: ready && stored ? hash(stored.content) : null };
  }
  const nodes = [node(10, 'chapter_1', 'chapter', 9, 0, false), node(11, 'chapter_1.lesson_1', 'lesson', 10, 0, false),
    node(12, 'chapter_1.lesson_1.unit_1', 'unit', 11, 0, true), node(13, 'chapter_1.lesson_1.unit_2', 'unit', 11, 1, false),
    node(14, 'chapter_1.lesson_1.unit_1.component_1', 'component', 12, 0, true, stores[0]),
    node(15, 'chapter_1.lesson_1.unit_1.component_2', 'component', 12, 1, true, stores[1]),
    node(16, 'chapter_1.lesson_1.unit_2.component_1', 'component', 13, 0, false, stores[2])];
  const logs: WorkspaceContentDiagnostic[] = [], queries: Array<{ sql: string; params: unknown[] }> = [];
  const state = { bound: true, scopeBytes: '10000', oversizedCount: false, loggerThrows: false, commits: 0, rollbacks: 0 };
  const revisions: Row[] = [{ revision: 0, parent_revision: null, origin: 'ai_baseline', user_modified: false,
    content: stores[0].content, content_hash: hash(stores[0].content) }];
  const events: Row[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push({ sql, params }); let rows: Row[];
    if (sql.startsWith('SELECT n.canonical_path,b.blueprint')) rows = state.bound ? [{ canonical_path: nodes[4].canonical_path, blueprint }] : [];
    else if (sql.startsWith('SELECT count(*)::text')) rows = [{ node_count: state.oversizedCount ? '2049' : String(nodes.length), scope_bytes: state.scopeBytes }];
    else if (sql.startsWith('SELECT n.id,n.parent_id')) rows = nodes;
    else if (sql.startsWith('SELECT id FROM courses')) rows = [{ id: target.courseId }];
    else if (sql.includes('FROM lesson_author_session_deletion_jobs')) rows = [];
    else if (sql.startsWith('SELECT w.id,w.status')) rows = [{ id: target.workspaceId, status: 'drafting', contract_version: 1, content_locale: 'vi', correlation_id: uuid(50), source_snapshot_hash: 'a'.repeat(64) }];
    else if (sql.startsWith('SELECT id,kind,content_state')) rows = [nodes[4]];
    else if (sql.startsWith('SELECT revision,parent_revision')) rows = revisions.filter(r => r.revision === 0 || r.revision === nodes[4].current_revision || r.operation_id === params[5]);
    else if (sql.startsWith('SELECT content,content_hash')) rows = revisions.filter(r => r.revision === params[4]);
    else if (sql.startsWith('SELECT 1 AS applied FROM lesson_author_workspace_apply_mappings')) rows = [];
    else if (sql.startsWith('INSERT INTO lesson_author_workspace_revisions')) {
      const r = { revision: params[4], parent_revision: params[5], origin: params[6], actor_id: params[7], operation_id: params[8], content: JSON.parse(String(params[9])), content_hash: params[10], validation_contract: params[11], user_modified: params[12] };
      revisions.push(r); nodes[4].current_revision = r.revision; nodes[4].current_content = r.content; nodes[4].current_hash = r.content_hash;
      events.push({ ...r, sequence: events.length + 1 }); rows = [{ revision: r.revision }];
    } else if (sql.startsWith('SELECT e.sequence,r.revision')) rows = events.filter(e => e.operation_id === params[4] && e.revision === params[5]).map(e => ({ ...e, current_revision: nodes[4].current_revision }));
    else throw new Error('UNEXPECTED_TEST_QUERY');
    return { rows: structuredClone(rows) as T[], rowCount: rows.length };
  } };
  const validate = createWorkspaceComponentAcceptance(event => { logs.push(event); if (state.loggerThrows) throw new Error('private logger failure'); });
  function context(): WorkspaceEditContext {
    const n = nodes[4];
    return { target, correlation_id: uuid(50), content_locale: 'vi', source_snapshot_hash: 'a'.repeat(64),
      protected_contract: n.protected_contract, contract_hash: n.contract_hash, node: { node_id: target.nodeId, kind: 'component', content_state: 'content_ready',
        current_revision: n.current_revision, baseline: n.baseline_content, current: n.current_content } };
  }
  async function accept(changes = { title: 'Author title' } as Record<string, unknown>, capabilities = allowed) {
    const ctx = context(), candidate = prepareWorkspaceEdit(ctx.node, { expected_revision: ctx.node.current_revision, changes });
    return validate(tx, ctx, candidate, capabilities);
  }
  const db: GenerationJobDatabase = { async transaction(work) {
    const before = structuredClone({ nodes, revisions, events });
    try { const value = await work(tx); state.commits++; return value; }
    catch (e) { nodes.splice(0, nodes.length, ...before.nodes); revisions.splice(0, revisions.length, ...before.revisions); events.splice(0, events.length, ...before.events); state.rollbacks++; throw e; }
  } };
  const repo = createWorkspaceEditRepository({ db, canEdit: async () => true, currentSourceHash: async () => 'a'.repeat(64),
    validate: (tx, ctx, candidate) => validate(tx, ctx, candidate, allowed) });
  function complete() {
    nodes[3].content_state = 'content_ready'; nodes[3].current_revision = 0;
    Object.assign(nodes[6], node(16, nodes[6].canonical_path, 'component', 13, 0, true, stores[2]));
  }
  return { state, nodes, blueprint, stores, logs, queries, tx, validate, context, accept, repo, revisions, events, complete };
}

test('real component acceptance loads exact persisted scope and records incomplete, not full-course PASS', async () => {
  const f = fixture(), receipt = await f.accept();
  assert.equal(receipt.validation_contract, 'workspace-component-edit-ready-1');
  assert.equal(receipt.expected_revision, 0); assert.ok(Object.values(receipt.checks).every(v => v === 'PASS'));
  assert.equal(f.logs[0].scope_complete, false); assert.equal(f.logs[0].ready_unit_count, 1);
  assert.ok(f.logs[0].deferred_check_count > 0); assert.equal(f.logs[0].semantic_fidelity, 'not_measured');
  assert.ok(f.queries.every(q => q.sql.startsWith('SELECT')));
  assert.deepEqual(f.queries[0].params.slice(0, 6), [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId, target.nodeId]);
  assert.match(f.queries[0].sql, /FOR SHARE OF w,n/); assert.match(f.queries[0].sql, /event_kind='structure_ready'/);
});
test('completed chapter has no deferred checks; final validation is still separate from Save', async () => {
  const f = fixture(); f.complete(); await f.accept();
  assert.equal(f.logs[0].scope_complete, true); assert.equal(f.logs[0].deferred_check_count, 0);
  assert.equal(f.logs[0].validation_contract, 'workspace-component-edit-ready-1');
});
test('scope loading fails closed on missing binding, wrong version or invalid chapter path', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.state.bound = false; },
    (f: ReturnType<typeof fixture>) => { f.blueprint.architecture_contract_version = 4; },
    (f: ReturnType<typeof fixture>) => { f.nodes[4].canonical_path = 'chapter_100.lesson_1.unit_1.component_1'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.accept(), safeCode('WORKSPACE_COMPONENT_BINDING_INVALID'));
  }
});
test('missing, duplicate, foreign-parent, reordered and extra component paths are never silently dropped', async () => {
  const mutations = [(f: ReturnType<typeof fixture>) => { f.nodes.splice(5, 1); },
    (f: ReturnType<typeof fixture>) => { f.nodes.push(structuredClone(f.nodes[5])); },
    (f: ReturnType<typeof fixture>) => { f.nodes[5].parent_id = uuid(999); },
    (f: ReturnType<typeof fixture>) => { f.nodes[5].sort_order = 0; },
    (f: ReturnType<typeof fixture>) => { f.nodes.push({ ...f.nodes[5], id: uuid(99), canonical_path: 'chapter_1.lesson_1.unit_1.component_99' }); }];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(f.accept(), safeCode('WORKSPACE_COMPONENT_BINDING_INVALID')); }
});
test('node/contract/current/baseline drift all reject before acceptance', async () => {
  for (const field of ['contract_hash', 'baseline_hash', 'current_hash']) {
    const f = fixture(); f.nodes[5][field] = 'b'.repeat(64); await assert.rejects(f.accept(), safeCode('WORKSPACE_COMPONENT_BINDING_INVALID'));
  }
  const f = fixture(), ctx = f.context(), candidate = prepareWorkspaceEdit(ctx.node, { expected_revision: 0, changes: { title: 'Change' } });
  f.nodes[4].current_revision = 1;
  await assert.rejects(f.validate(f.tx, ctx, candidate, allowed), safeCode('WORKSPACE_COMPONENT_BINDING_INVALID'));
});
test('canonical ownership and objective metadata must match the exact approved component instance', async () => {
  for (const change of [{ component_plan_id: 'foreign_plan' }, { source_fact_ids: ['other_fact'] },
    { supporting_evidence_fact_ids: ['other_fact'] }, { learning_objective_refs: ['lo_999'] }]) {
    const f = fixture(), n = f.nodes[5]; Object.assign(n.protected_contract.metadata, change); n.contract_hash = hash(n.protected_contract);
    await assert.rejects(f.accept(), safeCode('WORKSPACE_COMPONENT_BINDING_INVALID'));
  }
});
test('ready units must be atomic and a pending unit cannot contain an editable orphan component', async () => {
  const f = fixture(); f.nodes[2].content_state = 'generating';
  await assert.rejects(f.accept(), safeCode('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'));
  const g = fixture(); g.nodes[5].content_state = 'generating';
  await assert.rejects(g.accept(), safeCode('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'));
});
test('bounded count and serialized size gate execute before reading full content', async () => {
  for (const over of ['count', 'bytes']) {
    const f = fixture(); if (over === 'count') f.state.oversizedCount = true; else f.state.scopeBytes = String(16 * 1024 * 1024 + 1);
    await assert.rejects(f.accept(), safeCode('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'));
    assert.equal(f.queries.length, 2);
  }
});
test('real coverage, required artifacts, assessment and capability rejection produce no acceptance', async () => {
  const f = fixture(); await assert.rejects(f.accept({ data: '<p>Short</p>' }), safeCode('WORKSPACE_COMPONENT_ACCEPTANCE_FAILED'));
  assert.ok(f.logs[0].findings.some(v => v.code === 'ASSESSMENT_NOT_ALIGNED'));
  const g = fixture(); (g.blueprint.chapters[0].lessons[0].units[0].component_plan[0] as any).required_artifacts = [{ type: 'table', minimum_items: 2 }];
  await assert.rejects(g.accept(), safeCode('WORKSPACE_COMPONENT_ACCEPTANCE_FAILED'));
  assert.ok(g.logs[0].findings.some(v => v.code === 'WORKSPACE_COMPONENT_COVERAGE_INVALID'));
  const h = fixture(); await assert.rejects(h.accept(undefined, new Set(['html'])), safeCode('WORKSPACE_COMPONENT_CAPABILITY_DENIED'));
});
test('Save → replay → Reset uses actual materializer/validators and append repository; no course Apply', async () => {
  const f = fixture();
  const first = await f.repo.save(target, { expected_revision: 0, changes: { title: 'Author title' } });
  assert.equal(first.revision, 1); assert.equal(f.logs.length, 1);
  const replay = await f.repo.save(target, { expected_revision: 0, changes: { title: 'Author title' } });
  assert.equal(replay.replayed, true); assert.equal(f.logs.length, 1);
  const reset = await f.repo.reset({ ...target, operationId: uuid(88) }, 1);
  assert.equal(reset.revision, 2); assert.equal(reset.user_modified, false); assert.equal(f.logs.length, 2);
  assert.deepEqual(f.revisions[2].content, f.revisions[0].content);
  assert.equal(f.revisions[1].validation_contract, 'workspace-component-edit-ready-1');
  assert.ok(f.queries.filter(q => !q.sql.startsWith('SELECT')).every(q => q.sql.startsWith('INSERT INTO lesson_author_workspace_revisions')));
});
test('failed real validation rolls back with no revision/event and preserves typed error', async () => {
  const f = fixture();
  await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { data: '<p>Short</p>' } }), safeCode('WORKSPACE_COMPONENT_ACCEPTANCE_FAILED'));
  assert.equal(f.state.rollbacks, 1); assert.equal(f.state.commits, 0); assert.equal(f.events.length, 0); assert.equal(f.revisions.length, 1);
});
test('safe diagnostics never include titles, payloads, prompts, metadata or raw errors; logger failure is harmless', async () => {
  const f = fixture(); f.state.loggerThrows = true; await f.accept();
  assert.doesNotMatch(JSON.stringify(f.logs), /Synthetic|Author title|Read the|fact_1|plan_1|private logger/);
  assert.equal(f.logs[0].correlation_id, uuid(50));
});
test('Reset receives the same real validators and cannot bypass newly disallowed capability', async () => {
  const f = fixture(), ctx = f.context(), candidate = prepareWorkspaceReset(ctx.node, 0);
  await assert.rejects(f.validate(f.tx, ctx, candidate, new Set(['problem'])), safeCode('WORKSPACE_COMPONENT_CAPABILITY_DENIED'));
});

test('V2 workspaces validate against hashed architecture identity without requiring a legacy blueprint row', () => {
  const source = readFileSync(new URL('./lesson-author-workspace-content.repository.ts', import.meta.url), 'utf8');
  assert.match(source, /LEFT JOIN lesson_author_blueprints b/);
  assert.match(source, /w\.blueprint_id IS NULL AND b\.id IS NULL/);
  assert.match(source, /FROM lesson_author_workspace_v2_runs r/);
  assert.match(source, /readOrchestrationV2ArchitectureAssembly/);
  assert.match(source, /prepareOrchestrationV2InventoryIdentity/);
  assert.match(source, /workspace-component-edit-v2-ready-1/);
  const v2TargetStart = source.indexOf('if (v2Expected) {');
  const legacyChapterStart = source.indexOf('const seen = new Set<string>();', v2TargetStart);
  const v2TargetAcceptance = source.slice(v2TargetStart, legacyChapterStart);
  assert.match(v2TargetAcceptance, /editWorkspaceComponent\(original, current, allowed\)/);
  assert.match(v2TargetAcceptance, /editWorkspaceComponent\(original, candidate\.content, allowed\)/);
  assert.doesNotMatch(v2TargetAcceptance, /component_plan\.map/,
    'a v2 component Save must not materialize unrelated sibling payloads');
});
