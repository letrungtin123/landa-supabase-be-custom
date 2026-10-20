import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../../../../types/express.js';
import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { orchestrationV2Hash } from '../../shared/lesson-author-orchestration-v2.logic.js';
import type { WorkspaceContent } from '../../content/lesson-author-workspace.logic.js';
import { createWorkspaceReviewHandlers, WORKSPACE_REVIEW_ERRORS } from './lesson-author-workspace-review.controller.js';
import { readWorkspaceReviewResolveBody, workspaceReviewEvidenceHash, workspaceReviewItem, WorkspaceReviewError,
  type WorkspaceReviewObligationRow } from './lesson-author-workspace-review.logic.js';
import { createWorkspaceReviewRepository, type WorkspaceReviewResolvedAuditEvent } from './lesson-author-workspace-review.repository.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1), OTHER_TENANT = id(2), CREATOR = id(3), EDITOR = id(4), NO_EDIT = id(5), CONVERSATION = id(6);
const WORKSPACE = id(7), RUN = id(8), OBLIGATION = id(9), OTHER_OBLIGATION = id(10), OPERATION = id(11), PROBLEM = id(12);
const HTML = id(13), FOREIGN_PROBLEM = id(14), UNIT_NODE = id(15);
const COURSE = 'course-v1:Nesso+REVIEW+2026';
const UNIT_PATH = 'chapter_2.lesson_1.unit_3';
const actor = (userId: string, tenantId = TENANT): AuthUser => ({ id: userId, role: 'staff', tenantId, username: `u${userId.slice(-2)}`, sessionMode: 'normal' });
const content = (title: string, data: WorkspaceContent['data'] = {}): WorkspaceContent => ({ title, purpose: null, data, implementation_notes: null });
const revision = (value: WorkspaceContent) => ({ content: value, content_hash: orchestrationV2Hash(value) });

// ── Pure logic ────────────────────────────────────────────────────────────

test('resolve body: decision, operation id, optional note; a component only for valid_assessment', () => {
  assert.deepEqual(readWorkspaceReviewResolveBody({ decision: 'approved_replan', operation_id: OPERATION }),
    { decision: 'approved_replan', component_node_id: null, note: null, operation_id: OPERATION });
  assert.deepEqual(readWorkspaceReviewResolveBody({ decision: 'valid_assessment', component_node_id: PROBLEM, note: '  đã đối chiếu  ',
    operation_id: OPERATION }), { decision: 'valid_assessment', component_node_id: PROBLEM, note: 'đã đối chiếu', operation_id: OPERATION });
  for (const body of [null, [], { decision: 'approve', operation_id: OPERATION }, { decision: 'approved_replan' },
    { decision: 'approved_replan', operation_id: 'x' }, { decision: 'valid_assessment', operation_id: OPERATION },
    { decision: 'approved_replan', component_node_id: PROBLEM, operation_id: OPERATION },
    { decision: 'approved_replan', operation_id: OPERATION, note: 'x'.repeat(1001) },
    { decision: 'approved_replan', operation_id: OPERATION, note: 'bad\u0000' },
    { decision: 'approved_replan', operation_id: OPERATION, tenant_id: OTHER_TENANT }]) {
    assert.equal(readWorkspaceReviewResolveBody(body), null, JSON.stringify(body));
  }
});

function obligationRow(overrides: Partial<WorkspaceReviewObligationRow> = {}): WorkspaceReviewObligationRow {
  return { obligation_id: OBLIGATION, status: 'open', resolution_kind: null, resolved_at: null, unit_path: UNIT_PATH,
    required_kind: 'single_choice', reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED', learning_objective_refs: ['lo_2', 'lo_1', 'lo_9'],
    evidence_fact_count: 4, chapter: revision(content('An toàn điện')), lesson: revision(content('Đo lường',
      { learning_objectives: ['Đọc thang đo', 'Chọn dải đo đúng'] })), unit: revision(content('Đồng hồ vạn năng')), ...overrides };
}

