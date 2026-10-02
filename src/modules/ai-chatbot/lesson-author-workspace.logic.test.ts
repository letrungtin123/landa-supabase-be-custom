import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  WORKSPACE_CONTRACT_VERSION, WORKSPACE_CONTENT_MAX_BYTES, WorkspaceContractError,
  workspaceLocale, readWorkspaceContent, prepareWorkspaceEdit, prepareWorkspaceReset,
  assertWorkspaceParent, assertWorkspaceApplyReady, workspaceEventCursor,
  type WorkspaceNodeSnapshot, type WorkspaceApplyValidation, type WorkspaceContent,
} from './lesson-author-workspace.logic.js';

function rejects(code: string, fn: () => unknown) {
  assert.throws(fn, e => e instanceof WorkspaceContractError && e.code === code && e.message === code);
}
function node(locale: 'vi' | 'en' = 'vi'): WorkspaceNodeSnapshot {
  const content: WorkspaceContent = { title: locale === 'vi' ? 'Câu hỏi' : 'Question',
    purpose: null, data: { question: 'Q', options: ['A', 'B'], answer: 'A' }, implementation_notes: null };
  return { node_id: 'node-id', kind: 'component', content_state: 'content_ready',
    current_revision: 0, baseline: structuredClone(content), current: structuredClone(content) };
}
const h = (letter: string) => letter.repeat(64);
function ready() {
  const proof: WorkspaceApplyValidation = { scope_id: 'unit-1', revision_set_hash: h('a'),
    source_snapshot_hash: h('b'), target_snapshot_hash: h('c'),
    checks: { schema: 'PASS', evidence: 'PASS', pedagogy: 'PASS', coverage: 'PASS',
      duplicates: 'PASS', dependencies: 'PASS', registry: 'PASS' } };
  return { scope_id: 'unit-1', kind: 'unit' as const, complete: true,
    revision_set_hash: h('a'), source_snapshot_hash: h('b'), target_snapshot_hash: h('c'), validation: proof };
}

test('workspace version is separate; EN/VI is explicit, immutable by an edit', () => {
  assert.equal(WORKSPACE_CONTRACT_VERSION, 1);
  for (const locale of ['vi', 'en'] as const) {
    assert.equal(workspaceLocale(locale), locale);
    assert.equal(prepareWorkspaceEdit(node(locale), { expected_revision: 0, changes: { purpose: 'Edited' } }).content.title, node(locale).current!.title);
  }
  for (const value of ['fr', 'en-US', '', undefined, null]) rejects('WORKSPACE_LOCALE_INVALID', () => workspaceLocale(value));
  rejects('WORKSPACE_NODE_FIELD_PROTECTED', () => prepareWorkspaceEdit(node(), { expected_revision: 0, changes: { locale: 'en' } }));
});

test('ready edit returns a detached pending candidate, preserving AI baseline and provenance authority', () => {
  const original = node(); const before = structuredClone(original);
  const result = prepareWorkspaceEdit(original, { expected_revision: 0, changes: { title: 'Edited' } });
  assert.equal(result.revision, 1); assert.equal(result.parent_revision, 0);
  assert.equal(result.user_modified, true); assert.equal(result.validation_state, 'pending');
  assert.match(result.content_hash, /^[a-f0-9]{64}$/);
  (result.content.data as { question: string }).question = 'changed copy';
  assert.deepEqual(original, before);
});

test('planned/generating/failed content cannot edit; stale revision does not win', () => {
  for (const state of ['planned', 'generating', 'needs_action'] as const) {
    rejects('WORKSPACE_NODE_NOT_READY', () => prepareWorkspaceEdit({ ...node(), content_state: state }, { expected_revision: 0, changes: { title: 'X' } }));
  }
  for (const revision of [-1, 1, 0.5, '0', undefined, NaN]) {
    rejects('WORKSPACE_REVISION_CONFLICT', () => prepareWorkspaceEdit(node(), { expected_revision: revision, changes: { title: 'X' } }));
  }
  rejects('WORKSPACE_NODE_NOT_READY', () => prepareWorkspaceReset({ ...node(), baseline: null }, 0));
});

