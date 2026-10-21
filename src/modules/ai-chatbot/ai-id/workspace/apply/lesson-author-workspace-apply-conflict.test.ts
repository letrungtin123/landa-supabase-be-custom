import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../../../../types/express.js';
import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { normalizeStructuredAuditEvent } from '../../../../audit-logs/audit-event.contract.js';
import {
  classifyWorkspaceApplyDrift,
  WorkspaceApplyConflictError,
  workspaceApplyOverwriteDecision,
  workspaceApplyOverwriteToken,
  WORKSPACE_APPLY_CONFLICT_ITEM_LIMIT,
  type WorkspaceApplyBlockEvidence,
  type WorkspaceApplyMappingEvidence,
} from './lesson-author-workspace-apply-conflict.logic.js';
import { createWorkspaceApplyHandler, WORKSPACE_APPLY_ERRORS } from './lesson-author-workspace-apply.controller.js';
import { createWorkspaceApplyRepository, WorkspaceApplyError } from './lesson-author-workspace-apply.repository.js';
import { lessonAuthorSourceSnapshotHash } from '../../shared/lesson-author-source-snapshot.logic.js';
import { LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS } from '../../sources/lesson-author-source-upload.controller.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const h = (c: string) => c.repeat(64);
const WORKSPACE = id(1), ROOT = id(2), TENANT = id(3), CREATOR = id(4), EDITOR = id(5), NO_EDIT = id(6), SUPERUSER = id(7);
const CONVERSATION = id(8), NODE_CHAPTER = id(9), NODE_UNIT = id(10), BLOCK_CHAPTER = id(11), BLOCK_UNIT = id(12);
const RUN = id(13), KB = id(14), BOT = id(15), DOC = id(16), COURSE_NODE = id(17), CORRELATION = id(18), OPERATION = id(19);
const COURSE = 'course-v1:Nesso+APPLY+2026';
const actor = (userId: string, role: AuthUser['role'] = 'staff'): AuthUser => ({ id: userId, role, tenantId: TENANT, username: userId.slice(-2), sessionMode: 'normal' });

// ── Pure drift classification ─────────────────────────────────────────────

function mapping(node: string, block: string, overrides: Partial<WorkspaceApplyMappingEvidence> = {}): WorkspaceApplyMappingEvidence {
  return { node_id: node, target_block_id: block, target_parent_id: ROOT, target_block_type: 'chapter', target_sort_order: 3,
    target_hash: h('a'), actual_target_hash: h('a'), ...overrides };
}
function block(blockId: string, node: string, overrides: Partial<WorkspaceApplyBlockEvidence> = {}): WorkspaceApplyBlockEvidence {
  return { id: blockId, display_name: 'Chương 1  — đã sửa', block_type: 'chapter', parent_id: ROOT, sort_order: 3, deleted: false,
    workspace_id: WORKSPACE, workspace_node_id: node, generated_by: 'lesson_author_ai', ...overrides };
}
const nodes = [{ node_id: NODE_CHAPTER, kind: 'chapter', canonical_path: 'chapter_1' },
  { node_id: NODE_UNIT, kind: 'unit', canonical_path: 'chapter_1.lesson_1.unit_1' }];

test('unchanged blocks are not drift; edited content is overwritable; deleted/moved/re-typed blocks never are', () => {
  assert.deepEqual(classifyWorkspaceApplyDrift({ workspace_id: WORKSPACE, nodes, mappings: [mapping(NODE_CHAPTER, BLOCK_CHAPTER)], blocks: [] }),
    { content: [], structural: [] });
  const edited = classifyWorkspaceApplyDrift({ workspace_id: WORKSPACE, nodes,
    mappings: [mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('b') })], blocks: [block(BLOCK_CHAPTER, NODE_CHAPTER)] });
  assert.deepEqual(edited.content, [{ node_id: NODE_CHAPTER, kind: 'chapter', title: 'Chương 1 — đã sửa', canonical_path: 'chapter_1', actual_target_hash: h('b') }]);
  assert.equal(edited.structural.length, 0);
  for (const [label, evidence, live] of [
    ['deleted', mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: null }), block(BLOCK_CHAPTER, NODE_CHAPTER, { deleted: true })],
    ['moved', mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('b') }), block(BLOCK_CHAPTER, NODE_CHAPTER, { sort_order: 9 })],
    ['re-parented', mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('b') }), block(BLOCK_CHAPTER, NODE_CHAPTER, { parent_id: id(99) })],
    ['re-typed', mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('b') }), block(BLOCK_CHAPTER, NODE_CHAPTER, { block_type: 'sequential' })],
    ['identity removed', mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('b') }), block(BLOCK_CHAPTER, NODE_CHAPTER, { generated_by: null })],
  ] as const) {
    const drift = classifyWorkspaceApplyDrift({ workspace_id: WORKSPACE, nodes, mappings: [evidence], blocks: [live] });
    assert.equal(drift.content.length, 0, label); assert.equal(drift.structural.length, 1, label);
  }
});