test('review item: location by titles, objectives to check and same-lesson questions only', () => {
  const item = workspaceReviewItem(obligationRow(), [
    { node_id: PROBLEM, canonical_path: `${UNIT_PATH}.component_2`, content: content('Câu hỏi chọn dải đo') },
    { node_id: FOREIGN_PROBLEM, canonical_path: 'chapter_2.lesson_1.unit_4.component_1', content: content('Khác') },
  ])!;
  assert.deepEqual(item.location, { chapter: { number: 2, title: 'An toàn điện' }, lesson: { number: 1, title: 'Đo lường' },
    unit: { number: 3, title: 'Đồng hồ vạn năng' }, component: null });
  assert.deepEqual(item.learning_objectives, ['Chọn dải đo đúng', 'Đọc thang đo']);
  assert.deepEqual(item.candidate_components, [{ node_id: PROBLEM, number: 2, title: 'Câu hỏi chọn dải đo' }]);
  assert.equal(item.status, 'open'); assert.equal(item.decision, null);
  assert.equal(JSON.stringify(item).includes('ao2_'), false, 'no internal slot key');
  const resolved = workspaceReviewItem(obligationRow({ status: 'resolved', resolution_kind: 'approved_replan',
    resolved_at: new Date('2026-10-20T01:02:03Z') }), [])!;
  assert.deepEqual([resolved.decision, resolved.resolved_at], ['approved_replan', '2026-10-20T01:02:03.000Z']);
  assert.equal(workspaceReviewItem(obligationRow({ status: 'resolved' }), []), null, 'resolved without a decision is dropped');
  assert.equal(workspaceReviewItem(obligationRow({ unit_path: 'chapter_2' }), []), null);
  assert.equal(workspaceReviewItem(obligationRow({ chapter: null, lesson: null }), [])!.location!.chapter!.title, null);
});

test('evidence hash binds actor, operation, decision, question and note', () => {
  const base = { obligation_id: OBLIGATION, planned_slot_key: `ao2_${'a'.repeat(32)}`, decision: 'approved_replan' as const,
    resolved_node_id: null, resolved_node_revision: null, actor_id: EDITOR, operation_id: OPERATION, note: null };
  const value = workspaceReviewEvidenceHash(base);
  assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(workspaceReviewEvidenceHash({ ...base }), value);
  for (const change of [{ actor_id: CREATOR }, { operation_id: id(99) }, { note: 'x' }, { decision: 'valid_assessment' as const,
    resolved_node_id: PROBLEM, resolved_node_revision: 2 }]) {
    assert.notEqual(workspaceReviewEvidenceHash({ ...base, ...change }), value);
  }
});

// ── Repository with a DB-free fake ───────────────────────────────────────

interface Obligation { id: string; run_id: string; workspace_id: string; tenant_id: string; course_id: string; planned_slot_key: string;
  unit_path: string; status: 'open' | 'resolved'; resolution_kind: string | null; resolution_evidence_hash: string | null;
  resolved_node_id: string | null; resolved_node_revision: number | null; }
