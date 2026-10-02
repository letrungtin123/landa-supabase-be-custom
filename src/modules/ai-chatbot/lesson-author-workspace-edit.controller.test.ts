import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createWorkspaceEditHandlers, type WorkspaceEditDiagnostic } from './lesson-author-workspace-edit.controller.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { lessonAuthorSourceSnapshotHash } from './lesson-author-source-snapshot.logic.js';
import { editWorkspaceComponent, WorkspaceComponentError } from './lesson-author-workspace-component.logic.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { AuthUser } from '../../types/express.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'staff', sessionMode: 'normal', username: 'synthetic' };
const params = { workspaceId: uuid(3), conversationId: uuid(4), courseId: 'course-v1:TEST+HTTP+2026', nodeId: uuid(5) };
const root = uuid(6), kb = uuid(7), bot = uuid(8);
const blueprint = uuid(20);
const source = { document_id: uuid(9), name: 'Synthetic.pdf', status: 'learned', type: 'file', updated_at: '2026-09-29T00:00:00.000Z', source_info: null };
const sourceHash = lessonAuthorSourceSnapshotHash({ tenantId: user.tenantId!, courseId: params.courseId }, kb, [source]);
const contract = { component_type: 'html', source_fact_ids: ['synthetic_fact'] };
const baseline = { title: 'AI title', purpose: null, data: '<p>This is synthetic instructional content for an offline test only.</p>', implementation_notes: null };
type Row = Record<string, any>;

/** Actual HTTP/repository/authority code, but in-memory SQL/trigger semantics
 * and a FIXTURE acceptance gate. NOT live DB, real JWT or production proof. */
