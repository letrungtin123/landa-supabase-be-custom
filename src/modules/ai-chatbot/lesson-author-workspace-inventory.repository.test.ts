import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceInventoryRepository, type WorkspaceInventoryDiagnostic } from './lesson-author-workspace-inventory.repository.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { workspaceId: uuid(1), tenantId: uuid(2), courseId: 'course-v1:TEST+INVENTORY+2026', conversationId: uuid(3), userId: uuid(4), blueprintId: uuid(5), operationId: uuid(6) };
type Row = Record<string, any>;
function fixture(unitCount = 2) {
  const blueprint = workspaceInventoryFixture(unitCount);
  const w: Row = { id: target.workspaceId, status: 'designing', blueprint_id: null, source_snapshot_hash: 'a'.repeat(64), content_locale: 'vi', correlation_id: uuid(7) };
  const nodes: Row[] = [], revisions: Row[] = [], events: Row[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [], logs: WorkspaceInventoryDiagnostic[] = [];
  const state = { authorized: true, source: 'a'.repeat(64), sourceCalls: 0, failAtInsert: 0, missing: false, corruptReadback: false,
    corruptBody: false, revokeOnReadback: false, driftOnReadback: false, commits: 0, rollbacks: 0, loggerError: false };
  const sql: GenerationJobSql = { async query<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
    queries.push({ sql: query, params }); let rows: Row[];
    if (query.startsWith('SELECT id FROM courses')) rows = [{ id: target.courseId }];
    else if (query.startsWith('SELECT w.id,w.status')) rows = state.missing ? [] : [w];
    else if (query.startsWith('SELECT event_kind,sequence')) rows = events.filter(e => ['overview_ready', 'structure_ready'].includes(e.event_kind));
    else if (query.startsWith('SELECT CASE WHEN')) rows = [{ blueprint }];
    else if (query.startsWith('SELECT count(*)::text AS node_count')) rows = [{ node_count: String(nodes.length), bytes: String(Buffer.byteLength(JSON.stringify(nodes) + JSON.stringify(revisions))) }];
    else if (query.startsWith('SELECT count(*)')) rows = [{ count: String(nodes.length) }];
    else if (query.startsWith('UPDATE lesson_author_workspaces')) { w.status = 'drafting'; w.blueprint_id = params[1]; rows = [{ id: w.id }]; }
    else if (query.startsWith('INSERT INTO lesson_author_workspace_nodes')) {
      rows = [];
      for (const value of JSON.parse(String(params[0]))) {
        if (state.failAtInsert && nodes.length + 1 === state.failAtInsert) throw new Error('PRIVATE DATABASE ERROR');
        assert.ok(value.parent_id === null || nodes.some(n => n.id === value.parent_id), 'parent precedes child');
        const n = { ...value, current_revision: null, content_state: 'planned' };
        nodes.push(n); rows.push({ id: n.id });
      }
    } else if (query.startsWith('INSERT INTO lesson_author_workspace_revisions')) {
      rows = [];
      for (const value of JSON.parse(String(params[0]))) {
        const r = { ...value, revision: 0 };
        revisions.push(r); Object.assign(nodes.find(n => n.id === r.node_id)!, { current_revision: 0, content_state: 'content_ready' });
        events.push({ event_kind: 'node_revision_saved', sequence: events.length + 1 }); rows.push({ node_id: r.node_id, revision: 0 });
      }
    } else if (query.startsWith('INSERT INTO lesson_author_workspace_events')) {
      const event = { event_kind: params[3], sequence: events.length + 1 }; events.push(event); rows = [event];
    } else if (query.startsWith('SELECT n.id,n.parent_id')) {
      rows = nodes.map(n => ({ ...n, baseline_hash: revisions.find(r => r.node_id === n.id)?.content_hash ?? null,
        baseline_content: revisions.find(r => r.node_id === n.id)?.content ?? null }));
      if (state.corruptReadback) rows[0].contract_hash = 'b'.repeat(64);
      if (state.corruptBody) rows[0].protected_contract = { changed: true };
      if (state.revokeOnReadback) state.authorized = false;
      if (state.driftOnReadback) state.source = 'b'.repeat(64);
    } else throw new Error('UNEXPECTED_TEST_QUERY');
    return { rows: structuredClone(rows) as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction(work) {
    const before = structuredClone({ w, nodes, revisions, events });
    try { const result = await work(sql); state.commits++; return result; }
    catch (e) { Object.assign(w, before.w); nodes.splice(0, nodes.length, ...before.nodes); revisions.splice(0, revisions.length, ...before.revisions); events.splice(0, events.length, ...before.events); state.rollbacks++; throw e; }
  } };
  const repo = createWorkspaceInventoryRepository({ db, canEdit: async () => state.authorized,
    currentSourceHash: async () => { state.sourceCalls++; return state.source; }, allowedComponents: async () => new Set<CourseComponentType>(['html']),
    report: event => { logs.push(event); if (state.loggerError) throw new Error('PRIVATE LOGGER'); } });
  return { blueprint, w, nodes, revisions, events, queries, logs, state, repo };
}
test('stored valid V5 → metadata baselines → overview → sealed inventory; units/components remain planned', async () => {
  const f = fixture(), receipt = await f.repo.publish(target);
  assert.equal(receipt.node_count, 7); assert.equal(receipt.unit_count, 2); assert.equal(receipt.replayed, false);
  assert.equal(f.w.status, 'drafting'); assert.equal(f.revisions.length, 3);
  assert.deepEqual(f.events.slice(-2).map(e => e.event_kind), ['overview_ready', 'structure_ready']);
  assert.equal(f.nodes.filter(n => n.content_state === 'planned').length, 4);
  assert.equal(f.state.sourceCalls, 2); assert.equal(f.logs.at(-1)?.status, 'COMMITTED');
  const writes = f.queries.filter(q => /^(INSERT|UPDATE)/.test(q.sql));
  assert.ok(writes.every(q => /^(INSERT INTO|UPDATE) lesson_author_workspace/.test(q.sql)));
  assert.equal(JSON.stringify(f.logs).includes(f.blueprint.summary), false);
});
test('exact replay preserves node IDs, authored revisions and generated units without new writes', async () => {
  const f = fixture(); const first = await f.repo.publish(target), ids = f.nodes.map(n => n.id);
  f.nodes[0].current_revision = 4; f.w.status = 'needs_action';
  const count = f.queries.length; const second = await f.repo.publish({ ...target, operationId: uuid(8) });
  assert.equal(second.replayed, true); assert.equal(second.inventory_hash, first.inventory_hash);
  assert.deepEqual(f.nodes.map(n => n.id), ids); assert.equal(f.nodes[0].current_revision, 4);
  assert.ok(f.queries.slice(count).every(q => q.sql.startsWith('SELECT')));
});
test('missing authorization and cross-owner resolution fail before inventory writes', async () => {
  for (const field of ['authorized', 'missing'] as const) {
    const f = fixture(); f.state[field] = field === 'missing';
    await assert.rejects(f.repo.publish(target), /WORKSPACE_PUBLICATION_FORBIDDEN/);
    assert.equal(f.nodes.length, 0); assert.equal(f.logs[0].correlation_id, null);
  }
});
test('source drift rolls back Blueprint binding and leaves no visible inventory', async () => {
  const f = fixture(); f.state.source = 'b'.repeat(64);
  await assert.rejects(f.repo.publish(target), /WORKSPACE_PUBLICATION_SOURCE_CHANGED/);
  assert.equal(f.w.blueprint_id, null); assert.equal(f.w.status, 'designing'); assert.equal(f.nodes.length, 0);
  assert.equal(f.logs[0].correlation_id, uuid(7)); assert.equal(f.state.rollbacks, 1);
});
test('actual architecture rejection logs safe codes and never binds invalid Blueprint', async () => {
  const f = fixture(); f.blueprint.source_fact_allocation!.complete = false;
  await assert.rejects(f.repo.publish(target), /WORKSPACE_PUBLICATION_BLUEPRINT_INVALID/);
  assert.ok(f.logs[0].validation_codes.includes('SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID'));
  assert.equal(f.w.blueprint_id, null); assert.equal(f.nodes.length, 0);
});
test('failure between node inserts or read-back mismatch rolls entire inventory back', async () => {
  for (const badReadback of [false, true]) {
    const f = fixture(); f.state.corruptReadback = badReadback; if (!badReadback) f.state.failAtInsert = 5;
    await assert.rejects(f.repo.publish(target), badReadback ? /WORKSPACE_PUBLICATION_READBACK_INVALID/ : /WORKSPACE_PUBLICATION_UNAVAILABLE/);
    assert.equal(f.nodes.length, 0); assert.equal(f.revisions.length, 0); assert.equal(f.events.length, 0); assert.equal(f.w.status, 'designing');
    assert.equal(JSON.stringify(f.logs).includes('PRIVATE'), false);
  }
});
test('partial prior inventory, partial seal or wrong Blueprint binding cannot be repaired by overwrite', async () => {
  for (const mutation of [(f: ReturnType<typeof fixture>) => f.nodes.push({ id: uuid(9) }),
    (f: ReturnType<typeof fixture>) => f.events.push({ event_kind: 'overview_ready', sequence: 1 }),
    (f: ReturnType<typeof fixture>) => { f.w.blueprint_id = uuid(9); }]) {
    const f = fixture(); mutation(f);
    await assert.rejects(f.repo.publish(target), /WORKSPACE_PUBLICATION_CONFLICT/);
    assert.ok(f.queries.every(q => q.sql.startsWith('SELECT')));
  }
});
test('modified stored architecture does not silently change a sealed inventory', async () => {
  const f = fixture(); await f.repo.publish(target);
  f.blueprint.title = 'Changed outside workspace'; const count = f.queries.length;
  await assert.rejects(f.repo.publish(target), /WORKSPACE_PUBLICATION_READBACK_INVALID/);
  assert.ok(f.queries.slice(count).every(q => q.sql.startsWith('SELECT')));
});
test('safe diagnostics failure cannot turn committed publication into retry or rollback', async () => {
  const f = fixture(); f.state.loggerError = true;
  const result = await f.repo.publish(target); assert.equal(result.node_count, 7); assert.equal(f.state.commits, 1);
});
test('1001-fact publication uses bounded parent-first batches, not one network round trip per node', async () => {
  const f = fixture(1001), receipt = await f.repo.publish(target);
  assert.ok(receipt.node_count > 2000);
  const writes = f.queries.filter(q => q.sql.startsWith('INSERT INTO lesson_author_workspace_nodes'));
  assert.ok(writes.length < 40);
  assert.ok(writes.every(q => JSON.parse(String(q.params[0])).length <= 64 && Buffer.byteLength(String(q.params[0])) <= 1024 * 1024));
});
test('actual stored binding bytes and fresh authority/source are checked before committing publication', async () => {
  for (const field of ['corruptBody', 'revokeOnReadback', 'driftOnReadback'] as const) {
    const f = fixture(); f.state[field] = true;
    await assert.rejects(f.repo.publish(target), field === 'corruptBody' ? /WORKSPACE_PUBLICATION_READBACK_INVALID/
      : field === 'revokeOnReadback' ? /WORKSPACE_PUBLICATION_FORBIDDEN/ : /WORKSPACE_PUBLICATION_SOURCE_CHANGED/);
    assert.equal(f.nodes.length, 0); assert.equal(f.events.length, 0); assert.equal(f.w.blueprint_id, null);
  }
});