interface Store {
  runStatus: string; failureCode: string | null; deleting: boolean; guardFails: boolean;
  obligations: Obligation[];
  nodes: Record<string, { kind: string; canonical_path: string; content_state: string; current_revision: number | null; component_type: string | null }>;
  calls: string[]; updates: unknown[][];
}
function store(): Store {
  const obligation = (oid: string, slot: string): Obligation => ({ id: oid, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT,
    course_id: COURSE, planned_slot_key: `ao2_${slot.repeat(32)}`, unit_path: UNIT_PATH, status: 'open', resolution_kind: null,
    resolution_evidence_hash: null, resolved_node_id: null, resolved_node_revision: null });
  return { runStatus: 'needs_action', failureCode: 'ASSESSMENT_REVIEW_REQUIRED', deleting: false, guardFails: false,
    obligations: [obligation(OBLIGATION, 'a'), obligation(OTHER_OBLIGATION, 'b')],
    nodes: {
      [PROBLEM]: { kind: 'component', canonical_path: `${UNIT_PATH}.component_2`, content_state: 'content_ready', current_revision: 2, component_type: 'problem' },
      [HTML]: { kind: 'component', canonical_path: `${UNIT_PATH}.component_1`, content_state: 'content_ready', current_revision: 0, component_type: 'html' },
      [FOREIGN_PROBLEM]: { kind: 'component', canonical_path: 'chapter_2.lesson_1.unit_4.component_1', content_state: 'content_ready', current_revision: 0, component_type: 'problem' },
    }, calls: [], updates: [] };
}
function fakeDb(s: Store) {
  const rows = (...items: Array<Record<string, unknown>>) => ({ rows: items, rowCount: items.length });
  return { transaction: async <T>(work: (tx: GenerationJobSql) => Promise<T>): Promise<T> => {
    const snapshot = structuredClone(s.obligations);
    const tx = { query: async (sql: string, params: unknown[] = []) => {
      s.calls.push(sql.replace(/\s+/g, ' ').slice(0, 60));
      if (sql.includes('FROM users u JOIN tenants t')) return rows({ role: 'staff', tenant_id: TENANT, is_active: true, tenant_active: true });
      if (sql.includes('FROM modules m WHERE')) return rows({ id: id(40), is_active: true });
      if (sql.includes('FROM tenant_modules tm')) return rows({ is_enabled: true });
      if (sql.includes('SELECT pgm.can_edit')) return params[0] === NO_EDIT ? rows() : rows({ can_edit: true });
      if (sql.startsWith('SET LOCAL')) return rows();
      if (sql.includes('SELECT display_name FROM courses')) return params[1] === TENANT ? rows({ display_name: 'Khoá điện' }) : rows();
      if (sql.includes('SELECT c.user_id::text AS creator_id')) return params[1] === TENANT ? rows({ creator_id: CREATOR, title: 'Phiên A' }) : rows();
      if (sql.includes('FROM lesson_author_session_deletion_jobs')) return s.deleting ? rows({ id: id(50) }) : rows();
      if (sql.includes('SELECT r.id::text AS run_id,r.status AS run_status')) {
        return params[0] === WORKSPACE && params[1] === TENANT && params[4] === CREATOR
          ? rows({ run_id: RUN, run_status: s.runStatus, failure_code: s.failureCode }) : rows();
      }
      if (sql.includes('resolution_evidence_hash,') && sql.includes('FOR UPDATE')) {
        const found = s.obligations.find(o => o.id === params[0] && o.run_id === params[1] && o.workspace_id === params[2]
          && o.tenant_id === params[3] && o.course_id === params[4]);
        return found ? rows({ obligation_id: found.id, planned_slot_key: found.planned_slot_key, unit_path: found.unit_path,
          status: found.status, resolution_evidence_hash: found.resolution_evidence_hash, resolved_node_id: found.resolved_node_id,
          resolved_node_revision: found.resolved_node_revision === null ? null : String(found.resolved_node_revision) }) : rows();
      }
      if (sql.includes("n.protected_contract->>'component_type' AS component_type")) {
        const node = s.nodes[String(params[1])];
        return node && params[0] === WORKSPACE && params[2] === TENANT ? rows({ node_id: params[1], ...node }) : rows();
      }
      if (sql.startsWith('UPDATE lesson_author_workspace_v2_assessment_obligations')) {
        s.updates.push(params);
        if (s.guardFails || s.runStatus !== 'needs_action') throw Object.assign(new Error('guard'), { code: '23514' });
        const found = s.obligations.find(o => o.id === params[0] && o.status === 'open');
        if (!found) return rows();
        Object.assign(found, { status: 'resolved', resolution_kind: params[5], resolution_evidence_hash: params[6],
          resolved_node_id: params[7], resolved_node_revision: params[8] });
        return rows({ id: found.id });
      }
      if (sql.includes('count(*) FILTER')) {
        const mine = s.obligations.filter(o => o.run_id === params[0] && o.tenant_id === params[2]);
        return rows({ total_count: String(mine.length), open_count: String(mine.filter(o => o.status === 'open').length) });
      }
      throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
    } } as unknown as GenerationJobSql;
    try { return await work(tx); } catch (error) { s.obligations = snapshot; throw error; }
  } };
}
const target = { tenantId: TENANT, courseId: COURSE, conversationId: CONVERSATION, workspaceId: WORKSPACE };
const replan = (operation = OPERATION) => ({ decision: 'approved_replan' as const, component_node_id: null, note: null, operation_id: operation });
const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof WorkspaceReviewError ? error.code : String(error); }
  return 'resolved';
};