function fixture() {
  let rows: Row[] = [{ revision: 0, parent_revision: null, origin: 'ai_baseline', actor_id: null, operation_id: uuid(90),
    content: structuredClone(baseline), content_hash: generationSnapshotHash(baseline), user_modified: false, validation_contract: 'fixture' }];
  let events: Row[] = [], pointer = 0;
  const state = { enabled: true, grant: true, settings: { course_authoring: { allowed_component_types: ['html'] } },
    sourceChanged: false, validatorError: false, invalidProof: false, loggerError: false, transactions: 0, validations: 0, inserts: 0 };
  const calls: Array<{ sql: string; params: unknown[] }> = [], logs: WorkspaceEditDiagnostic[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, p: unknown[] = []) {
    calls.push({ sql, params: p }); let result: Row[];
    if (sql.includes('FROM users u')) result = [{ role: user.role, tenant_id: user.tenantId, is_active: true, tenant_active: true }];
    else if (sql.includes('FROM user_permission_groups')) result = [{ can_edit: state.grant }];
    else if (sql.startsWith('SELECT settings')) result = [{ settings: state.settings }];
    else if (sql.startsWith('SELECT id FROM courses')) result = [{ id: params.courseId }];
    else if (sql.includes('FROM lesson_author_workspaces w')) result = p[0] === params.workspaceId && p[1] === user.tenantId && p[3] === params.conversationId && p[4] === user.id
      ? [{ id: params.workspaceId, status: 'drafting', contract_version: 1, content_locale: 'vi', correlation_id: root, source_snapshot_hash: sourceHash,
        blueprint_id: blueprint, blueprint_source_hash: sourceHash, bot_id: bot, kb_id: kb, source_document_ids: [source.document_id] }] : [];
    else if (sql.includes('FROM lesson_author_blueprints b')) result = [{ id: blueprint }];
    else if (sql.includes('FROM tenant_bot_assignments')) result = [{ bot_id: bot }];
    else if (sql.includes('FROM tenant_kb_assignments')) result = [{ kb_id: kb }];
    else if (sql.includes('FROM kb_documents')) result = [{ ...source, updated_at: state.sourceChanged ? '2026-09-30T00:00:00.000Z' : source.updated_at }];
    else if (sql.includes('FROM lesson_author_workspace_nodes WHERE')) result = [{ id: params.nodeId, kind: 'component', content_state: 'content_ready', current_revision: pointer,
      protected_contract: contract, contract_hash: generationSnapshotHash(contract) }];
    else if (sql.startsWith('SELECT revision,parent_revision')) result = rows.filter(r => r.revision === 0 || r.revision === pointer || r.operation_id === p[5]);
    else if (sql.startsWith('SELECT content,content_hash')) result = rows.filter(r => r.revision === p[4]);
    else if (sql.startsWith('SELECT 1 AS applied FROM lesson_author_workspace_apply_mappings')) result = [];
    else if (sql.startsWith('INSERT INTO lesson_author_workspace_revisions')) {
      state.inserts++;
      const row = { revision: p[4], parent_revision: p[5], origin: p[6], actor_id: p[7], operation_id: p[8], content: JSON.parse(String(p[9])),
        content_hash: p[10], validation_contract: p[11], user_modified: p[12] };
      rows.push(row); pointer = Number(p[4]); events.push({ ...row, sequence: events.length + 1 }); result = [{ revision: pointer }];
    } else if (sql.startsWith('SELECT e.sequence,r.revision')) result = events.filter(e => e.operation_id === p[4] && e.revision === p[5]).map(e => ({ ...e, current_revision: pointer }));
    else throw new Error('Unexpected mock query');
    return { rows: structuredClone(result) as T[], rowCount: result.length };
  } };
  const handlers = createWorkspaceEditHandlers({ enabled: () => state.enabled,
    db: { async transaction(work) { state.transactions++; const before = structuredClone({ rows, events, pointer });
      try { return await work(tx); } catch (e) { rows = before.rows; events = before.events; pointer = before.pointer; throw e; } } },
    validate: async (receivedTx, context, candidate, allowed) => {
      assert.equal(receivedTx, tx); state.validations++;
      if (state.validatorError) throw new WorkspaceComponentError('WORKSPACE_COMPONENT_REFERENCE_INVALID');
      editWorkspaceComponent({ type: 'html', title: baseline.title, data: baseline.data }, candidate.content, allowed);
      // Fixture-only receipt; real scope materializer is deliberately absent.
      return { workspace_id: params.workspaceId, node_id: params.nodeId, expected_revision: candidate.parent_revision,
        content_hash: state.invalidProof ? 'b'.repeat(64) : candidate.content_hash, source_snapshot_hash: context.source_snapshot_hash,
        contract_hash: context.contract_hash, validation_contract: 'fixture-only', checks: { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'PASS', registry: 'PASS' } };
    }, report: record => { logs.push(record); if (state.loggerError) throw new Error('log failed'); } });
  async function invoke(operation: 'save' | 'reset' = 'save', overrides: Partial<Request> = {}) {
    const req = { user, params, query: { ui_locale: 'en' }, body: { expected_revision: 0, operation_id: uuid(10), changes: { title: 'Author title' } }, ...overrides } as Request;
    let status = 200, body: any; const headers: Record<string, string> = {};
    const res = { setHeader(key: string, value: string) { headers[key] = value; }, status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } } as unknown as Response;
    await handlers[operation](req, res); return { status, body, headers };
  }
  return { handlers, state, logs, calls, invoke, rows: () => rows };
}
test('Save uses current actor/tenant authority and returns a committed receipt without exposing content', async () => {
  const f = fixture(), r = await f.invoke();
  assert.equal(r.status, 200); assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.body.data.correlation_id, root); assert.notEqual(r.body.request_id, root);
  assert.equal(r.body.data.revision, 1); assert.equal(r.body.data.user_modified, true);
  assert.equal(f.state.inserts, 1); assert.equal(f.state.validations, 1);
  assert.equal(f.logs[0].event, 'workspace_edit_completed'); assert.equal(f.logs[0].correlation_id, root);
  assert.equal(f.logs[0].expected_revision, 0); assert.equal(f.logs[0].content_revision, 1);
  assert.equal(f.logs[0].event_sequence, 1); assert.equal(f.logs[0].replayed, false);
  assert.doesNotMatch(JSON.stringify([r.body, f.logs]), /synthetic instructional|Author title|AI title|Synthetic.pdf/);
});
test('Reset and repeated operations create no Apply, no overwrite and no duplicate revision', async () => {
  const f = fixture(); await f.invoke();
  const replay = await f.invoke(); assert.equal(replay.body.data.replayed, true); assert.equal(f.state.inserts, 1);
  const reset = await f.invoke('reset', { body: { operation_id: uuid(11), expected_revision: 1 } });
  assert.equal(reset.status, 200); assert.equal(reset.body.data.user_modified, false);
  assert.deepEqual(f.rows()[2].content, baseline); assert.deepEqual(f.rows()[0].content, baseline);
  assert.equal(f.state.inserts, 2);
  assert.ok(f.calls.filter(c => !c.sql.trimStart().startsWith('SELECT')).every(c => c.sql.startsWith('INSERT INTO lesson_author_workspace_revisions')));
});
test('missing auth, learner/demo or disabled feature never opens a transaction', async () => {
  for (const overrides of [{ user: undefined }, { user: { ...user, role: 'learner' as const } }, { user: { ...user, sessionMode: 'demo_iframe' as const } }]) {
    const f = fixture(), r = await f.invoke('save', overrides); assert.ok([401, 403].includes(r.status)); assert.equal(f.state.transactions, 0);
  }
  const f = fixture(); f.state.enabled = false; assert.equal((await f.invoke()).status, 503); assert.equal(f.state.transactions, 0);
});
test('forged identity, proof, unknown fields and malformed revisions fail before SQL', async () => {
  for (const patch of [{ tenant_id: uuid(80) }, { validation: { schema: 'PASS' } }, { expected_revision: '0' },
    { expected_revision: -1 }, { operation_id: 'invalid' }, { changes: { source_fact_ids: ['private'] } }, { changes: {} }]) {
    const f = fixture(), r = await f.invoke('save', { body: { operation_id: uuid(10), expected_revision: 0, changes: { title: 'new' }, ...patch } });
    assert.equal(r.status, 400); assert.equal(f.state.transactions, 0);
  }
  const f = fixture(); assert.equal((await f.invoke('reset')).status, 400);
  assert.equal((await f.invoke('save', { query: { ui_locale: ['en'] } })).status, 400);
});
test('oversized payload fails before transaction and logs never contain author text', async () => {
  const f = fixture(), r = await f.invoke('save', { body: { operation_id: uuid(10), expected_revision: 0, changes: { data: 'PRIVATE'.repeat(400_000) } } });
  assert.equal(r.status, 400); assert.equal(f.state.transactions, 0); assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
});
test('current permission revocation and foreign workspace are rejected without validation/write', async () => {
  const f = fixture(); f.state.grant = false; assert.equal((await f.invoke()).status, 403); assert.equal(f.state.validations, 0);
  const other = fixture(); const r = await other.invoke('save', { params: { ...params, workspaceId: uuid(90) } });
  assert.equal(r.status, 404); assert.equal(other.state.validations, 0); assert.equal(other.logs[0].correlation_id, null);
});
test('source drift and typed component rejection retain root correlation with safe external errors', async () => {
  const sourceFailure = fixture(); sourceFailure.state.sourceChanged = true;
  assert.equal((await sourceFailure.invoke()).status, 409); assert.equal(sourceFailure.state.inserts, 0);
  assert.equal(sourceFailure.logs[0].correlation_id, root); assert.equal(sourceFailure.logs[0].internal_failure_code, 'WORKSPACE_SOURCE_CHANGED');
  const f = fixture(); f.state.validatorError = true; const r = await f.invoke();
  assert.equal(r.status, 422); assert.equal(r.body.code, 'WORKSPACE_EDIT_VALIDATION_REQUIRED');
  assert.equal(f.logs[0].internal_failure_code, 'WORKSPACE_COMPONENT_REFERENCE_INVALID');
  assert.equal(f.logs[0].correlation_id, root); assert.equal(f.logs[0].failure_stage, 'workspace_edit_transaction');
  assert.equal(f.state.inserts, 0);
});
test('invalid server proof, stale revision and reused operation with changed content cannot save', async () => {
  const bad = fixture(); bad.state.invalidProof = true; assert.equal((await bad.invoke()).status, 422); assert.equal(bad.state.inserts, 0);
  const f = fixture(); await f.invoke();
  const stale = await f.invoke('save', { body: { operation_id: uuid(11), expected_revision: 0, changes: { title: 'Next' } } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'WORKSPACE_REVISION_CONFLICT');
  const reused = await f.invoke('save', { body: { operation_id: uuid(10), expected_revision: 0, changes: { title: 'Different' } } });
  assert.equal(reused.status, 409); assert.equal(reused.body.code, 'WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT'); assert.equal(f.state.inserts, 1);
});
test('EN/VI messages do not change stored locale; logger failure cannot turn committed Save into retry', async () => {
  const en = fixture(), vi = fixture(); en.state.sourceChanged = true; vi.state.sourceChanged = true;
  const a = await en.invoke(), b = await vi.invoke('save', { query: { ui_locale: 'vi' } });
  assert.equal(a.body.code, b.body.code); assert.match(a.body.message, /source/i); assert.match(b.body.message, /nguồn/);
  const f = fixture(); f.state.loggerError = true; assert.equal((await f.invoke()).status, 200); assert.equal(f.state.inserts, 1);
});
test('actual Express Save→Reset uses JSON/no-store receipts with synthetic auth and mock DB only', async () => {
  const f = fixture(), app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = user; next(); });
  const path = '/workspaces/:workspaceId/conversations/:conversationId/courses/:courseId/nodes/:nodeId';
  app.post(`${path}/save`, f.handlers.save); app.post(`${path}/reset`, f.handlers.reset);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspaces/${params.workspaceId}/conversations/${params.conversationId}/courses/${encodeURIComponent(params.courseId)}/nodes/${params.nodeId}`;
    const save = await fetch(`${base}/save?ui_locale=en`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: uuid(10), expected_revision: 0, changes: { title: 'Edited' } }) });
    assert.equal(save.status, 200); assert.equal(save.headers.get('cache-control'), 'no-store');
    const reset = await fetch(`${base}/reset?ui_locale=vi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation_id: uuid(11), expected_revision: 1 }) });
    assert.equal(reset.status, 200); assert.equal((await reset.json() as any).data.user_modified, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('runtime Save/Reset requires real persisted acceptance and separate default-off edit/read gates', () => {
  const handler = readFileSync(new URL('./lesson-author-workspace-edit.controller.ts', import.meta.url), 'utf8');
  assert.match(handler, /validate: \(tx: GenerationJobSql/); assert.match(handler, /await authority.allowedComponents/);
  assert.doesNotMatch(handler, /LESSON_AUTHOR_WORKSPACE_READ_ENABLED/);
  const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /enabled: \(\) => env\.LESSON_AUTHOR_WORKSPACE_READ_ENABLED && env\.LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED/);
  assert.match(routes, /validate: createWorkspaceAcceptance\(/);
  assert.match(routes, /db: \{ transaction: withDatabaseTransaction \}/);
  assert.match(routes, /router\.post\(`\$\{workspaceReadPath\}\/nodes\/:nodeId\/save`, workspaceEdits\.save\)/);
  assert.match(routes, /router\.post\(`\$\{workspaceReadPath\}\/nodes\/:nodeId\/reset`, workspaceEdits\.reset\)/);
  assert.ok(routes.indexOf('router.use(authenticate)') < routes.indexOf('const workspaceEdits'));
  assert.ok(routes.indexOf('router.use(tenantContext)') < routes.indexOf('const workspaceEdits'));
  const env = readFileSync(new URL('../../config/env.ts', import.meta.url), 'utf8');
  assert.match(env, /LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: optionalBoolean\('LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED', false\)/);
});
