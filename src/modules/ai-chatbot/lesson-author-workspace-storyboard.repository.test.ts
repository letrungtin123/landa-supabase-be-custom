import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonAuthorBlueprint } from './chat.service.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceStoryboardAcceptance, createWorkspaceAcceptance, type WorkspaceStoryboardDiagnostic } from './lesson-author-workspace-storyboard.repository.js';
import { workspaceStoryboardSeed, type WorkspaceStoryboardBinding, type WorkspaceStoryboardKind,
  WORKSPACE_AGGREGATE_EDIT, WORKSPACE_MEDIA_EDIT } from './lesson-author-workspace-storyboard.logic.js';
import { createWorkspaceEditRepository, type WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import { prepareWorkspaceEdit, type WorkspaceNodeSnapshot } from './lesson-author-workspace.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { prepareOrchestrationV2InventoryIdentity } from './lesson-author-orchestration-v2-inventory.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { tenantId: uuid(1), userId: uuid(2), conversationId: uuid(3), workspaceId: uuid(4), nodeId: uuid(5), operationId: uuid(6), courseId: 'course-v1:TEST+STORYBOARD+2026' };
const paths = { course: 'course', chapter: 'chapter_1', lesson: 'chapter_1.lesson_1', unit: 'chapter_1.lesson_1.unit_1', media_brief: 'chapter_1.lesson_1.unit_1.media_1' };
const code = (value: string) => (e: unknown) => e instanceof Error && e.message === value;
type Row = Record<string, any>;
function fixture(kind: WorkspaceStoryboardKind = 'chapter', locale: 'vi' | 'en' = 'vi', authority: 'v1' | 'v2' = 'v1') {
  const blueprint: LessonAuthorBlueprint = { architecture_contract_version: 5, content_contract_version: 1,
    title: 'Synthetic course', summary: 'Synthetic summary', target_audience: 'Synthetic audience', prerequisites: [], learning_outcomes: ['Outcome'], assessment_strategy: 'Assessment strategy', assumptions: [],
    chapters: [{ title: 'Synthetic chapter', objective: 'Explain the process', lessons: [{ title: 'Synthetic lesson', objective: 'Identify the steps',
      learning_objectives: ['Identify the first step'], learning_activities: ['Read'], assessment: 'Knowledge check', units: [{ title: 'Synthetic unit', purpose: 'Explain and check',
        source_refs: ['src_1'], primary_evidence_scope_ids: ['scope_1'], learning_objective_refs: ['lo_1'],
        component_plan: [{ type: 'html', title: 'Explain', rationale: 'Source-supported', component_plan_id: 'plan_1', source_fact_ids: ['fact_1'] }],
        media_plan: { type: 'video', title: 'Synthetic brief', content_outline: 'Show the process', rationale: 'Visual demonstration', brief_version: 2,
          content_points: ['Show preparation', 'Show the check'], context_description: 'Demonstration at a workstation' },
      }] }] }] };
  const seed = workspaceStoryboardSeed(blueprint, kind, paths[kind])!;
  const architectureBase = { contract_version: 2 as const, source_snapshot_hash: 'a'.repeat(64), skeleton_hash: 'b'.repeat(64),
    shard_hashes: ['c'.repeat(64)], admitted_fact_count: 1, allocated_fact_count: 1, duplicate_scope_count: 0 as const,
    unresolved_scope_count: 0 as const, chapter_count: 1, lesson_count: 1, unit_count: 1, component_plan_count: 1,
    architecture: { locale, title: blueprint.title, summary: blueprint.summary, target_audience: blueprint.target_audience,
      prerequisites: blueprint.prerequisites, learning_outcomes: blueprint.learning_outcomes,
      assessment_strategy: blueprint.assessment_strategy, assumptions: blueprint.assumptions,
      chapters: [{ chapter_key: 'chapter_1', order: 0, title: blueprint.chapters[0].title,
        objective: blueprint.chapters[0].objective, learning_outcomes: blueprint.chapters[0].learning_objectives ?? [],
        source_scope_ids: ['scope_1'], lessons: [{ title: blueprint.chapters[0].lessons[0].title,
          objective: blueprint.chapters[0].lessons[0].objective,
          learning_objectives: blueprint.chapters[0].lessons[0].learning_objectives ?? [],
          learning_activities: blueprint.chapters[0].lessons[0].learning_activities,
          assessment: blueprint.chapters[0].lessons[0].assessment,
          units: [{ title: blueprint.chapters[0].lessons[0].units[0].title,
            purpose: blueprint.chapters[0].lessons[0].units[0].purpose!, source_scope_ids: ['scope_1'],
            learning_objective_refs: ['lo_1'], component_plan: [{ type: 'html' as const, title: 'Explain',
              rationale: 'Source-supported', source_scope_ids: ['scope_1'] }], media_brief: { type: 'video' as const,
              title: 'Synthetic brief', rationale: 'Visual demonstration', content_points: ['Show preparation', 'Show the check'],
              context_description: 'Demonstration at a workstation' } }] }] }] } };
  const assembly = { ...architectureBase, assembly_hash: orchestrationV2Hash(architectureBase) };
  const runId = uuid(80);
  const identity = prepareOrchestrationV2InventoryIdentity({ run_id: runId, assembly });
  const expected = identity.nodes.find(item => item.canonical_path === paths[kind])!;
  const scopeTarget = authority === 'v2' ? { ...target, nodeId: expected.id } : target;
  const binding = structuredClone(authority === 'v2' ? expected.protected_contract : seed.binding) as WorkspaceStoryboardBinding;
  const logs: WorkspaceStoryboardDiagnostic[] = [], queries: Array<{ sql: string; params: unknown[] }> = [];
  const parentKind = { course: null, chapter: 'course', lesson: 'chapter', unit: 'lesson', media_brief: 'unit' }[kind];
  const row: Row = { blueprint_id: authority === 'v2' ? null : uuid(70), id: scopeTarget.nodeId,
    parent_id: authority === 'v2' ? expected.parent_id : kind === 'course' ? null : uuid(71),
    kind, canonical_path: seed.canonical_path, sort_order: seed.sort_order, current_revision: 0,
    protected_contract: binding, contract_hash: hash(binding), parent_path: seed.parent_path, parent_kind: parentKind,
    blueprint };
  const persistedBaseline = authority === 'v2' ? expected.baseline ?? seed.baseline : seed.baseline;
  const node: WorkspaceNodeSnapshot = { node_id: scopeTarget.nodeId, kind, content_state: 'content_ready', current_revision: 0,
    baseline: structuredClone(persistedBaseline), current: structuredClone(persistedBaseline) };
  const revisions: Row[] = [{ revision: 0, origin: 'ai_baseline', parent_revision: null, user_modified: false,
    content: node.baseline, content_hash: hash(node.baseline) }];
  const events: Row[] = [];
  const state = { missing: false, missingArchitecture: false, sqlError: false, logError: false, authorized: true,
    source: 'a'.repeat(64), architecturePayload: assembly as unknown, architectureHash: assembly.assembly_hash,
    commits: 0, rollbacks: 0 };
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push({ sql, params }); let result: Row[];
    if (sql.startsWith('SELECT w.blueprint_id::text')) {
      if (state.sqlError) throw new Error('PRIVATE DATABASE DETAIL');
      result = state.missing ? [] : [{ ...row, current_revision: node.current_revision }];
    } else if (sql.startsWith('SELECT CASE WHEN octet_length')) result = row.blueprint ? [{ blueprint: row.blueprint }] : [];
    else if (sql.startsWith('SELECT r.id::text AS run_id')) result = state.missingArchitecture ? []
      : [{ run_id: runId, payload: state.architecturePayload, artifact_hash: state.architectureHash }];
    else if (sql.startsWith('SELECT id FROM courses')) result = [{ id: target.courseId }];
    else if (sql.startsWith('SELECT w.id,w.status')) result = [{ id: target.workspaceId, status: 'drafting', contract_version: 1, content_locale: locale, correlation_id: uuid(90), source_snapshot_hash: 'a'.repeat(64) }];
    else if (sql.startsWith('SELECT id,kind,content_state')) result = [{ ...node, id: scopeTarget.nodeId, protected_contract: binding, contract_hash: row.contract_hash }];
    else if (sql.startsWith('SELECT revision,parent_revision')) result = revisions.filter(r => r.revision === 0 || r.revision === node.current_revision || r.operation_id === params[5]);
    else if (sql.startsWith('SELECT content,content_hash')) result = revisions.filter(r => r.revision === params[4]);
    else if (sql.startsWith('SELECT 1 AS applied FROM lesson_author_workspace_apply_mappings')) result = [];
    else if (sql.startsWith('INSERT INTO lesson_author_workspace_revisions')) {
      const r = { revision: params[4], parent_revision: params[5], origin: params[6], actor_id: params[7], operation_id: params[8], content: JSON.parse(String(params[9])), content_hash: params[10], validation_contract: params[11], user_modified: params[12] };
      revisions.push(r); node.current_revision = Number(r.revision); node.current = r.content;
      events.push({ ...r, sequence: events.length + 1 }); result = [{ revision: r.revision }];
    } else if (sql.startsWith('SELECT e.sequence,r.revision')) result = events.filter(e => e.operation_id === params[4] && e.revision === params[5]).map(e => ({ ...e, current_revision: node.current_revision }));
    else throw new Error('UNEXPECTED_TEST_QUERY');
    return { rows: structuredClone(result) as T[], rowCount: result.length };
  } };
  const validate = createWorkspaceStoryboardAcceptance(event => { logs.push(event); if (state.logError) throw new Error('PRIVATE LOGGER TEXT'); });
  const context = (): WorkspaceEditContext => ({ target: scopeTarget, correlation_id: uuid(90), content_locale: locale,
    source_snapshot_hash: 'a'.repeat(64), contract_hash: row.contract_hash, protected_contract: binding, node: structuredClone(node) });
  const db: GenerationJobDatabase = { async transaction(work) {
    const before = structuredClone({ node, revisions, events });
    try { const result = await work(tx); state.commits++; return result; }
    catch (e) { Object.assign(node, before.node); revisions.splice(0, revisions.length, ...before.revisions); events.splice(0, events.length, ...before.events); state.rollbacks++; throw e; }
  } };
  const repo = createWorkspaceEditRepository({ db, canEdit: async () => state.authorized, currentSourceHash: async () => state.source, validate });
  async function accept(changes: Record<string, unknown> = { title: 'Author title' }) {
    const ctx = context(); return validate(tx, ctx, prepareWorkspaceEdit(ctx.node, { expected_revision: ctx.node.current_revision, changes }));
  }
  return { target: scopeTarget, blueprint, assembly, identity, seed, binding, logs, queries, row, node, revisions,
    events, state, tx, validate, context, repo, accept };
}

