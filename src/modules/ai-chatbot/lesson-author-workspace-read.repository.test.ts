import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { createWorkspaceReadRepository, type WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(1), nodeId = uuid(2);
const owner: WorkspaceReadOwner = { tenantId: uuid(3), userId: uuid(4), conversationId: uuid(5), courseId: 'course-v1:TEST+WS+2026' };
const content = { title: 'Giải thích / Explain', purpose: null, data: { html: '<p>Synthetic evidence.</p>' }, implementation_notes: null };
const common = { id: workspaceId, correlation_id: uuid(6), contract_version: 1,
  content_locale: 'vi', status: 'drafting', event_head: '3', updated_at: new Date('2026-09-29T10:00:00Z') };
function fixture(initial: Record<string, unknown> | null) {
  let row = initial, allowed = true, failure: Error | null = null, authFailure: Error | null = null;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const permissions: WorkspaceReadOwner[] = [];
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    if (failure) throw failure;
    return { rows: (row ? [structuredClone(row)] : []) as T[], rowCount: row ? 1 : 0 };
  } };
  const repo = createWorkspaceReadRepository({ db, canRead: async scope => {
    permissions.push(scope);
    assert.equal(Object.isFrozen(scope), true);
    if (authFailure) throw authFailure;
    return allowed;
  } });
  return { repo, calls, permissions, deny: () => { allowed = false; }, row: (value: Record<string, unknown> | null) => { row = value; },
    fail: () => { failure = new Error('PRIVATE SQL connection credentials'); },
    failAuth: () => { authFailure = new Error('PRIVATE authorization details'); } };
}
const summary = () => ({ ...common, node_count: '25', unit_count: '5', ready_unit_count: '2',
  failure_code: null, failure_stage: null, failure_chapter_key: null });
const detail = () => ({ ...common, node_id: nodeId, parent_id: uuid(7), kind: 'component', content_state: 'content_ready',
  current_revision: '1', content, content_hash: generationSnapshotHash(content), user_modified: true, validation_contract: 'fixture-only-v1' });
const event = (n: number) => ({ sequence: n, event_kind: 'unit_started', node_id: nodeId, node_revision: null,
  operation_id: uuid(10 + n), created_at: '2026-09-29T10:00:00Z' });
const code = (value: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === value && error.message === value;

test('detail exposes only typed presentation discriminants, never infers type from content or leaks binding', async () => {
  const f = fixture({ ...detail(), component_type: 'html', protected_contract: { private: 'PRIVATE' } });
  const view = await f.repo.detail(owner, workspaceId, nodeId, 1);
  assert.equal(view.component_type, 'html'); assert.equal(view.media_type, null);
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
  f.row({ ...detail(), component_type: 'unknown' });
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 1), code('WORKSPACE_READ_CONTRACT_INVALID'));
  f.row({ ...detail(), kind: 'lesson', component_type: 'html' });
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 1), code('WORKSPACE_READ_CONTRACT_INVALID'));
  f.row({ ...detail(), kind: 'media_brief', media_type: 'video' });
  assert.equal((await f.repo.detail(owner, workspaceId, nodeId, 1)).media_type, 'video');
  f.row(detail()); assert.equal((await f.repo.detail(owner, workspaceId, nodeId, 1)).component_type, null);
});

test('component detail exposes bounded read-only author review metadata and rejects malformed fields', async () => {
  const review = { purpose: 'Giúp người học hiểu mô hình.', example_scenario: null,
    visual_asset: 'Sơ đồ quy trình ba bước.', user_behavior_navigation: 'Chọn từng bước để xem giải thích.' };
  const f = fixture({ ...detail(), component_type: 'html', author_review: review });
  assert.deepEqual((await f.repo.detail(owner, workspaceId, nodeId, 1)).author_review, review);
  for (const author_review of [{ ...review, purpose: '' }, { ...review, private_note: 'must not leak' },
    { ...review, visual_asset: 42 }]) {
    f.row({ ...detail(), component_type: 'html', author_review });
    await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 1), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
});

test('read summary retains EN/VI/root correlation and exposes only metadata, not raw rows or Apply authority', async () => {
  const f = fixture({ ...summary(), tenant_id: owner.tenantId, source_document_ids: ['PRIVATE'], request_hash: 'PRIVATE', editor_context: 'PRIVATE' });
  const vi = await f.repo.status(owner, workspaceId);
  assert.equal(vi.content_locale, 'vi'); assert.equal(vi.correlation_id, common.correlation_id);
  assert.equal(vi.last_event_sequence, 3); assert.equal(vi.ready_unit_count, 2);
  assert.equal(JSON.stringify(vi).includes('PRIVATE'), false);
  assert.equal('apply_ready' in vi, false); assert.equal('tenant_id' in vi, false);
  f.row({ ...summary(), content_locale: 'en' });
  assert.equal((await f.repo.status(owner, workspaceId)).content_locale, 'en');
});

