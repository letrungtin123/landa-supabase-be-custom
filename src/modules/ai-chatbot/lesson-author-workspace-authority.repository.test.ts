import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';
import { lessonAuthorSourceInfoSummary, lessonAuthorSourceSnapshotHash } from './lesson-author-source-snapshot.logic.js';
import { COURSE_COMPONENT_TYPES } from '../tenants/tenant-course-components.constants.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'staff', sessionMode: 'normal', username: 'synthetic' };
const owner = { userId: user.id, tenantId: user.tenantId!, courseId: 'course-v1:TEST+AUTHORITY+2026', conversationId: uuid(3) };
const source = { document_id: uuid(4), name: 'Synthetic VI / EN.pdf', status: 'learned', type: 'file',
  updated_at: '2026-09-29T00:00:00.000Z', source_info: { extension: 'pdf', mime_type: 'application/pdf', size: 50 } };
const hash = lessonAuthorSourceSnapshotHash(owner, uuid(5), [source]);
const context: WorkspaceEditContext = { target: { ...owner, workspaceId: uuid(6), nodeId: uuid(7), operationId: uuid(8) },
  source_snapshot_hash: hash, correlation_id: uuid(9), content_locale: 'vi', contract_hash: 'a'.repeat(64), protected_contract: {},
  node: { node_id: uuid(7), kind: 'component', content_state: 'content_ready', baseline: null, current: null, current_revision: 0 } };
const code = (wanted: string) => (e: unknown) => e instanceof Error && e.message === wanted && 'code' in e && e.code === wanted;
function fixture(subject: AuthUser = user) {
  const state = {
    actor: { role: subject.role, tenant_id: subject.tenantId, is_active: true, tenant_active: true },
    membership: true, grants: [false, true], settings: {} as unknown,
    workspace: { kb_id: uuid(5), bot_id: uuid(10), source_document_ids: [source.document_id], source_snapshot_hash: hash,
      blueprint_id: uuid(11) as string | null },
    workspacePresent: true, blueprint: true,
    v2Authority: { run_id: uuid(12), snapshot_id: uuid(13), snapshot_status: 'sealed',
      source_snapshot_hash: hash, source_document_ids: [source.document_id] } as Record<string, unknown>,
    bot: true, kb: true, documents: [structuredClone(source)] as Array<Record<string, unknown>>, fail: false,
  };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    if (state.fail) throw new Error('PRIVATE SQL AND CREDENTIALS');
    let rows: Record<string, unknown>[];
    if (sql.includes('FROM users u')) rows = [state.actor];
    else if (sql.includes('FROM user_tenants')) rows = state.membership ? [{ user_id: user.id }] : [];
    else if (sql.includes('FROM user_permission_groups')) rows = state.grants.map(can_edit => ({ can_edit }));
    else if (sql.includes('FROM lesson_author_workspaces w')) rows = state.workspacePresent ? [state.workspace] : [];
    else if (sql.includes('FROM lesson_author_blueprints b')) rows = state.blueprint ? [{ id: uuid(11) }] : [];
    else if (sql.includes('FROM lesson_author_workspace_v2_runs r')) rows = [state.v2Authority];
    else if (sql.includes('FROM tenant_bot_assignments')) rows = state.bot ? [{ bot_id: uuid(10) }] : [];
    else if (sql.includes('FROM tenant_kb_assignments')) rows = state.kb ? [{ kb_id: uuid(5) }] : [];
    else if (sql.includes('FROM kb_documents')) rows = state.documents;
    else if (sql.includes('SELECT settings FROM tenants')) rows = [{ settings: state.settings }];
    else throw new Error('Unexpected mock SQL');
    return { rows: structuredClone(rows) as T[], rowCount: rows.length };
  } };
  return { state, tx, calls, authority: createWorkspaceAuthority(subject) };
}