test('overwrite needs the exact confirmation of the listed blocks; untouched edited blocks never block an Apply', () => {
  const drift = classifyWorkspaceApplyDrift({ workspace_id: WORKSPACE, nodes,
    mappings: [mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('b') }),
      mapping(NODE_UNIT, BLOCK_UNIT, { target_block_type: 'vertical', target_parent_id: id(50), actual_target_hash: h('c') })],
    blocks: [block(BLOCK_CHAPTER, NODE_CHAPTER), block(BLOCK_UNIT, NODE_UNIT, { block_type: 'vertical', parent_id: id(50), display_name: 'Bài 1' })] });
  // This Apply writes nothing that was edited: proceed, edits stay.
  assert.equal(workspaceApplyOverwriteDecision({ workspace_id: WORKSPACE, drift, write_node_ids: new Set([id(77)]), overwrite_confirmation: null }), null);
  // It would rewrite the edited chapter: ask first.
  const conflict = workspaceApplyOverwriteDecision({ workspace_id: WORKSPACE, drift, write_node_ids: new Set([NODE_CHAPTER]), overwrite_confirmation: null });
  assert.ok(conflict instanceof WorkspaceApplyConflictError);
  assert.equal(conflict.code, 'WORKSPACE_APPLY_COURSE_EDITED');
  assert.deepEqual(conflict.details.items, [{ node_id: NODE_CHAPTER, kind: 'chapter', title: 'Chương 1 — đã sửa' }]);
  assert.equal(conflict.details.total, 1);
  const token = conflict.details.overwrite_confirmation!;
  assert.match(token, /^[0-9a-f]{64}$/);
  // Confirmed: proceed (the compiler then rewrites exactly these blocks).
  assert.equal(workspaceApplyOverwriteDecision({ workspace_id: WORKSPACE, drift, write_node_ids: new Set([NODE_CHAPTER]), overwrite_confirmation: token }), null);
  // Edited again after the dialog: the old confirmation is stale, ask again.
  const again = classifyWorkspaceApplyDrift({ workspace_id: WORKSPACE, nodes,
    mappings: [mapping(NODE_CHAPTER, BLOCK_CHAPTER, { actual_target_hash: h('d') })], blocks: [block(BLOCK_CHAPTER, NODE_CHAPTER)] });
  const stale = workspaceApplyOverwriteDecision({ workspace_id: WORKSPACE, drift: again, write_node_ids: new Set([NODE_CHAPTER]), overwrite_confirmation: token });
  assert.ok(stale); assert.notEqual(stale.details.overwrite_confirmation, token);
  assert.notEqual(workspaceApplyOverwriteToken(WORKSPACE, [{ node_id: NODE_CHAPTER, actual_target_hash: h('b') }]),
    workspaceApplyOverwriteToken(id(55), [{ node_id: NODE_CHAPTER, actual_target_hash: h('b') }]), 'bound to the workspace');
  const many = Array.from({ length: WORKSPACE_APPLY_CONFLICT_ITEM_LIMIT + 5 }, (_, i) => ({ node_id: id(1000 + i), kind: 'component' as const,
    title: `C${i}`, canonical_path: `chapter_1.lesson_1.unit_1.component_${i}`, actual_target_hash: h('e') }));
  const big = workspaceApplyOverwriteDecision({ workspace_id: WORKSPACE, drift: { content: many, structural: [] },
    write_node_ids: new Set(many.map(item => item.node_id)), overwrite_confirmation: null })!;
  assert.equal(big.details.items.length, WORKSPACE_APPLY_CONFLICT_ITEM_LIMIT); assert.equal(big.details.total, many.length);
});

// ── HTTP mapping ──────────────────────────────────────────────────────────

