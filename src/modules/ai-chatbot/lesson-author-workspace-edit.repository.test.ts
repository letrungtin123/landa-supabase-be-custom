import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createWorkspaceEditRepository, workspaceEditChecksAccepted, type WorkspaceEditAcceptance, type WorkspaceEditTarget } from './lesson-author-workspace-edit.repository.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target: WorkspaceEditTarget = { tenantId: uuid(1), userId: uuid(2), conversationId: uuid(3),
  workspaceId: uuid(4), nodeId: uuid(5), operationId: uuid(6), courseId: 'course-v1:TEST+EDIT+2026' };
const sourceHash = 'a'.repeat(64), contract = { component_type: 'html', source_fact_ids: ['synthetic_fact_1'] };
const baseline = { title: 'AI baseline', purpose: null, data: '<p>Synthetic content only.</p>', implementation_notes: null };
type Row = Record<string, any>;
const expectedCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code && error.message === code;

test('V2 component Save does not misreport a deferred semantic/pedagogy check as PASS', () => {
  const acceptance = { validation_contract: 'workspace-component-edit-v2-ready-1',
    checks: { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'NOT_RUN', registry: 'PASS' } } as WorkspaceEditAcceptance;
  assert.equal(workspaceEditChecksAccepted('component', acceptance), true);
  assert.equal(workspaceEditChecksAccepted('component', { ...acceptance,
    checks: { ...acceptance.checks, pedagogy: 'PASS' } }), false);
});

/** Simulates transaction/trigger effects only; NOT PostgreSQL concurrency proof. */
function fixture() {
  let rows: Row[] = [{ revision: 0, parent_revision: null, origin: 'ai_baseline', actor_id: null, operation_id: uuid(99),
    content: structuredClone(baseline), content_hash: generationSnapshotHash(baseline), user_modified: false, validation_contract: 'fixture' }];
  let pointer = 0, sequence = 1, state = 'drafting', permission = true, source = sourceHash, applied = false;
  let corruptReceipt = false, missing = false, invalidProof: Partial<WorkspaceEditAcceptance> | null = null, validationError = false;
  let insertError: unknown = null;
  let revokeDuringValidation = false, driftDuringValidation = false;
  let locale: 'vi' | 'en' = 'vi';
  const events: Row[] = [], sql: Array<{ text: string; params: unknown[] }> = [], stages: string[] = [];
  let tail = Promise.resolve();
  const db: GenerationJobDatabase = { async transaction<T>(work: (tx: GenerationJobSql) => Promise<T>) {
    const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    const before = structuredClone({ rows, pointer, sequence, events });
    const tx: GenerationJobSql = { async query<R extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      sql.push({ text, params }); let result: Row[];
      if (text.startsWith('SELECT id FROM courses')) result = missing ? [] : [{ id: target.courseId }];
      else if (text.includes('FROM lesson_author_session_deletion_jobs')) result = [];
      else if (text.includes('FROM lesson_author_workspaces w')) result = [{ id: target.workspaceId, status: state,
        contract_version: 1, content_locale: locale, correlation_id: uuid(8), source_snapshot_hash: sourceHash }];
      else if (text.includes('FROM lesson_author_workspace_nodes WHERE')) result = [{ id: target.nodeId, kind: 'component',
        content_state: 'content_ready', current_revision: pointer, protected_contract: contract, contract_hash: generationSnapshotHash(contract) }];
      else if (text.startsWith('SELECT revision,parent_revision')) result = rows.filter(r => r.revision === 0 || r.revision === pointer || r.operation_id === params[5]);
      else if (text.startsWith('SELECT content,content_hash')) result = rows.filter(r => r.revision === params[4]);
      else if (text.startsWith('SELECT 1 AS applied FROM lesson_author_workspace_apply_mappings')) result = applied ? [{ applied: 1 }] : [];
      else if (text.startsWith('INSERT INTO lesson_author_workspace_revisions')) {
        stages.push('insert'); if (insertError) throw insertError;
        const r = { revision: params[4], parent_revision: params[5], origin: params[6], actor_id: params[7], operation_id: params[8],
          content: JSON.parse(String(params[9])), content_hash: params[10], validation_contract: params[11], user_modified: params[12] };
        rows.push(r); pointer = Number(r.revision); sequence++;
        events.push({ sequence, revision: r.revision, operation_id: r.operation_id, content_hash: r.content_hash, user_modified: r.user_modified });
        result = [{ revision: r.revision }];
      } else if (text.startsWith('SELECT e.sequence,r.revision')) {
        result = corruptReceipt ? [] : events.filter(e => e.operation_id === params[4] && e.revision === params[5]).map(e => ({ ...e, current_revision: pointer }));
      } else throw new Error('UNEXPECTED MOCK SQL');
      return { rows: structuredClone(result) as R[], rowCount: result.length };
    } };
    try { const result = await work(tx); stages.push('commit'); return result; }
    catch (error) { rows = before.rows; pointer = before.pointer; sequence = before.sequence;
      events.splice(0, events.length, ...before.events); stages.push('rollback'); throw error; }
    finally { release(); }
  } };
  const repo = createWorkspaceEditRepository({ db,
    canEdit: async (_tx, owner) => { stages.push('permission'); assert.equal(owner.userId, target.userId); return permission; },
    currentSourceHash: async (_tx, context) => { stages.push('source'); assert.equal(Object.isFrozen(context.node.baseline), true); return source; },
    validate: async (_tx, context, candidate) => {
      stages.push('validate'); assert.equal(Object.isFrozen(candidate.content), true);
      assert.equal(context.content_locale, locale);
      if (validationError) throw new Error('PRIVATE VALIDATION SOURCE CONTENT');
      if (revokeDuringValidation) permission = false;
      if (driftDuringValidation) source = 'c'.repeat(64);
      return { workspace_id: context.target.workspaceId, node_id: context.target.nodeId, expected_revision: candidate.parent_revision,
        content_hash: candidate.content_hash, contract_hash: context.contract_hash,
        source_snapshot_hash: context.source_snapshot_hash, validation_contract: 'synthetic-acceptance-only-v1',
        checks: { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'PASS', registry: 'PASS' }, ...invalidProof };
    },
  });
  return { repo, sql, stages, rows: () => rows, events: () => events, pointer: () => pointer,
    deny: () => { permission = false; }, missing: () => { missing = true; }, drift: () => { source = 'b'.repeat(64); },
    proof: (value: Partial<WorkspaceEditAcceptance>) => { invalidProof = value; }, failValidation: () => { validationError = true; },
    state: (value: string) => { state = value; }, corruptReceipt: () => { corruptReceipt = true; },
    apply: () => { applied = true; },
    revokeDuringValidation: () => { revokeDuringValidation = true; }, driftDuringValidation: () => { driftDuringValidation = true; },
    locale: (value: 'vi' | 'en') => { locale = value; },
    insertError: (value: unknown) => { insertError = value; } };
}