test('legacy snapshot hash parity includes only existing metadata and is order independent', () => {
  // Freeze the pre-extraction algorithm, including size0/null/empty handling.
  const legacy = (docs: typeof source[]) => createHash('sha256').update([owner.tenantId, owner.courseId, uuid(5), docs.map(d => [
    d.document_id, d.name, d.status ?? '', d.updated_at,
    [d.source_info?.extension ? `extension=${d.source_info.extension}` : '', d.source_info?.mime_type ? `mime_type=${d.source_info.mime_type}` : '',
      d.source_info?.size && Number.isFinite(d.source_info.size) ? `size=${d.source_info.size}` : ''].filter(Boolean).join(', '),
  ].join(':')).sort().join('|')].join('|')).digest('hex');
  for (const size of [0, 50, -1, Infinity, NaN]) {
    const a = { ...source, source_info: { extension: 'pdf', mime_type: 'application/pdf', size } };
    const b = { ...source, document_id: uuid(20), name: 'English: Unit | Lesson.pdf', source_info: { extension: '', mime_type: '', size: 0 } };
    assert.equal(lessonAuthorSourceSnapshotHash(owner, uuid(5), [a, b]), legacy([b, a]));
  }
  assert.equal(lessonAuthorSourceInfoSummary(null), '');
  const sources = [source, { ...source, document_id: uuid(20) }], before = structuredClone(sources);
  lessonAuthorSourceSnapshotHash(owner, uuid(5), sources); assert.deepEqual(sources, before);
});
test('snapshot detects tenant/course/KB/revision/name/status/metadata changes', () => {
  assert.notEqual(lessonAuthorSourceSnapshotHash({ ...owner, tenantId: uuid(30) }, uuid(5), [source]), hash);
  assert.notEqual(lessonAuthorSourceSnapshotHash({ ...owner, courseId: 'different' }, uuid(5), [source]), hash);
  assert.notEqual(lessonAuthorSourceSnapshotHash(owner, uuid(30), [source]), hash);
  for (const patch of [{ name: 'Renamed' }, { status: 'pending' }, { updated_at: '2026-09-30T00:00:00.000Z' }, { source_info: null }]) {
    assert.notEqual(lessonAuthorSourceSnapshotHash(owner, uuid(5), [{ ...source, ...patch }]), hash);
  }
});
test('staff permission uses fresh UNION grants on the supplied transaction every time', async () => {
  const f = fixture(); assert.equal(await f.authority.canEdit(f.tx, owner), true);
  f.state.grants = [false]; assert.equal(await f.authority.canEdit(f.tx, owner), false);
  assert.equal(f.calls.filter(c => c.sql.includes('FROM user_permission_groups')).length, 2);
  assert.ok(f.calls.every(c => c.sql.includes('FOR SHARE')));
  const q = f.calls.find(c => c.sql.includes('FROM user_permission_groups'))!;
  assert.deepEqual(q.params, [user.id, user.tenantId]);
  assert.match(q.sql, /pgm.tenant_id=upg.tenant_id/); assert.match(q.sql, /pg.tenant_id=\$2/);
  assert.match(q.sql, /m.code='courses'/); assert.match(q.sql, /FOR SHARE OF upg,pgm,m,pg/);
});
test('learner/demo/cross-actor/cross-tenant cannot reach SQL through an authority callback', async () => {
  for (const subject of [{ ...user, role: 'learner' as const }, { ...user, sessionMode: 'demo_iframe' as const },
    { ...user, id: uuid(22) }, { ...user, tenantId: uuid(22) }]) {
    const f = fixture(subject); assert.equal(await f.authority.canEdit(f.tx, owner), false);
    await assert.rejects(f.authority.currentSourceHash(f.tx, context), code('WORKSPACE_EDIT_FORBIDDEN'));
    await assert.rejects(f.authority.allowedComponents(f.tx, owner), code('WORKSPACE_EDIT_FORBIDDEN'));
    assert.equal(f.calls.length, 0);
  }
});
test('disabled user/tenant, stale JWT role and removed staff tenancy fail', async () => {
  for (const patch of [{ is_active: false }, { tenant_active: false }, { role: 'superadmin' as const }, { tenant_id: uuid(22) }]) {
    const f = fixture(); Object.assign(f.state.actor, patch);
    assert.equal(await f.authority.canEdit(f.tx, owner), false);
    assert.equal(f.calls.length, 1);
  }
});
test('superuser needs primary tenant or current managed membership; superadmin still binds requested owner', async () => {
  const f = fixture({ ...user, role: 'superuser' }); f.state.actor.tenant_id = uuid(25);
  assert.equal(await f.authority.canEdit(f.tx, owner), true);
  assert.match(f.calls.at(-1)!.sql, /user_tenants.*FOR SHARE/);
  f.state.membership = false; assert.equal(await f.authority.canEdit(f.tx, owner), false);
  const admin = fixture({ ...user, role: 'superadmin' }); admin.state.actor.tenant_id = uuid(25);
  assert.equal(await admin.authority.canEdit(admin.tx, owner), true);
  assert.equal(await admin.authority.canEdit(admin.tx, { ...owner, userId: uuid(40) }), false);
});
test('request principal is captured, not mutable by a later caller', async () => {
  const mutable = { ...user }, f = fixture(mutable); mutable.role = 'superadmin';
  f.state.actor.role = 'superadmin'; assert.equal(await f.authority.canEdit(f.tx, owner), false);
});
test('source check reads locked metadata only, normalizes timestamps and preserves existing snapshot', async () => {
  const f = fixture(); f.state.documents[0].updated_at = new Date(source.updated_at);
  assert.equal(await f.authority.currentSourceHash(f.tx, context), hash);
  const doc = f.calls.find(c => c.sql.includes('FROM kb_documents'))!;
  assert.deepEqual(doc.params, [owner.tenantId, uuid(5), [source.document_id]]);
  assert.doesNotMatch(doc.sql, /d\.content|gemini|SELECT \*/);
  assert.match(doc.sql, /ORDER BY d.id FOR SHARE OF d/);
  assert.ok(f.calls.every(c => c.sql.includes('FOR SHARE')));
  assert.deepEqual(f.calls[0].params, [context.target.workspaceId, owner.tenantId, owner.courseId, owner.conversationId, owner.userId]);
});
test('V2 source check uses the sealed snapshot authority without requiring a legacy Blueprint', async () => {
  const f = fixture(); f.state.workspace.blueprint_id = null;
  assert.equal(await f.authority.currentSourceHash(f.tx, context), hash);
  assert.equal(f.calls.some(c => c.sql.includes('FROM lesson_author_blueprints b')), false);
  const v2 = f.calls.find(c => c.sql.includes('FROM lesson_author_workspace_v2_runs r'))!;
  assert.deepEqual(v2.params, [context.target.workspaceId, owner.tenantId, owner.courseId]);
  assert.match(v2.sql, /JOIN lesson_author_workspace_source_snapshots s/);
  assert.match(v2.sql, /FOR SHARE OF r,s/);
});
test('V2 source check fails closed for an unsealed, changed or mismatched snapshot', async () => {
  for (const patch of [{ snapshot_status: 'building' }, { source_snapshot_hash: 'b'.repeat(64) },
    { source_document_ids: [uuid(40)] }]) {
    const f = fixture(); f.state.workspace.blueprint_id = null; Object.assign(f.state.v2Authority, patch);
    await assert.rejects(f.authority.currentSourceHash(f.tx, context), code('WORKSPACE_SOURCE_CHANGED'));
  }
});
test('source check locks both current bot and KB assignments, and denies reassignment', async () => {
  for (const changed of ['bot', 'kb'] as const) {
    const f = fixture(); f.state[changed] = false;
    await assert.rejects(f.authority.currentSourceHash(f.tx, context), code('WORKSPACE_SOURCE_CHANGED'));
    assert.equal(f.calls.some(c => c.sql.includes('FROM kb_documents')), false);
  }
});
test('missing/nonmatching Blueprint binding or malformed source inventory fails closed', async () => {
    const cases: Array<(s: ReturnType<typeof fixture>['state']) => void> = [
    s => { s.workspacePresent = false; }, s => { s.blueprint = false; },
    s => { s.workspace.source_snapshot_hash = 'b'.repeat(64); }, s => { s.workspace.source_document_ids = []; },
    s => { s.workspace.source_document_ids = [source.document_id, source.document_id]; },
    s => { s.workspace.source_document_ids = ['not-a-uuid']; },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f.state);
    await assert.rejects(f.authority.currentSourceHash(f.tx, context), code('WORKSPACE_SOURCE_CHANGED'));
  }
});
test('missing/foreign/duplicate/not-ready source documents and invalid dates never return a valid fingerprint', async () => {
  for (const mutate of [(d: Record<string, unknown>[]) => d.pop(), (d: Record<string, unknown>[]) => d.push(d[0]),
    (d: Record<string, unknown>[]) => d[0].document_id = uuid(40), (d: Record<string, unknown>[]) => d[0].status = 'learning',
    (d: Record<string, unknown>[]) => d[0].type = 'url', (d: Record<string, unknown>[]) => d[0].updated_at = 'invalid']) {
    const f = fixture(); mutate(f.state.documents);
    await assert.rejects(f.authority.currentSourceHash(f.tx, context), code('WORKSPACE_SOURCE_CHANGED'));
  }
});
test('changed revision yields a different hash for the edit repository commit comparison', async () => {
  const f = fixture(); f.state.documents[0].updated_at = '2026-09-30T00:00:00.000Z';
  assert.notEqual(await f.authority.currentSourceHash(f.tx, context), context.source_snapshot_hash);
});
test('capabilities use fresh locked settings; missing default is preserved but empty/malformed is not widened', async () => {
  const f = fixture(); assert.deepEqual([...await f.authority.allowedComponents(f.tx, owner)], [...COURSE_COMPONENT_TYPES]);
  f.state.settings = { course_authoring: { allowed_component_types: ['html', 'problem'] } };
  assert.deepEqual([...await f.authority.allowedComponents(f.tx, owner)], ['html', 'problem']);
  f.state.settings = { course_authoring: { allowed_component_types: [] } };
  assert.equal((await f.authority.allowedComponents(f.tx, owner)).size, 0);
  f.state.settings = { course_authoring: { allowed_component_types: 'html' } };
  await assert.rejects(f.authority.allowedComponents(f.tx, owner), code('WORKSPACE_EDIT_CONTRACT_INVALID'));
  for (const malformed of ['bad', [], { course_authoring: 'bad' }, { course_authoring: null }, { course_authoring: [] }]) {
    f.state.settings = malformed;
    await assert.rejects(f.authority.allowedComponents(f.tx, owner), code('WORKSPACE_EDIT_CONTRACT_INVALID'));
  }
  assert.ok(f.calls.every(c => c.sql.includes('FOR SHARE')));
});
test('database errors never leak private exception text', async () => {
  const f = fixture(); f.state.fail = true;
  for (const run of [() => f.authority.canEdit(f.tx, owner), () => f.authority.currentSourceHash(f.tx, context), () => f.authority.allowedComponents(f.tx, owner)]) {
    await assert.rejects(run(), code('WORKSPACE_EDIT_UNAVAILABLE'));
  }
});
test('new adapters are SELECT-only and no global cache/DB/provider imports; legacy hash calls delegate to shared implementation', () => {
  const adapter = readFileSync(new URL('./lesson-author-workspace-authority.repository.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(adapter, /from ['"].*(?:config\/database|chat\.service|middleware\/authorize|gemini)/);
  assert.doesNotMatch(adapter, /\b(?:INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/);
  const chat = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
  assert.match(chat, /lessonAuthorSourceSnapshotHash as createLessonAuthorBlueprintSourceSnapshotHash/);
  assert.doesNotMatch(chat, /function createLessonAuthorBlueprintSourceSnapshotHash/);
});