test('all structural and ownership mutations fail closed, including nested forgery', () => {
  for (const field of ['node_id', 'parent_id', 'sort_order', 'type', 'source_fact_ids', 'source_refs',
    'primary_evidence_scope_ids', 'supporting_evidence_scope_ids', 'learning_objective_refs', 'component_plan_id']) {
    rejects('WORKSPACE_NODE_FIELD_PROTECTED', () => prepareWorkspaceEdit(node(), { expected_revision: 0, changes: { [field]: 'forged' } }));
  }
  for (const field of ['source_fact_ids', 'source_refs', 'tenant_id', 'primary_evidence_scope_ids']) {
    rejects('WORKSPACE_NODE_FIELD_PROTECTED', () => prepareWorkspaceEdit(node(), { expected_revision: 0, changes: { data: { nested: [{ [field]: [] }] } } }));
  }
  rejects('WORKSPACE_NODE_FIELD_PROTECTED', () => prepareWorkspaceEdit(node(), { expected_revision: 0, changes: { title: 'X' }, apply: true }));
});

test('JSON safety rejects cycles, prototype keys, getters, non-JSON and oversized content', () => {
  const bad: unknown[] = [undefined, NaN, Infinity, new Date(), () => 1];
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; bad.push(cycle);
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => { throw Error('must not execute'); } }); bad.push(getter);
  for (const value of bad) rejects('WORKSPACE_CONTENT_INVALID', () => readWorkspaceContent({ ...node().current, data: value }));
  rejects('WORKSPACE_NODE_FIELD_PROTECTED', () => readWorkspaceContent({ ...node().current, data: JSON.parse('{"__proto__":{"admin":true}}') }));
  rejects('WORKSPACE_CONTENT_INVALID', () => readWorkspaceContent({ ...node().current, data: 'a'.repeat(WORKSPACE_CONTENT_MAX_BYTES) }));
  rejects('WORKSPACE_CONTENT_INVALID', () => readWorkspaceContent({ ...node().current, title: ' ' }));
});

test('Reset is a new revision to original AI baseline, not an Apply or history deletion', () => {
  const n = node(); n.current = { ...n.current!, title: 'Human title' }; n.current_revision = 7;
  const before = structuredClone(n); const reset = prepareWorkspaceReset(n, 7);
  assert.deepEqual(reset.content, n.baseline); assert.equal(reset.revision, 8);
  assert.equal(reset.origin, 'author_reset'); assert.equal(reset.user_modified, false);
  assert.equal(reset.validation_state, 'pending'); assert.deepEqual(n, before);
  assert.equal('course_block_id' in reset, false);
});

test('user_modified depends on JSON value, not object-key order or a client flag', () => {
  const n = node(); const result = prepareWorkspaceEdit(n, { expected_revision: 0,
    changes: { data: { answer: 'A', options: ['A', 'B'], question: 'Q' } } });
  assert.equal(result.user_modified, false);
  rejects('WORKSPACE_NODE_FIELD_PROTECTED', () => prepareWorkspaceEdit(n, { expected_revision: 0, changes: { user_modified: false } }));
});

test('supported component envelopes round-trip without a second text copy; not payload acceptance', () => {
  const payloads = ['<p>Teaching</p>', { question: 'Q', answer: 'A' }, { items: [{ question: 'Q', answer: 'A' }] },
    { steps: ['A', 'B'] }, { words: [{ answer: 'TEAM', clue: 'Group' }] }, { nodes: [{ id: 'n1', label: 'A' }], edges: [] }];
  for (const data of payloads) assert.deepEqual(readWorkspaceContent({ ...node().current, data }).data, data);
});

test('hierarchy allows media under unit, never component ownership of structural children', () => {
  for (const [kind, parent] of [['course', null], ['chapter', 'course'], ['lesson', 'chapter'], ['unit', 'lesson'], ['component', 'unit'], ['media_brief', 'unit']] as const) assertWorkspaceParent(kind, parent);
  rejects('WORKSPACE_CONTRACT_INVALID', () => assertWorkspaceParent('unit', 'course'));
  rejects('WORKSPACE_CONTRACT_INVALID', () => assertWorkspaceParent('media_brief', 'component'));
});