test('all five metadata kinds load scoped Blueprint on the same tx and return honest metadata-only receipts', async () => {
  for (const kind of Object.keys(paths) as WorkspaceStoryboardKind[]) {
    const f = fixture(kind), receipt = await f.accept();
    assert.equal(receipt.validation_contract, kind === 'media_brief' ? WORKSPACE_MEDIA_EDIT : WORKSPACE_AGGREGATE_EDIT);
    assert.deepEqual(receipt.checks, { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'NOT_RUN', registry: 'NOT_APPLICABLE' });
    assert.equal(f.logs[0].status, 'PASS_METADATA_ONLY'); assert.equal(f.logs[0].apply_readiness, 'NOT_EVALUATED');
    assert.deepEqual(f.queries[0].params, [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId, target.nodeId, 'a'.repeat(64)]);
    assert.match(f.queries[0].sql, /FOR SHARE OF w,n/); assert.match(f.queries[0].sql, /event_kind='structure_ready'/);
    assert.match(f.queries[1].sql, /FOR SHARE OF b/);
    assert.ok(f.queries.every(q => q.sql.startsWith('SELECT')));
  }
});
test('all five V2 metadata kinds authenticate the accepted architecture/inventory and support Save → Reset', async () => {
  for (const kind of Object.keys(paths) as WorkspaceStoryboardKind[]) {
    const f = fixture(kind, 'vi', 'v2');
    let saved;
    try { saved = await f.repo.save(f.target, { expected_revision: 0, changes: { title: `V2 ${kind}` } }); }
    catch (error) { throw new Error(`V2 ${kind}: ${error instanceof Error ? error.message : String(error)}`); }
    assert.equal(saved.revision, 1); assert.equal(saved.user_modified, true);
    const reset = await f.repo.reset({ ...f.target, operationId: uuid(81) }, 1);
    assert.equal(reset.revision, 2); assert.equal(reset.user_modified, false);
    assert.deepEqual(f.revisions[0].content, f.revisions[2].content);
    assert.equal(f.queries.some(q => q.sql.startsWith('SELECT CASE WHEN octet_length')), false);
    assert.equal(f.queries.filter(q => q.sql.startsWith('SELECT r.id::text AS run_id')).length, 2);
  }
});
test('V2 metadata Save fails closed on missing/tampered architecture or inventory identity', async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.missingArchitecture = true; },
    f => { f.state.architectureHash = 'f'.repeat(64); },
    f => { f.row.id = uuid(99); },
    f => { f.row.parent_id = uuid(98); },
    f => {
      const changed = { ...f.assembly, source_snapshot_hash: 'd'.repeat(64) };
      const { assembly_hash: _old, ...base } = changed;
      f.state.architecturePayload = { ...base, assembly_hash: orchestrationV2Hash(base) };
      f.state.architectureHash = (f.state.architecturePayload as { assembly_hash: string }).assembly_hash;
    },
  ];
  for (const change of cases) {
    const f = fixture('chapter', 'vi', 'v2'); change(f);
    await assert.rejects(f.repo.save(f.target, { expected_revision: 0, changes: { title: 'Must not persist' } }),
      code('WORKSPACE_CONTRACT_INVALID'));
    assert.equal(f.revisions.length, 1); assert.equal(f.events.length, 0); assert.equal(f.state.rollbacks, 1);
  }
});
test('Save → exact replay → Reset appends revisions and events with actual metadata acceptance in VI/EN', async () => {
  for (const locale of ['vi', 'en'] as const) for (const kind of Object.keys(paths) as WorkspaceStoryboardKind[]) {
    const f = fixture(kind, locale);
    const r = await f.repo.save(target, { expected_revision: 0, changes: { title: 'Tác giả / Author' } });
    assert.equal(r.revision, 1); assert.equal(r.user_modified, true);
    const replay = await f.repo.save(target, { expected_revision: 0, changes: { title: 'Tác giả / Author' } });
    assert.equal(replay.replayed, true); assert.equal(f.revisions.length, 2); assert.equal(f.logs.length, 1);
    const reset = await f.repo.reset({ ...target, operationId: uuid(88) }, 1);
    assert.equal(reset.revision, 2); assert.equal(reset.user_modified, false); assert.equal(f.events.length, 2);
    assert.deepEqual(f.revisions[0].content, f.revisions[2].content);
    assert.ok(f.queries.filter(q => !q.sql.startsWith('SELECT')).every(q => q.sql.startsWith('INSERT INTO lesson_author_workspace_revisions')));
  }
});
test('wrong kind/parent/order/path and missing Blueprint reject at the binding boundary', async () => {
  for (const patch of [{ kind: 'unit' }, { parent_kind: 'unit' }, { parent_path: 'chapter_9' }, { sort_order: 99 },
    { canonical_path: 'chapter_9' }, { blueprint: null }, { contract_hash: 'b'.repeat(64) }]) {
    const f = fixture(); Object.assign(f.row, patch);
    await assert.rejects(f.accept(), code('WORKSPACE_CONTRACT_INVALID'));
    assert.equal(f.logs[0].failure_stage, 'workspace_storyboard_binding');
  }
  const f = fixture(); f.state.missing = true; await assert.rejects(f.accept(), code('WORKSPACE_CONTRACT_INVALID'));
});
test('baseline, sealed references and source architecture cannot drift after metadata binding', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.blueprint.chapters[0].objective = 'Different objective'; },
    (f: ReturnType<typeof fixture>) => { f.binding.readonly_references.source_refs.push('foreign'); f.row.contract_hash = hash(f.binding); },
    (f: ReturnType<typeof fixture>) => { f.node.baseline!.title = 'Different baseline'; },
    (f: ReturnType<typeof fixture>) => { f.blueprint.architecture_contract_version = 4; }]) {
    const f = fixture(); change(f); await assert.rejects(f.accept(), code('WORKSPACE_CONTRACT_INVALID'));
  }
});
test('changed/missing media decision cannot leave an editable phantom brief node', async () => {
  const f = fixture('media_brief'); delete f.blueprint.chapters[0].lessons[0].units[0].media_plan;
  await assert.rejects(f.accept(), code('WORKSPACE_CONTRACT_INVALID'));
  const g = fixture('media_brief'); g.blueprint.media_review = { version: 'media-review-v1', decisions: [{ unit_path: paths.unit, status: 'NOT_NEEDED', reason_code: 'NO_VISUAL' }] };
  await assert.rejects(g.accept(), code('WORKSPACE_CONTRACT_INVALID'));
});
test('candidate hash/revision forgery and component kind reject before scope query', async () => {
  const f = fixture(), ctx = f.context(), candidate = prepareWorkspaceEdit(ctx.node, { expected_revision: 0, changes: { title: 'Title' } });
  for (const patch of [{ parent_revision: 1 }, { content_hash: 'b'.repeat(64) }]) {
    await assert.rejects(f.validate(f.tx, ctx, { ...candidate, ...patch }), code('WORKSPACE_CONTRACT_INVALID'));
  }
  ctx.node.kind = 'component'; await assert.rejects(f.validate(f.tx, ctx, candidate), code('WORKSPACE_CONTRACT_INVALID'));
  assert.equal(f.queries.length, 0);
});
test('invalid content produces typed payload-stage diagnostics and no revision/event', async () => {
  const f = fixture('media_brief');
  await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { data: { content_points: [], context_description: 'Empty points' } } }), code('WORKSPACE_CONTENT_INVALID'));
  assert.equal(f.logs[0].failure_stage, 'workspace_storyboard_payload'); assert.equal(f.logs[0].internal_failure_code, 'WORKSPACE_CONTENT_INVALID');
  assert.equal(f.events.length, 0); assert.equal(f.revisions.length, 1); assert.equal(f.state.rollbacks, 1);
});
test('objective-slot removal cannot change protected local objective identity through metadata Save', async () => {
  const f = fixture('lesson');
  await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { data: { ...(f.seed.baseline.data as object), learning_objectives: [] } } }), code('WORKSPACE_NODE_FIELD_PROTECTED'));
  assert.equal(f.revisions.length, 1);
});
test('permission and source freshness still fence Save/Reset around the metadata validator', async () => {
  const f = fixture(); f.state.authorized = false;
  await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { title: 'No' } }), code('WORKSPACE_EDIT_FORBIDDEN'));
  assert.equal(f.logs.length, 0);
  const g = fixture(); g.state.source = 'b'.repeat(64);
  await assert.rejects(g.repo.reset(target, 0), code('WORKSPACE_SOURCE_CHANGED'));
  assert.equal(g.revisions.length, 1); assert.equal(g.logs.length, 0);
});
test('DB errors preserve a safe unavailable code and never expose SQL/private error text', async () => {
  const f = fixture(); f.state.sqlError = true;
  await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { title: 'Title' } }), code('WORKSPACE_EDIT_UNAVAILABLE'));
  assert.equal(f.logs[0].internal_failure_code, 'WORKSPACE_EDIT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|Synthetic|Author title|src_1|scope_1/);
});
test('success diagnostics retain root correlation, omit all content and tolerate a broken log sink', async () => {
  const f = fixture('media_brief'); f.state.logError = true; await f.accept();
  assert.equal(f.logs[0].correlation_id, uuid(90)); assert.equal(f.logs[0].status, 'PASS_METADATA_ONLY');
  assert.doesNotMatch(JSON.stringify(f.logs), /Synthetic|workstation|Show the|PRIVATE|scope_1/);
});
test('combined acceptance routes exclusively by locked node kind; component cannot use metadata acceptance', async () => {
  const f = fixture(), events: WorkspaceStoryboardDiagnostic[] = [];
  const accept = createWorkspaceAcceptance({ component: () => assert.fail('unexpected component success'), storyboard: e => events.push(e) });
  const ctx = f.context(), candidate = prepareWorkspaceEdit(ctx.node, { expected_revision: 0, changes: { title: 'Changed' } });
  assert.equal((await accept(f.tx, ctx, candidate, new Set())).validation_contract, WORKSPACE_AGGREGATE_EDIT);
  ctx.node.kind = 'component';
  await assert.rejects(accept(f.tx, ctx, { ...candidate, content_hash: 'b'.repeat(64) }, new Set()), code('WORKSPACE_COMPONENT_BINDING_INVALID'));
  assert.equal(events.length, 1);
});