test('terminal summary exposes only bounded safe failure identity for a clear client state', async () => {
  const f = fixture({ ...summary(), status: 'needs_action', failure_code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED',
    failure_stage: 'chapter_blueprint', failure_chapter_key: 'chapter-2' });
  const view = await f.repo.status(owner, workspaceId);
  assert.equal(view.failure_code, 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  assert.equal(view.failure_stage, 'chapter_blueprint');
  assert.equal(view.failure_chapter_key, 'chapter-2');
  assert.match(f.calls[0]!.sql, /lesson_author_workspace_v2_runs/);
  assert.match(f.calls[0]!.sql, /lesson_author_workspace_v2_tasks/);
  assert.match(f.calls[0]!.sql, /CASE WHEN failure\.run_status IN \('needs_action','failed','canceled'\)/);
  assert.doesNotMatch(f.calls[0]!.sql, /AND w\.status IN \('needs_action','failed','canceled'\)/);
  assert.match(f.calls[0]!.sql, /candidate\.status IN \('failed','timed_out','outcome_unknown'\) OR candidate\.attempt_count>0/);
  f.row({ ...summary(), status: 'needs_action', failure_code: 'PRIVATE raw text',
    failure_stage: 'chapter_blueprint', failure_chapter_key: 'chapter-2' });
  await assert.rejects(f.repo.status(owner, workspaceId), code('WORKSPACE_READ_CONTRACT_INVALID'));
});

test('permission is checked on every read and revocation denies before any content query', async () => {
  const f = fixture(summary());
  await f.repo.status(owner, workspaceId); f.deny();
  await assert.rejects(f.repo.status(owner, workspaceId), code('WORKSPACE_READ_FORBIDDEN'));
  await assert.rejects(f.repo.events(owner, workspaceId, 0), code('WORKSPACE_READ_FORBIDDEN'));
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 1), code('WORKSPACE_READ_FORBIDDEN'));
  assert.equal(f.calls.length, 1); assert.equal(f.permissions.length, 4);
});

test('all three queries bind owner/course/conversation and fresh assignment/deletion/source checks in one statement', async () => {
  const f = fixture(summary()); await f.repo.status(owner, workspaceId);
  f.row({ ...common, first_sequence: '1', events: [event(1), event(2), event(3)] }); await f.repo.events(owner, workspaceId, 0);
  f.row(detail()); await f.repo.detail(owner, workspaceId, nodeId, 1);
  for (const call of f.calls) {
    assert.deepEqual(call.params.slice(0, 5), [workspaceId, owner.tenantId, owner.conversationId, owner.userId, owner.courseId]);
    for (const predicate of ['w.tenant_id=$2', 'w.conversation_id=$3', 'w.requested_by=$4', 'w.course_id=$5',
      "c.target='lesson_author'", 'course.deleted_at IS NULL', 'tenant_bot_assignments', 'tenant_kb_assignments',
      'd.tenant_id=w.tenant_id', 'd.kb_id=w.kb_id', 'count(DISTINCT d.id)']) assert.ok(call.sql.includes(predicate), predicate);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE)\b/i);
    assert.ok(call.sql.startsWith('WITH owned AS ('));
  }
  // SQL predicate assertions are not a PostgreSQL RLS/authorization integration test.
});

test('missing or inaccessible workspace is indistinguishable, including detail and events', async () => {
  const f = fixture(null);
  for (const request of [() => f.repo.status(owner, workspaceId), () => f.repo.events(owner, workspaceId, 0),
    () => f.repo.detail(owner, workspaceId, nodeId, 0)]) {
    await assert.rejects(request(), code('WORKSPACE_NOT_FOUND'));
  }
});

test('invalid identifiers and cursors never reach SQL or get interpolated', async () => {
  const f = fixture(summary());
  await assert.rejects(f.repo.status({ ...owner, tenantId: 'invalid' }, workspaceId), code('WORKSPACE_READ_CONTRACT_INVALID'));
  await assert.rejects(f.repo.status(owner, "x' OR true"), code('WORKSPACE_READ_CONTRACT_INVALID'));
  await assert.rejects(f.repo.detail(owner, workspaceId, 'invalid', 0), code('WORKSPACE_READ_CONTRACT_INVALID'));
  await assert.rejects(f.repo.events(owner, workspaceId, NaN), code('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED'));
  assert.equal(f.calls.length, 0);
});