test('any course editor resolves a held question once; the same operation replays, another one is refused', async () => {
  const s = store(); const audits: WorkspaceReviewResolvedAuditEvent[] = [];
  const repository = createWorkspaceReviewRepository({ db: fakeDb(s), audit: async event => { audits.push(event); } });
  const first = await repository.resolve(actor(EDITOR), target, OBLIGATION, replan());
  assert.deepEqual(first, { obligation_id: OBLIGATION, decision: 'approved_replan', status: 'resolved', replayed: false,
    open_count: 1, total_count: 2 });
  assert.equal(s.updates.length, 1);
  assert.deepEqual(s.updates[0]!.slice(5), ['approved_replan', s.obligations[0]!.resolution_evidence_hash, null, null]);
  assert.deepEqual(audits, [{ tenantId: TENANT, actorId: EDITOR, actorUsername: 'u04', courseId: COURSE, courseName: 'Khoá điện',
    conversationId: CONVERSATION, sessionTitle: 'Phiên A' }]);
  const replay = await repository.resolve(actor(EDITOR), target, OBLIGATION, replan());
  assert.deepEqual([replay.replayed, s.updates.length, audits.length], [true, 1, 1], 'a replay writes nothing');
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, replan(id(77)))), 'WORKSPACE_REVIEW_ALREADY_RESOLVED');
  assert.equal(await code(repository.resolve(actor(CREATOR), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_ALREADY_RESOLVED',
    'another actor never replays someone else\'s decision');
  assert.equal((await repository.resolve(actor(CREATOR), target, OTHER_OBLIGATION, replan(id(78)))).open_count, 0);
});

test('resolve refuses without course-editor authority, outside the tenant, for another item or in the wrong state', async () => {
  const s = store();
  const repository = createWorkspaceReviewRepository({ db: fakeDb(s) });
  assert.equal(await code(repository.resolve(actor(NO_EDIT), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_FORBIDDEN');
  assert.equal(s.calls.some(call => call.includes('lesson_author_workspace_v2_assessment_obligations')), false);
  assert.equal(await code(repository.resolve(actor(EDITOR, OTHER_TENANT), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_NOT_FOUND');
  assert.equal(await code(repository.resolve(actor(EDITOR), { ...target, workspaceId: id(60) }, OBLIGATION, replan())),
    'WORKSPACE_REVIEW_NOT_FOUND');
  assert.equal(await code(repository.resolve(actor(EDITOR), target, id(61), replan())), 'WORKSPACE_REVIEW_ITEM_NOT_FOUND');
  s.obligations[0]!.tenant_id = OTHER_TENANT;
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_ITEM_NOT_FOUND');
  s.obligations[0]!.tenant_id = TENANT;
  s.failureCode = 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID';
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_STATE_INVALID');
  s.failureCode = 'ASSESSMENT_REVIEW_REQUIRED'; s.runStatus = 'ready';
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_STATE_INVALID');
  assert.equal(s.updates.length, 0, 'no write is attempted in a wrong state');
  s.runStatus = 'needs_action'; s.guardFails = true;
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_STATE_INVALID',
    'the DB guard refusing the transition is the same answer');
  assert.equal(s.obligations[0]!.status, 'open');
  s.guardFails = false; s.deleting = true;
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, replan())), 'WORKSPACE_REVIEW_UNAVAILABLE');
});

test('valid_assessment needs a ready Problem of the same lesson and stays bound to the revision it recorded', async () => {
  const s = store();
  const repository = createWorkspaceReviewRepository({ db: fakeDb(s) });
  const valid = (node: string, operation = OPERATION) => ({ decision: 'valid_assessment' as const, component_node_id: node, note: 'ok',
    operation_id: operation });
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, valid(HTML))), 'WORKSPACE_REVIEW_COMPONENT_INVALID');
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, valid(FOREIGN_PROBLEM))), 'WORKSPACE_REVIEW_COMPONENT_INVALID');
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, valid(UNIT_NODE))), 'WORKSPACE_REVIEW_COMPONENT_INVALID');
  s.nodes[PROBLEM]!.content_state = 'generating';
  assert.equal(await code(repository.resolve(actor(EDITOR), target, OBLIGATION, valid(PROBLEM))), 'WORKSPACE_REVIEW_COMPONENT_INVALID');
  s.nodes[PROBLEM]!.content_state = 'content_ready';
  const resolved = await repository.resolve(actor(EDITOR), target, OBLIGATION, valid(PROBLEM));
  assert.equal(resolved.replayed, false);
  assert.deepEqual(s.updates.at(-1)!.slice(7), [PROBLEM, 2]);
  assert.equal(s.obligations[0]!.resolution_evidence_hash, workspaceReviewEvidenceHash({ obligation_id: OBLIGATION,
    planned_slot_key: `ao2_${'a'.repeat(32)}`, decision: 'valid_assessment', resolved_node_id: PROBLEM, resolved_node_revision: 2,
    actor_id: EDITOR, operation_id: OPERATION, note: 'ok' }));
  s.nodes[PROBLEM]!.current_revision = 3;
  assert.equal((await repository.resolve(actor(EDITOR), target, OBLIGATION, valid(PROBLEM))).replayed, true);
});