test('Save validates before append; baseline/provenance untouched, pointer/event committed atomically in mock', async () => {
  const f = fixture(); const result = await f.repo.save(target, { expected_revision: 0, changes: { title: 'Author title' } });
  assert.equal(result.revision, 1); assert.equal(result.current_revision, 1); assert.equal(result.user_modified, true);
  assert.equal(result.event_sequence, 2); assert.equal(result.replayed, false); assert.equal(result.correlation_id, uuid(8));
  assert.deepEqual(f.stages, ['permission', 'source', 'validate', 'permission', 'source', 'insert', 'commit']);
  assert.deepEqual(f.rows()[0].content, baseline); assert.equal(f.rows()[1].actor_id, target.userId);
  assert.equal(f.rows()[1].origin, 'author_edit'); assert.equal(f.events().length, 1);
  assert.ok(f.sql.some(query => query.text.includes('FROM courses')));
  assert.ok(f.sql.some(query => query.text.includes('FROM lesson_author_workspaces')));
  assert.ok(f.sql.some(query => query.text.includes('FROM lesson_author_workspace_nodes')));
  for (const query of f.sql.filter(q => /^(INSERT|UPDATE|DELETE)/.test(q.text))) assert.match(query.text, /^INSERT INTO lesson_author_workspace_revisions/);
  assert.equal('apply_ready' in result, false);
});

test('Reset creates another revision of the immutable baseline and does not Apply/delete history', async () => {
  const f = fixture(); await f.repo.save(target, { expected_revision: 0, changes: { title: 'Edited' } });
  const result = await f.repo.reset({ ...target, operationId: uuid(10) }, 1);
  assert.equal(result.revision, 2); assert.equal(result.user_modified, false);
  assert.deepEqual(f.rows()[2].content, baseline); assert.equal(f.rows()[2].origin, 'author_reset');
  assert.equal(f.rows().length, 3); assert.equal(f.events().length, 2);
  assert.equal(f.stages.filter(s => s === 'validate').length, 2);
});