test('SQL/auth exceptions return only safe typed codes, never private error text', async () => {
  const f = fixture(summary()); f.fail();
  await assert.rejects(f.repo.status(owner, workspaceId), code('WORKSPACE_READ_UNAVAILABLE'));
  const a = fixture(summary()); a.failAuth();
  await assert.rejects(a.repo.status(owner, workspaceId), code('WORKSPACE_READ_UNAVAILABLE'));
  assert.equal(a.calls.length, 0);
});

test('summary rejects unknown version/locale/status, impossible counts and unsafe bigint', async () => {
  for (const change of [{ contract_version: 2 }, { status: 'published' }, { ready_unit_count: '6' },
    { event_head: '9007199254740992' }, { event_head: '1e3' }]) {
    const f = fixture({ ...summary(), ...change });
    await assert.rejects(f.repo.status(owner, workspaceId), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
  const f = fixture({ ...summary(), content_locale: 'fr' });
  await assert.rejects(f.repo.status(owner, workspaceId), code('WORKSPACE_LOCALE_INVALID'));
});

test('events are bounded metadata, with stable next cursor and replay of same page', async () => {
  const f = fixture({ ...common, event_head: '101', first_sequence: '1', events: Array.from({ length: 100 }, (_, i) => ({ ...event(i + 1), content: 'PRIVATE' })) });
  const result = await f.repo.events(owner, workspaceId, 0);
  assert.equal(result.events.length, 100); assert.equal(result.next_sequence, 100); assert.equal(result.has_more, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(await f.repo.events(owner, workspaceId, 0), result);
  assert.deepEqual(f.calls[0].params.slice(5), [0, 100]);
  assert.match(f.calls[0].sql, /ORDER BY e.sequence LIMIT \$7/);
  f.row({ ...common, event_head: '101', first_sequence: '1', events: [event(101)] });
  const tail = await f.repo.events(owner, workspaceId, 100);
  assert.equal(tail.has_more, false); assert.equal(tail.next_sequence, 101);
});

test('empty initial event stream and up-to-date cursor return no fabricated progress', async () => {
  const f = fixture({ ...common, event_head: '0', first_sequence: null, events: [] });
  assert.equal((await f.repo.events(owner, workspaceId, 0)).next_sequence, 0);
  f.row({ ...common, first_sequence: '1', events: [] });
  const result = await f.repo.events(owner, workspaceId, 3);
  assert.deepEqual(result.events, []); assert.equal(result.has_more, false);
});

test('future, expired, missing middle/tail and duplicate event cursors require resnapshot', async () => {
  const cases = [
    { after: 4, first: '1', events: [] }, { after: 0, first: '2', events: [event(2), event(3)] },
    { after: 0, first: '1', events: [event(1), event(3)] }, { after: 0, first: '1', events: [event(1), event(2)] },
    { after: 0, first: '1', events: [event(1), event(1), event(3)] }, { after: 0, first: null, events: [] },
  ];
  for (const value of cases) {
    const f = fixture({ ...common, first_sequence: value.first, events: value.events });
    await assert.rejects(f.repo.events(owner, workspaceId, value.after), code('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED'));
  }
});

test('invalid event kind or revision identity fails closed', async () => {
  for (const change of [{ event_kind: 'raw_provider_output' }, { event_kind: 'node_reset', node_revision: null },
    { node_id: null, node_revision: 1 }]) {
    const f = fixture({ ...common, event_head: '1', first_sequence: '1', events: [{ ...event(1), ...change }] });
    await assert.rejects(f.repo.events(owner, workspaceId, 0), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
});

test('detail is exact requested revision, hash checked, detached and without protected provenance', async () => {
  const f = fixture({ ...detail(), protected_contract: { source_fact_ids: ['PRIVATE'] }, source_snapshot_hash: 'PRIVATE' });
  const result = await f.repo.detail(owner, workspaceId, nodeId, 1);
  assert.deepEqual(result.content, content); assert.equal(result.user_modified, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal('apply_ready' in result, false);
  result.content!.title = 'Changed locally';
  assert.equal((await f.repo.detail(owner, workspaceId, nodeId, 1)).content!.title, content.title);
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 0), code('WORKSPACE_REVISION_CONFLICT'));
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, null), code('WORKSPACE_REVISION_CONFLICT'));
});

test('planned node has null content; absent node is not a missing workspace', async () => {
  const f = fixture({ ...detail(), content_state: 'planned', current_revision: null, content: null, content_hash: null,
    user_modified: null, validation_contract: null });
  const result = await f.repo.detail(owner, workspaceId, nodeId, null);
  assert.equal(result.content, null); assert.equal(result.user_modified, false);
  f.row({ ...common, node_id: null });
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, null), code('WORKSPACE_NODE_NOT_FOUND'));
});