function fakeRes() {
  return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; } };
}
function applyReq(body: Record<string, unknown>, locale = 'vi') {
  return { user: actor(EDITOR), params: { courseId: COURSE, conversationId: CONVERSATION, workspaceId: WORKSPACE, nodeId: NODE_CHAPTER },
    query: { ui_locale: locale }, body } as unknown as Request;
}

test('Apply answers busy and edited-course conflicts with plain localized messages and the item list', async () => {
  const seen: unknown[] = [];
  let failure: unknown = new WorkspaceApplyError('WORKSPACE_APPLY_COURSE_BUSY');
  const handler = createWorkspaceApplyHandler({ enabled: () => true, report: () => undefined,
    apply: async (_user, _target, _revision, options) => { seen.push(options); throw failure; } });
  const busy = fakeRes();
  await handler(applyReq({ operation_id: OPERATION, expected_workspace_revision: 3 }, 'en'), busy as unknown as Response);
  assert.equal(busy.statusCode, 409);
  assert.equal((busy.body as { code: string }).code, 'WORKSPACE_APPLY_COURSE_BUSY');
  assert.equal((busy.body as { message: string }).message, 'Someone else is adding content to this course right now. Please try again in a few minutes.');
  assert.deepEqual(seen[0], { overwriteConfirmation: null });

  failure = new WorkspaceApplyConflictError('WORKSPACE_APPLY_COURSE_EDITED', { items: [{ node_id: NODE_CHAPTER, kind: 'chapter', title: 'Chương 1' }],
    total: 1, overwrite_confirmation: h('f') });
  const edited = fakeRes();
  await handler(applyReq({ operation_id: OPERATION, expected_workspace_revision: 3, overwrite_confirmation: h('9') }), edited as unknown as Response);
  assert.equal(edited.statusCode, 409);
  assert.deepEqual(seen[1], { overwriteConfirmation: h('9') });
  const body = edited.body as { code: string; message: string; conflict: unknown };
  assert.equal(body.code, 'WORKSPACE_APPLY_COURSE_EDITED');
  assert.equal(body.message, WORKSPACE_APPLY_ERRORS.WORKSPACE_APPLY_COURSE_EDITED[1]);
  assert.deepEqual(body.conflict, { items: [{ node_id: NODE_CHAPTER, kind: 'chapter', title: 'Chương 1' }], total: 1, overwrite_confirmation: h('f') });

  const invalid = fakeRes();
  await handler(applyReq({ operation_id: OPERATION, expected_workspace_revision: 3, overwrite_confirmation: 'yes' }), invalid as unknown as Response);
  assert.equal(invalid.statusCode, 400);
  assert.equal(seen.length, 2, 'a malformed confirmation never reaches the transaction');
});