test('Apply accepts four materializable hierarchy scopes and binds every revision/source/target gate', () => {
  for (const kind of ['chapter', 'lesson', 'unit', 'component'] as const) assertWorkspaceApplyReady({ ...ready(), kind });
  for (const kind of ['course', 'media_brief'] as const) rejects('WORKSPACE_APPLY_SCOPE_INVALID', () => assertWorkspaceApplyReady({ ...ready(), kind }));
  rejects('WORKSPACE_APPLY_VALIDATION_REQUIRED', () => assertWorkspaceApplyReady({ ...ready(), complete: false }));
  rejects('WORKSPACE_APPLY_VALIDATION_REQUIRED', () => assertWorkspaceApplyReady({ ...ready(), validation: null }));
  rejects('WORKSPACE_APPLY_VALIDATION_REQUIRED', () => assertWorkspaceApplyReady({ ...ready(), revision_set_hash: h('d') }));
  rejects('WORKSPACE_SOURCE_CHANGED', () => assertWorkspaceApplyReady({ ...ready(), source_snapshot_hash: h('d') }));
  rejects('WORKSPACE_APPLY_TARGET_CHANGED', () => assertWorkspaceApplyReady({ ...ready(), target_snapshot_hash: h('d') }));
  for (const key of Object.keys(ready().validation.checks) as Array<keyof WorkspaceApplyValidation['checks']>) {
    for (const outcome of ['FAIL', 'NOT_RUN'] as const) {
      const input = ready(); input.validation.checks[key] = outcome;
      rejects('WORKSPACE_APPLY_VALIDATION_REQUIRED', () => assertWorkspaceApplyReady(input));
    }
  }
});

test('cursor replay is read-only; missing/expired/future sequence needs a fresh snapshot', () => {
  assert.equal(workspaceEventCursor(0, 1, 0), 0);
  assert.equal(workspaceEventCursor(4, 3, 9), 4);
  for (const after of [0, 10, -1, '4', null]) rejects('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED', () => workspaceEventCursor(after, 3, 9));
});

test('foundation module has no DB/provider/runtime imports or implicit course writes', () => {
  const source = readFileSync(new URL('./lesson-author-workspace.logic.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:database|chat\.service|ai-rag-client|env\.js)/);
  assert.doesNotMatch(source, /\b(?:fetch|setInterval|setTimeout)\(/);
});

const sql = readFileSync(new URL('../../../../supabase/manual_sql/20260929_1611_lesson_author_workspace_foundation.sql', import.meta.url), 'utf8');
const install = sql.split('-- MANUAL VERIFICATION')[0];
test('manual SQL foundation is additive, transactional and has no runtime/Apply/provider mutation', () => {
  assert.match(install, /BEGIN;/); assert.match(install, /COMMIT;/);
  assert.equal((install.match(/CREATE TABLE public\./g) ?? []).length, 4);
  assert.doesNotMatch(install, /(?:UPDATE|DELETE FROM|INSERT INTO|ALTER TABLE) public\.(?:courses|course_blocks|lesson_author_blueprints|ai_token_reservations)\b/i);
  assert.doesNotMatch(install, /CREATE POLICY|SECURITY DEFINER|GRANT .* TO (?:PUBLIC|anon|authenticated)/i);
  assert.match(sql, /Refusing rollback of nonempty workspace history/);
  assert.doesNotMatch(install, /DROP (?:TABLE|FUNCTION)/i);
});

test('SQL registers all four scoped relations for RLS, quota and course deletion fencing', () => {
  assert.match(install, /'lesson_author_workspaces','lesson_author_workspace_nodes',\s*'lesson_author_workspace_revisions','lesson_author_workspace_events'/);
  for (const guard of ['ENABLE ROW LEVEL SECURITY', 'REVOKE ALL ON TABLE', 'assert_active_course_deletion_fence',
    'tenant_data_quota_table_registry', 'tenant_data_quota_ownership_manifest',
    'tenant_data_quota_direct_insert', 'tenant_data_quota_direct_update', 'tenant_data_quota_direct_delete']) {
    assert.ok(install.includes(guard), guard);
  }
  assert.match(install, /v\.user_id=NEW\.requested_by/);
  assert.match(install, /b\.source_snapshot_hash=NEW\.source_snapshot_hash/);
  assert.match(install, /b\.blueprint->>'architecture_contract_version'='5'/);
  assert.match(install, /content_locale IN \('vi','en'\)/);
});

test('SQL baseline/reset/CAS, node inventory seal and event cursor are protected', () => {
  for (const invariant of ['Revisions are append only', 'Workspace revision conflict',
    'Reset must restore exact AI baseline', 'User modified flag must match content',
    'Node structure and provenance are immutable', 'Accepted workspace inventory is sealed',
    'Overview must precede structure', 'Event sequence is server allocated',
    'Workspace cursor requires a committed event']) assert.ok(install.includes(invariant), invariant);
  assert.match(install, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(install, /current_revision=NEW\.revision,content_state='content_ready'/);
  assert.match(install, /FOR UPDATE/);
  assert.doesNotMatch(install, /CREATE SEQUENCE|expires_at|interval '7 days'/i);
});