test('corrupt/missing revision content and hidden provenance cannot leak through detail', async () => {
  for (const change of [{ content_hash: '0'.repeat(64) }, { content_state: 'generating' },
    { user_modified: null }, { validation_contract: 'unsafe private value' }]) {
    const f = fixture({ ...detail(), ...change });
    await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 1), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
  const f = fixture({ ...detail(), content: { ...content, data: { source_fact_ids: ['private'] } } });
  await assert.rejects(f.repo.detail(owner, workspaceId, nodeId, 1), code('WORKSPACE_NODE_FIELD_PROTECTED'));
});

test('read module has no import-time DB connection/provider or mutation path', () => {
  const source = readFileSync(new URL('./lesson-author-workspace-read.repository.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:config\/database|chat\.service|provider|gemini)/);
  assert.doesNotMatch(source, /\b(?:INSERT INTO|UPDATE public\.|DELETE FROM|setInterval|fetch\()\b/);
});

const graphNode = (n: number) => ({ node_id: uuid(1000 + n), parent_id: n === 0 ? null : uuid(1000),
  kind: n === 0 ? 'course' : 'chapter', canonical_path: n === 0 ? 'course' : `chapter_${n}`, sort_order: n,
  content_state: 'planned', current_revision: null, component_type: null, media_type: null,
  title: `Synthetic ${n}`, user_modified: false, applied: false });

test('graph stays empty until committed overview and sealed structure, without invented ready content', async () => {
  const f = fixture({ ...common, overview_ready: false, structure_ready: false, cursor_exists: true, graph_node_count: '0', nodes: [] });
  const empty = await f.repo.graph(owner, workspaceId);
  assert.deepEqual(empty.nodes, []); assert.equal(empty.total_nodes, 0); assert.equal(empty.has_more, false);
  f.row({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true, graph_node_count: '1', nodes: [graphNode(0)] });
  const graph = await f.repo.graph(owner, workspaceId);
  assert.equal(graph.nodes[0].content_state, 'planned'); assert.equal(graph.nodes[0].current_revision, null);
  assert.equal('data' in graph.nodes[0], false); assert.equal('apply_ready' in graph.nodes[0], false);
  assert.match(f.calls[1]!.sql, /n\.kind IN \('course','chapter','lesson'\) OR n\.content_state='content_ready'/);
  assert.doesNotMatch(f.calls[1]!.sql, /n\.kind IN \('course','chapter','lesson','unit','component','media_brief'\)/);
});

test('1001-node graph pages are bounded and complete, including explicit last-page cursor', async () => {
  const all = Array.from({ length: 1001 }, (_, index) => graphNode(index));
  const f = fixture(null);
  const collected: string[] = [];
  let after: string | undefined;
  for (let offset = 0; offset < all.length; offset += 100) {
    f.row({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true,
      graph_node_count: String(all.length), nodes: all.slice(offset, offset + 101) });
    const result = await f.repo.graph(owner, workspaceId, after ? { after_node_id: after, snapshot_sequence: 3 } : {});
    assert.ok(result.nodes.length <= 100); assert.equal(result.snapshot_sequence, 3);
    collected.push(...result.nodes.map(node => node.node_id));
    after = result.next_after_node_id ?? undefined;
    assert.equal(result.has_more, offset + 100 < all.length);
  }
  assert.deepEqual(collected, all.map(node => node.node_id)); assert.equal(new Set(collected).size, 1001);
  assert.equal(after, undefined); assert.equal(f.permissions.length, 11);
  for (const call of f.calls) {
    assert.equal(call.params[7], 101); assert.match(call.sql, /ORDER BY n.id LIMIT \$8/);
    assert.doesNotMatch(call.sql, /SELECT r\.content[,\s]/);
  }
});

test('graph rejects mixed snapshots, foreign/missing cursor and malformed cursor before query', async () => {
  const f = fixture({ ...common, event_head: '4', overview_ready: true, structure_ready: true,
    cursor_exists: true, graph_node_count: '1', nodes: [] });
  await assert.rejects(f.repo.graph(owner, workspaceId, { snapshot_sequence: 3, after_node_id: uuid(1000) }), code('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED'));
  f.row({ ...common, cursor_exists: false });
  await assert.rejects(f.repo.graph(owner, workspaceId, { snapshot_sequence: 3, after_node_id: uuid(999) }), code('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED'));
  const before = f.calls.length;
  await assert.rejects(f.repo.graph(owner, workspaceId, { after_node_id: uuid(1000) }), code('WORKSPACE_READ_CONTRACT_INVALID'));
  assert.equal(f.calls.length, before);
});

test('graph projections hide provenance/body; ready label comes from exact persisted revision', async () => {
  const node = { ...graphNode(0), content_state: 'content_ready', current_revision: '2', title: 'Author title', user_modified: true,
    applied: true, protected_contract: { source_fact_ids: ['PRIVATE'] }, data: 'PRIVATE', content: 'PRIVATE' };
  const f = fixture({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true, graph_node_count: '1', nodes: [node] });
  const result = await f.repo.graph(owner, workspaceId);
  assert.equal(result.nodes[0].title, 'Author title'); assert.equal(result.nodes[0].user_modified, true);
  assert.equal(result.nodes[0].applied, true);
  assert.equal(result.nodes[0].current_revision, 2); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('graph exposes only bounded protected presentation discriminators', async () => {
  const component = { ...graphNode(1), kind: 'component', content_state: 'content_ready', current_revision: '0',
    component_type: 'la_faq', title: 'Questions', parent_id: uuid(1000) };
  const f = fixture({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true,
    graph_node_count: '1', nodes: [component] });
  const result = await f.repo.graph(owner, workspaceId);
  assert.equal(result.nodes[0].component_type, 'la_faq');
  assert.match(f.calls[0]!.sql, /n\.protected_contract->>'component_type'/);
  assert.match(f.calls[0]!.sql, /n\.protected_contract->>'media_type'/);
  assert.equal('protected_contract' in result.nodes[0], false);
  for (const bad of [{ ...component, component_type: 'faq' }, { ...component, component_type: null },
    { ...graphNode(0), component_type: 'html' }]) {
    f.row({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true,
      graph_node_count: '1', nodes: [bad] });
    await assert.rejects(f.repo.graph(owner, workspaceId), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
  const media = { ...graphNode(1), kind: 'media_brief', content_state: 'content_ready', current_revision: '0',
    media_type: 'static_infographic', title: 'Infographic', parent_id: uuid(1000) };
  f.row({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true,
    graph_node_count: '1', nodes: [media] });
  assert.equal((await f.repo.graph(owner, workspaceId)).nodes[0].media_type, 'static_infographic');
  for (const bad of [{ ...media, media_type: 'image' }, { ...media, media_type: null },
    { ...graphNode(0), media_type: 'video' }]) {
    f.row({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true,
      graph_node_count: '1', nodes: [bad] });
    await assert.rejects(f.repo.graph(owner, workspaceId), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
});

test('graph Apply projection is exact to the current persisted revision and content hash', async () => {
  const f = fixture({ ...common, overview_ready: true, structure_ready: true, cursor_exists: true,
    graph_node_count: '1', nodes: [{ ...graphNode(0), content_state: 'content_ready', current_revision: '2', applied: false }] });
  await f.repo.graph(owner, workspaceId);
  assert.match(f.calls[0].sql, /lesson_author_workspace_apply_mappings/);
  assert.match(f.calls[0].sql, /m\.applied_revision=n\.current_revision/);
  assert.match(f.calls[0].sql, /m\.applied_content_hash=r\.content_hash/);
});

test('graph rejects corrupt state, premature structure, missing nodes and unsorted/duplicate IDs', async () => {
  const base = { ...common, overview_ready: true, structure_ready: true, cursor_exists: true, graph_node_count: '1', nodes: [graphNode(0)] };
  for (const change of [{ overview_ready: false }, { nodes: [] }, { graph_node_count: '0' },
    { nodes: [{ ...graphNode(0), current_revision: '1' }] }, { nodes: [{ ...graphNode(0), user_modified: true }] },
    { nodes: [{ ...graphNode(0), applied: true }] }, { nodes: [{ ...graphNode(0), applied: 'yes' }] },
    { graph_node_count: '2', nodes: [graphNode(0), graphNode(0)] }]) {
    const f = fixture({ ...base, ...change });
    await assert.rejects(f.repo.graph(owner, workspaceId), code('WORKSPACE_READ_CONTRACT_INVALID'));
  }
});