test('same operation replays after later edits without rewinding pointer or duplicating events', async () => {
  const f = fixture(); const request = { expected_revision: 0, changes: { title: 'First edit' } };
  const first = await f.repo.save(target, request);
  await f.repo.save({ ...target, operationId: uuid(11) }, { expected_revision: 1, changes: { title: 'Second edit' } });
  const replay = await f.repo.save(target, request);
  assert.equal(replay.replayed, true); assert.equal(replay.revision, first.revision); assert.equal(replay.event_sequence, first.event_sequence);
  assert.equal(replay.current_revision, 2); assert.equal(f.pointer(), 2); assert.equal(f.rows().length, 3);
  assert.equal(f.stages.filter(s => s === 'validate').length, 2);
  assert.equal(f.stages.filter(s => s === 'permission').length, 5);
});

test('an applied revision rejects new Save/Reset while an immutable prior operation remains replayable', async () => {
  const f = fixture(); const request = { expected_revision: 0, changes: { title: 'Applied edit' } };
  const first = await f.repo.save(target, request);
  f.apply();
  const replay = await f.repo.save(target, request);
  assert.equal(replay.replayed, true); assert.equal(replay.revision, first.revision);
  await assert.rejects(f.repo.save({ ...target, operationId: uuid(12) },
    { expected_revision: 1, changes: { title: 'Forbidden edit' } }), expectedCode('WORKSPACE_EDIT_STATE_INVALID'));
  await assert.rejects(f.repo.reset({ ...target, operationId: uuid(13) }, 1), expectedCode('WORKSPACE_EDIT_STATE_INVALID'));
  assert.equal(f.rows().length, 2); assert.equal(f.events().length, 1);
});

test('EN/VI edits preserve author text and a Reset replay creates no extra revision', async () => {
  for (const locale of ['vi', 'en'] as const) {
    const f = fixture(); f.locale(locale);
    const title = locale === 'vi' ? 'Tên tác giả chỉnh sửa' : 'Author-edited title';
    await f.repo.save(target, { expected_revision: 0, changes: { title } });
    assert.equal(f.rows()[1].content.title, title);
    const resetTarget = { ...target, operationId: uuid(19) };
    await f.repo.reset(resetTarget, 1);
    const replay = await f.repo.reset(resetTarget, 1);
    assert.equal(replay.replayed, true); assert.equal(f.rows().length, 3);
    assert.deepEqual(f.rows()[2].content, baseline);
  }
});

test('operation ID reused for different content/operation cannot authorize a second write', async () => {
  const f = fixture(); await f.repo.save(target, { expected_revision: 0, changes: { title: 'First' } });
  await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { title: 'Second' } }), expectedCode('WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.repo.reset(target, 0), expectedCode('WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT'));
  assert.equal(f.rows().length, 2); assert.equal(f.events().length, 1);
});