test('new user-facing Apply, session and upload messages contain no status numbers, codes or tech words', () => {
  const added = ['WORKSPACE_APPLY_COURSE_BUSY', 'WORKSPACE_APPLY_COURSE_EDITED', 'WORKSPACE_APPLY_COURSE_STRUCTURE_CHANGED'] as const;
  const messages = [...added.map(code => WORKSPACE_APPLY_ERRORS[code]), ...Object.values(LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS)];
  for (const [, vi, en] of messages) {
    for (const message of [vi, en]) {
      assert.doesNotMatch(message, /\b(4\d\d|5\d\d)\b/);
      assert.doesNotMatch(message, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
      assert.doesNotMatch(message, /\b(AI ID|KB|lock|workspace|revision|hash|snapshot|receipt)\b/i);
    }
    // Everyday English is fine for English readers, never inside Vietnamese text.
    assert.doesNotMatch(vi, /\b(course|draft|apply|file|upload|session)\b/i);
  }
});

// ── Repository: per-course lock, creator binding, structural drift ────────

const SOURCE_UPDATED = '2026-10-01T00:00:00.000Z';
const SNAPSHOT = lessonAuthorSourceSnapshotHash({ tenantId: TENANT, courseId: COURSE }, KB,
  [{ document_id: DOC, name: 'nguon.pdf', status: 'learned', updated_at: SOURCE_UPDATED, source_info: null }]);

interface Script {
  locks: Set<string>;
  /** Wakes an Apply waiting for a course lock once a transaction ends. */
  waiting?: Array<() => void>;
  /** The course lock wait runs out (PostgreSQL lock_timeout, 55P03). */
  lockTimesOut?: boolean;
  /** Any other database failure of the course lock statement. */
  lockFailure?: string;
  calls: Array<{ sql: string; params: unknown[] }>;
  courseGate?: Promise<void>;
  courseMissing?: boolean;
  deleted?: boolean;
  /** The tenant's courses module switch is off. */
  coursesModuleOff?: boolean;
}
function scriptedDb(script: Script) {
  const one = (row: Record<string, unknown>) => ({ rows: [row], rowCount: 1 });
  const none = { rows: [] as Record<string, unknown>[], rowCount: 0 };
  return { transaction: async <T>(work: (tx: GenerationJobSql) => Promise<T>): Promise<T> => {
    const held: string[] = [];
    const tx = { query: async (sql: string, params: unknown[] = []) => {
      script.calls.push({ sql, params });
      if (sql.includes('FROM users u JOIN tenants t')) {
        const role = params[0] === SUPERUSER ? 'superuser' : 'staff';
        return one({ role, tenant_id: TENANT, is_active: true, tenant_active: true });
      }
      if (sql.includes('SELECT pgm.can_edit')) return params[0] === NO_EDIT ? none : one({ can_edit: true });
      if (sql.includes('FROM modules m WHERE')) return one({ id: id(40), is_active: true });
      if (sql.includes('FROM tenant_modules tm')) return one({ is_enabled: !script.coursesModuleOff });
      if (sql.startsWith('SET LOCAL')) return none;
      if (sql.includes('pg_advisory_xact_lock')) {
        // PostgreSQL semantics: wait while another transaction holds the key,
        // until lock_timeout cancels the statement.
        const key = String(params[0]);
        if (script.lockFailure) throw Object.assign(new Error('lock statement failed'), { code: script.lockFailure });
        while (script.locks.has(key)) {
          if (script.lockTimesOut) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
          await new Promise<void>(resolve => (script.waiting ??= []).push(resolve));
        }
        script.locks.add(key); held.push(key); return one({ pg_advisory_xact_lock: '' });
      }
      if (sql.includes('SELECT id,display_name FROM courses')) {
        if (script.courseGate) await script.courseGate;
        return script.courseMissing ? none : one({ id: COURSE, display_name: 'Khoá học' });
      }
      if (sql.includes('SELECT c.user_id::text AS creator_id')) return one({ creator_id: CREATOR, title: 'Phiên của người tạo', full_name: 'Người Tạo', username: 'tao' });
      if (sql.includes('FROM lesson_author_session_deletion_jobs')) return none;
      if (sql.includes('LEFT JOIN lesson_author_blueprints b ON')) return one({ id: WORKSPACE, status: 'ready', event_head: 7, content_locale: 'vi',
        correlation_id: CORRELATION, source_snapshot_hash: SNAPSHOT, runtime_config_hash: h('7'), blueprint_id: null, blueprint: null,
        blueprint_source_hash: null, v2_run_id: RUN });
      if (sql.startsWith('SELECT id FROM lesson_author_workspace_v2_runs')) return one({ id: RUN });
      if (sql.includes('idempotency_key=$4')) return none;
      if (sql.includes('SELECT id,kind,canonical_path FROM lesson_author_workspace_nodes')) return one({ id: NODE_CHAPTER, kind: 'chapter', canonical_path: 'chapter_1' });
      if (sql.includes('SELECT w.kb_id,w.bot_id,w.source_document_ids')) return one({ kb_id: KB, bot_id: BOT, source_document_ids: [DOC], source_snapshot_hash: SNAPSHOT, blueprint_id: null });
      if (sql.includes('s.id::text AS snapshot_id')) return one({ run_id: RUN, snapshot_id: id(20), snapshot_status: 'sealed', source_snapshot_hash: SNAPSHOT, source_document_ids: [DOC] });
      if (sql.includes('SELECT a.bot_id FROM tenant_bot_assignments')) return one({ bot_id: BOT });
      if (sql.includes('SELECT a.kb_id FROM tenant_kb_assignments')) return one({ kb_id: KB });
      if (sql.includes('SELECT d.id::text AS document_id,d.name')) return one({ document_id: DOC, name: 'nguon.pdf', status: 'learned', type: 'file', updated_at: SOURCE_UPDATED, source_info: null });
      if (sql.includes('SELECT settings FROM tenants')) return one({ settings: null });
      if (sql.includes("kind='course' AND canonical_path='course'")) return one({ id: COURSE_NODE });
      if (sql.includes('SELECT n.id AS node_id,n.parent_id')) return one({ node_id: NODE_CHAPTER, parent_id: COURSE_NODE, kind: 'chapter', canonical_path: 'chapter_1',
        sort_order: 0, content_state: 'content_ready', current_revision: 0, protected_contract: {}, contract_hash: h('c'),
        baseline_content: null, baseline_hash: null, current_content: null, current_hash: null });
      if (sql.includes("artifact_kind IN ('architecture_validation','inventory_receipt')")) return { rows: [
        { artifact_kind: 'architecture_validation', artifact_hash: h('1'), payload: {} }, { artifact_kind: 'inventory_receipt', artifact_hash: h('2'), payload: {} }], rowCount: 2 };
      if (sql.includes("t.kind='generate_unit'") || sql.includes("t.kind='validate_chapter'")) return none;
      if (sql.includes("parent_id IS NULL AND block_type='course'")) return one({ id: ROOT });
      if (sql.startsWith('SELECT workspace_course_block_hash($1::uuid')) return one({ hash: h('0') });
      if (sql.includes('ORDER BY b.id FOR UPDATE OF b')) return none;
      if (sql.includes('JOIN lesson_author_workspace_apply_receipts r ON r.id=m.receipt_id')) return one({ node_id: NODE_CHAPTER, target_block_id: BLOCK_CHAPTER,
        target_parent_id: ROOT, target_block_type: 'chapter', target_sort_order: 3, applied_revision: 0, applied_content_hash: h('c'),
        target_hash: h('a'), revision_manifest: [], actual_target_hash: script.deleted ? null : h('a') });
      if (sql.includes('SELECT b.id::text AS id,b.display_name')) return one({ id: BLOCK_CHAPTER, display_name: 'Chương 1', block_type: 'chapter',
        parent_id: ROOT, sort_order: 3, deleted: true, workspace_id: WORKSPACE, workspace_node_id: NODE_CHAPTER, generated_by: 'lesson_author_ai' });
      throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
    } } as unknown as GenerationJobSql;
    try { return await work(tx); } finally {
      for (const key of held) script.locks.delete(key);
      for (const wake of (script.waiting ?? []).splice(0)) wake();
    }
  } };
}
const target = (userId: string) => ({ tenantId: TENANT, userId, courseId: COURSE, conversationId: CONVERSATION, workspaceId: WORKSPACE,
  nodeId: NODE_CHAPTER, operationId: OPERATION });

const COURSE_LOCK_WAIT = "SET LOCAL lock_timeout = '20000ms'";
const APPLY_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '3000ms'";

test('a second Apply of the same course waits for the first one and then runs, never together with it', async () => {
  let open!: () => void;
  const script: Script = { locks: new Set(), calls: [], courseGate: new Promise<void>(resolve => { open = resolve; }), courseMissing: true };
  const repository = createWorkspaceApplyRepository({ db: scriptedDb(script) });
  const first = repository.apply(actor(CREATOR), target(CREATOR), 7);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(script.locks.size, 1, 'first Apply holds the course lock');
  let secondSettled = false;
  const second = repository.apply(actor(EDITOR), target(EDITOR), 7).finally(() => { secondSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false, 'the second Apply waits in line instead of being refused at once');
  assert.equal(script.calls.filter(call => call.sql.includes('SELECT id,display_name FROM courses')).length, 1,
    'only the first Apply has gone past the course lock');
  open();
  await assert.rejects(first, { code: 'WORKSPACE_APPLY_NOT_FOUND' });
  await assert.rejects(second, { code: 'WORKSPACE_APPLY_NOT_FOUND' }, 'the second one ran after the first released the lock');
  assert.equal(script.locks.size, 0, 'released with the transaction');
  const sqls = script.calls.map(call => call.sql);
  const lockCalls = script.calls.filter(call => call.sql.includes('pg_advisory_xact_lock'));
  assert.equal(lockCalls.length, 2);
  assert.deepEqual(new Set(lockCalls.map(call => call.params[0])), new Set([`course:${TENANT}:${COURSE}`]));
  assert.equal(sqls.some(sql => sql.includes('pg_try_advisory_xact_lock')), false, 'never the refuse-at-once lock');
  // Each Apply: bounded wait, lock, then the short lock timeout is back before
  // any course row is read (the second Apply's restore runs only once it holds the lock).
  const lockAts = sqls.flatMap((sql, index) => sql.includes('pg_advisory_xact_lock') ? [index] : []);
  for (const index of lockAts) {
    assert.equal(sqls[index - 1], COURSE_LOCK_WAIT, 'the wait has a time limit');
    assert.equal(sqls[index + 1], APPLY_LOCK_TIMEOUT, 'the short lock timeout is restored right after');
    assert.match(sqls[index + 2] ?? '', /SELECT id,display_name FROM courses/);
  }
  assert.equal(sqls.some(sql => sql.startsWith('SET LOCAL') && ![COURSE_LOCK_WAIT, APPLY_LOCK_TIMEOUT].includes(sql)), false);
});

test('an Apply whose bounded wait runs out gets the busy answer and runs nothing else', async () => {
  const script: Script = { locks: new Set([`course:${TENANT}:${COURSE}`]), calls: [], lockTimesOut: true };
  const repository = createWorkspaceApplyRepository({ db: scriptedDb(script) });
  await assert.rejects(repository.apply(actor(EDITOR), target(EDITOR), 7), { code: 'WORKSPACE_APPLY_COURSE_BUSY' });
  const sqls = script.calls.map(call => call.sql);
  const lockAt = sqls.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
  assert.equal(sqls[lockAt - 1], COURSE_LOCK_WAIT, 'the wait has a time limit');
  assert.equal(sqls.length, lockAt + 1, 'nothing runs after the wait ran out');
});

test('any other failure of the course lock statement is not reported as busy', async () => {
  const script: Script = { locks: new Set(), calls: [], lockFailure: '57014' };
  const repository = createWorkspaceApplyRepository({ db: scriptedDb(script) });
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await assert.rejects(repository.apply(actor(EDITOR), target(EDITOR), 7), { code: 'WORKSPACE_APPLY_UNAVAILABLE' });
  } finally { console.error = original; }
  assert.equal(logged.length, 1, 'logged once as a persistence failure');
  assert.match(JSON.stringify(logged[0]), /"failure_stage":"course_lock"/);
  assert.match(JSON.stringify(logged[0]), /"sqlstate":"57014"/);
});

test('a staff member without course edit rights cannot Apply, before any lock is taken', async () => {
  const script: Script = { locks: new Set(), calls: [] };
  const repository = createWorkspaceApplyRepository({ db: scriptedDb(script) });
  await assert.rejects(repository.apply(actor(NO_EDIT), target(NO_EDIT), 7), { code: 'WORKSPACE_APPLY_FORBIDDEN' });
  await assert.rejects(repository.apply(actor(EDITOR), target(CREATOR), 7), { code: 'WORKSPACE_APPLY_FORBIDDEN' }, 'actor is never taken from the body');
  assert.equal(script.calls.some(call => call.sql.includes('advisory_xact_lock')), false);
});

test('a tenant whose courses module is turned off cannot Apply, before any lock is taken', async () => {
  const script: Script = { locks: new Set(), calls: [], coursesModuleOff: true };
  const repository = createWorkspaceApplyRepository({ db: scriptedDb(script) });
  await assert.rejects(repository.apply(actor(EDITOR), target(EDITOR), 7), { code: 'WORKSPACE_APPLY_FORBIDDEN' });
  await assert.rejects(repository.apply(actor(SUPERUSER, 'superuser'), target(SUPERUSER), 7), { code: 'WORKSPACE_APPLY_FORBIDDEN' }, 'superuser too');
  assert.equal(script.calls.some(call => call.sql.includes('advisory_xact_lock')), false);
  assert.equal(script.calls.some(call => call.sql.includes('ai_chatbot')), false, 'never the AI module');
});
test('another editor applies the creator\'s session; a deleted course block stops it without overwriting anything', async () => {
  const script: Script = { locks: new Set(), calls: [], deleted: true };
  const audits: unknown[] = [];
  const repository = createWorkspaceApplyRepository({ db: scriptedDb(script), audit: async event => { audits.push(event); } });
  await assert.rejects(repository.apply(actor(EDITOR), target(EDITOR), 7, { overwriteConfirmation: h('f') }), (error: unknown) => {
    assert.ok(error instanceof WorkspaceApplyConflictError);
    assert.equal(error.code, 'WORKSPACE_APPLY_COURSE_STRUCTURE_CHANGED');
    assert.deepEqual(error.details, { items: [{ node_id: NODE_CHAPTER, kind: 'chapter', title: 'Chương 1' }], total: 1, overwrite_confirmation: null });
    return true;
  });
  // Workspace evidence is bound to the session creator, the authority to the actor.
  const workspace = script.calls.find(call => call.sql.includes('LEFT JOIN lesson_author_blueprints b ON'))!;
  assert.equal(workspace.params[4], CREATOR);
  const authority = script.calls.find(call => call.sql.includes('FROM users u JOIN tenants t'))!;
  assert.equal(authority.params[0], EDITOR);
  const deletion = script.calls.find(call => call.sql.includes('FROM lesson_author_session_deletion_jobs'))!;
  assert.deepEqual(deletion.params, [TENANT, COURSE, CONVERSATION], 'any pending deletion of the session blocks Apply');
  // Mapped blocks are locked before their live hash is read.
  const lockAt = script.calls.findIndex(call => call.sql.includes('ORDER BY b.id FOR UPDATE OF b'));
  const hashAt = script.calls.findIndex(call => call.sql.includes('JOIN lesson_author_workspace_apply_receipts r ON r.id=m.receipt_id'));
  assert.ok(lockAt >= 0 && lockAt < hashAt);
  assert.equal(script.calls.some(call => /UPDATE course_blocks|INSERT INTO course_blocks|INSERT INTO lesson_author_workspace_apply_receipts/.test(call.sql)), false);
  assert.equal(audits.length, 0);
});

test('applying someone else\'s session is audited in the same transaction with the actor and the session creator', () => {
  const repository = readFileSync(new URL('./lesson-author-workspace-apply.repository.ts', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('../../../ai-chatbot.routes.ts', import.meta.url), 'utf8');
  assert.match(repository, /if \(session\.userId !== user\.id && deps\.audit\) \{[\s\S]*actorId: user\.id[\s\S]*ownerId: session\.userId[\s\S]*\}\s*failureStage = 'transaction_commit'/);
  assert.ok(repository.indexOf('shared_session_audit') < repository.indexOf("failureStage = 'cache_invalidation'"), 'inside the transaction');
  assert.match(routes, /audit: event => withDatabaseTransaction\(client => appendAuditLog\(client,/);
  assert.match(routes, /code: 'lesson_author\.workspace\.applied_shared'[\s\S]*related_entity_name: event\.ownerName/);
  const normalized = normalizeStructuredAuditEvent({ code: 'lesson_author.workspace.applied_shared', context: { course_id: COURSE,
    course_name: 'Khoá học', related_entity_name: 'Người Tạo', related_entity_type: 'lesson_author_session_creator', affected_count: 4 } });
  assert.equal(normalized.viewerScope, 'tenant');
  assert.deepEqual(normalized.metadata, { course_id: COURSE, course_name: 'Khoá học', related_entity_name: 'Người Tạo', related_entity_type: 'lesson_author_session_creator', affected_count: 4 });
});

test('the receipt names who pressed Apply while actor_id stays the session creator (6a)', () => {
  const repository = readFileSync(new URL('./lesson-author-workspace-apply.repository.ts', import.meta.url), 'utf8');
  const insert = repository.slice(repository.indexOf('INSERT INTO lesson_author_workspace_apply_receipts('));
  assert.match(insert, /mapping_delta,checks,applied_by\)/);
  assert.match(insert, /\$19::jsonb,\$20\)`/);
  assert.match(insert, /target\.nodeId,session\.userId,/, 'actor_id is still the session creator');
  assert.match(insert, /JSON\.stringify\(compiled\.acceptance\.checks\),target\.userId\]\);/, 'applied_by is the caller');
  const read = readFileSync(new URL('../read/lesson-author-workspace-read.repository.ts', import.meta.url), 'utf8');
  assert.match(read, /LEFT JOIN users applier ON applier\.id=COALESCE\(receipt\.applied_by,receipt\.actor_id\)/);
  assert.match(read, /CASE WHEN applier\.tenant_id=receipt\.tenant_id/, 'names only people of the same tenant');
  assert.match(read, /applied_info: row\.applied_at == null \? null :/);
});