test('list is bound to the session, says whether review is required and counts progress', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const unit = revision(content('Đồng hồ vạn năng')), lesson = revision(content('Đo lường', { learning_objectives: ['Đọc thang đo'] }));
  const db = { transaction: async <T>(work: (tx: GenerationJobSql) => Promise<T>) => work({ query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('GROUP BY w.id,r.id')) return params[3] === CREATOR
      ? { rows: [{ workspace_id: WORKSPACE, run_id: RUN, run_status: 'needs_action', failure_code: 'ASSESSMENT_REVIEW_REQUIRED',
        total_count: '2', open_count: '1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('cardinality(o.relevant_evidence_fact_ids)')) return { rows: [{ obligation_id: OBLIGATION, status: 'open',
      resolution_kind: null, resolved_at: null, unit_path: UNIT_PATH, required_assessment_kind: 'single_choice',
      unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED', learning_objective_refs: ['lo_1'], evidence_fact_count: '3',
      unit_content: unit.content, unit_hash: unit.content_hash, lesson_content: lesson.content, lesson_hash: lesson.content_hash,
      chapter_content: content('Chương bị sửa'), chapter_hash: 'f'.repeat(64) }], rowCount: 1 };
    if (sql.includes("protected_contract->>'component_type'='problem'")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
  } } as unknown as GenerationJobSql) };
  const repository = createWorkspaceReviewRepository({ db });
  const owner = { tenantId: TENANT, userId: CREATOR, conversationId: CONVERSATION, courseId: COURSE };
  const list = await repository.list(owner, WORKSPACE);
  assert.deepEqual([list.review_required, list.total_count, list.open_count, list.resolved_count, list.has_more], [true, 2, 1, 1, false]);
  assert.deepEqual(list.items[0]!.location, { chapter: { number: 2, title: null }, lesson: { number: 1, title: 'Đo lường' },
    unit: { number: 3, title: 'Đồng hồ vạn năng' }, component: null }, 'a title whose hash does not verify is not shown');
  assert.deepEqual(list.items[0]!.learning_objectives, ['Đọc thang đo']);
  assert.deepEqual(calls[0]!.params, [WORKSPACE, TENANT, CONVERSATION, CREATOR, COURSE]);
  for (const call of calls.slice(1)) assert.ok(call.params.includes(TENANT) && call.params.includes(COURSE), 'every read is tenant/course bound');
  assert.equal(await code(repository.list({ ...owner, userId: EDITOR }, WORKSPACE)), 'WORKSPACE_REVIEW_NOT_FOUND');
});

// ── HTTP boundary ─────────────────────────────────────────────────────────

function fakeRes() {
  return { statusCode: 200, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }, setHeader() { /* not asserted */ } };
}
function handlers(overrides: Partial<Parameters<typeof createWorkspaceReviewHandlers>[0]> = {}) {
  const seen: unknown[] = [], events: Array<Record<string, unknown>> = [];
  const value = createWorkspaceReviewHandlers({ readEnabled: () => true, resolveEnabled: () => true, canRead: async () => true,
    resolveSessionOwner: async () => CREATOR,
    list: async (owner, workspaceId) => { seen.push({ owner, workspaceId }); return { workspace_id: workspaceId, review_required: true,
      total_count: 0, open_count: 0, resolved_count: 0, has_more: false, items: [] }; },
    resolve: async (_user, _target, obligationId, input) => { seen.push({ obligationId, input }); return { obligation_id: obligationId,
      decision: input.decision, status: 'resolved', replayed: false, open_count: 0, total_count: 1 }; },
    report: event => { events.push(event); }, ...overrides });
  return { value, seen, events };
}
const request = (user: AuthUser | null, body: unknown = undefined, locale = 'vi', params: Record<string, string> = {}) => ({ user,
  params: { courseId: COURSE, conversationId: CONVERSATION, workspaceId: WORKSPACE, obligationId: OBLIGATION, ...params },
  query: { ui_locale: locale }, body } as unknown as Request);