test('concurrent stale saves serialize, exactly one commits (mock transaction scheduler)', async () => {
  const f = fixture(); const settled = await Promise.allSettled([
    f.repo.save(target, { expected_revision: 0, changes: { title: 'A' } }),
    f.repo.save({ ...target, operationId: uuid(12) }, { expected_revision: 0, changes: { title: 'B' } }),
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  const failure = settled.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code, 'WORKSPACE_REVISION_CONFLICT'); assert.equal(f.rows().length, 2);
});

test('permission revoked/source changed/missing course deny before revision insertion', async () => {
  for (const [mode, code] of [['deny', 'WORKSPACE_EDIT_FORBIDDEN'], ['drift', 'WORKSPACE_SOURCE_CHANGED'], ['missing', 'WORKSPACE_EDIT_NOT_FOUND']] as const) {
    const f = fixture(); f[mode]();
    await assert.rejects(f.repo.save(target, { expected_revision: 0, changes: { title: 'No' } }), expectedCode(code));
    assert.equal(f.rows().length, 1); assert.equal(f.stages.includes('validate'), false);
  }
});

test('failed/canceled workspace cannot accept a fresh revision', async () => {
  for (const state of ['failed', 'canceled', 'designing', 'queued']) {
    const f = fixture(); f.state(state);
    await assert.rejects(f.repo.reset(target, 0), expectedCode('WORKSPACE_EDIT_STATE_INVALID'));
    assert.equal(f.rows().length, 1);
  }
});

test('all validation checks and exact source/contract/content hash binding are required', async () => {
  const good: WorkspaceEditAcceptance['checks'] = { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'PASS', registry: 'PASS' };
  for (const proof of [{ workspace_id: uuid(123) }, { node_id: uuid(123) }, { expected_revision: 99 },
    { content_hash: 'wrong' }, { contract_hash: 'wrong' }, { source_snapshot_hash: 'wrong' }, { validation_contract: '' },
    ...Object.keys(good).map(key => ({ checks: { ...good, [key]: 'NOT_RUN' } as typeof good }))]) {
    const f = fixture(); f.proof(proof);
    await assert.rejects(f.repo.reset(target, 0), expectedCode('WORKSPACE_EDIT_VALIDATION_REQUIRED'));
    assert.equal(f.rows().length, 1); assert.equal(f.stages.includes('insert'), false);
  }
});

test('authority changes during validation prevent insertion despite a formerly valid acceptance receipt', async () => {
  for (const [mode, code] of [['revokeDuringValidation', 'WORKSPACE_EDIT_FORBIDDEN'], ['driftDuringValidation', 'WORKSPACE_SOURCE_CHANGED']] as const) {
    const f = fixture(); f[mode]();
    await assert.rejects(f.repo.reset(target, 0), expectedCode(code));
    assert.equal(f.rows().length, 1); assert.equal(f.stages.includes('insert'), false);
  }
});

test('protected-field mutations fail before validator, including replay attempts', async () => {
  const f = fixture();
  for (const changes of [{ source_fact_ids: ['x'] }, { type: 'problem' }, { data: { primary_evidence_scope_ids: ['x'] } }]) {
    await assert.rejects(f.repo.save(target, { expected_revision: 0, changes }), expectedCode('WORKSPACE_NODE_FIELD_PROTECTED'));
  }
  assert.equal(f.stages.includes('validate'), false); assert.equal(f.rows().length, 1);
});

test('read-back failure rolls back inserted revision/pointer/event in mock transaction', async () => {
  const f = fixture(); f.corruptReceipt();
  await assert.rejects(f.repo.reset(target, 0), expectedCode('WORKSPACE_EDIT_COMMIT_INVALID'));
  assert.equal(f.rows().length, 1); assert.equal(f.pointer(), 0); assert.equal(f.events().length, 0);
  assert.equal(f.stages.at(-1), 'rollback');
});

test('invalid baseline hash is rejected before content acceptance or writes', async () => {
  const f = fixture(); f.rows()[0].content_hash = 'bad';
  await assert.rejects(f.repo.reset(target, 0), expectedCode('WORKSPACE_EDIT_CONTRACT_INVALID'));
  assert.equal(f.stages.includes('validate'), false);
});

test('DB/validator exceptions are safe, serialization conflict does not auto-retry', async () => {
  const f = fixture(); f.failValidation();
  await assert.rejects(f.repo.reset(target, 0), expectedCode('WORKSPACE_EDIT_VALIDATION_REQUIRED'));
  for (const [err, expected] of [[Object.assign(new Error('PRIVATE SQL'), { code: '40001' }), 'WORKSPACE_REVISION_CONFLICT'],
    [new Error('PRIVATE DB CONTENT'), 'WORKSPACE_EDIT_UNAVAILABLE']] as const) {
    const failure = fixture(); failure.insertError(err);
    await assert.rejects(failure.repo.reset(target, 0), expectedCode(expected));
    assert.equal(failure.stages.filter(stage => stage === 'insert').length, 1);
    assert.equal(failure.rows().length, 1);
  }
});

test('edit repository has no live DB/provider/HTTP or direct course mutation imports', () => {
  const source = readFileSync(new URL('./lesson-author-workspace-edit.repository.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:config\/database|chat\.service|provider|gemini)/);
  assert.doesNotMatch(source, /\b(?:UPDATE|DELETE FROM|INSERT INTO) (?:courses|course_blocks|lesson_author_workspace_nodes|lesson_author_workspace_events)\b/);
  const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /createWorkspaceEditRepository/);
});