test('review HTTP: shared-session list, strict resolve input, gates and plain messages', async () => {
  const ok = handlers();
  const listed = fakeRes();
  await ok.value.list(request(actor(EDITOR)), listed as unknown as Response);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(ok.seen[0], { owner: { tenantId: TENANT, userId: CREATOR, conversationId: CONVERSATION, courseId: COURSE },
    workspaceId: WORKSPACE });
  const resolved = fakeRes();
  await ok.value.resolve(request(actor(EDITOR), { decision: 'approved_replan', operation_id: OPERATION }), resolved as unknown as Response);
  assert.equal(resolved.statusCode, 200);
  assert.equal((resolved.body as { data: { status: string } }).data.status, 'resolved');

  const bad = fakeRes();
  await ok.value.resolve(request(actor(EDITOR), { decision: 'approved_replan', operation_id: OPERATION, extra: 1 }), bad as unknown as Response);
  assert.deepEqual([bad.statusCode, (bad.body as { code: string }).code], [400, 'WORKSPACE_REVIEW_INPUT_INVALID']);
  const learner = fakeRes();
  await ok.value.list(request({ ...actor(EDITOR), role: 'learner_plus' }), learner as unknown as Response);
  assert.equal(learner.statusCode, 403);
  assert.equal(ok.seen.length, 2, 'refused requests never reach the repository');

  const closed = handlers({ resolveEnabled: () => false });
  const disabled = fakeRes();
  await closed.value.resolve(request(actor(EDITOR), { decision: 'approved_replan', operation_id: OPERATION }, 'en'), disabled as unknown as Response);
  assert.deepEqual([disabled.statusCode, (disabled.body as { message: string }).message], [503, 'Reviewing is not enabled.']);
  const noRead = handlers({ canRead: async () => false });
  const forbidden = fakeRes();
  await noRead.value.list(request(actor(EDITOR)), forbidden as unknown as Response);
  assert.equal(forbidden.statusCode, 403);

  const failing = (error: unknown) => handlers({ resolve: async () => { throw error; }, list: async () => { throw error; } });
  for (const [error, status, expected] of [[new WorkspaceReviewError('WORKSPACE_REVIEW_ALREADY_RESOLVED'), 409, 'WORKSPACE_REVIEW_ALREADY_RESOLVED'],
    [new WorkspaceReviewError('WORKSPACE_REVIEW_STATE_INVALID'), 409, 'WORKSPACE_REVIEW_STATE_INVALID'],
    [Object.assign(new Error('quota'), { code: 'LQ001' }), 409, 'TENANT_DATA_LIMIT_REACHED'],
    [new Error('Provider text leaked here'), 503, 'WORKSPACE_REVIEW_UNAVAILABLE']] as const) {
    const run = failing(error), res = fakeRes();
    await run.value.resolve(request(actor(EDITOR), { decision: 'approved_replan', operation_id: OPERATION }), res as unknown as Response);
    assert.deepEqual([res.statusCode, (res.body as { code: string }).code], [status, expected]);
    assert.equal(JSON.stringify([res.body, run.events]).includes('leaked'), false);
  }
  const listFailure = failing(new WorkspaceReviewError('WORKSPACE_REVIEW_UNAVAILABLE')), res = fakeRes();
  await listFailure.value.list(request(actor(EDITOR)), res as unknown as Response);
  assert.equal((res.body as { code: string }).code, 'WORKSPACE_REVIEW_READ_UNAVAILABLE');
});

test('review messages are plain VI/EN without codes or tech words', () => {
  for (const [, vi, en] of Object.values(WORKSPACE_REVIEW_ERRORS)) {
    for (const message of [vi, en]) {
      assert.doesNotMatch(message, /\b(4\d\d|5\d\d)\b|[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
      assert.doesNotMatch(message, /\b(AI ID|workspace|obligation|revision|hash|run|receipt)\b/i);
    }
    assert.doesNotMatch(vi, /\b(course|draft|review|apply|lesson)\b/i);
  }
});
