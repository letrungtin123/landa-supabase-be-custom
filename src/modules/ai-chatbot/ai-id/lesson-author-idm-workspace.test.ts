import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { assembleIdmOrchestrationArchitecture, idmAuthorNote } from './lesson-author-idm-architecture.logic.js';
import { idmScopeViewOf } from './lesson-author-idm-scope-view.logic.js';
import { idmFixture, idmShardFixtures } from './lesson-author-idm.fixture.js';
import { prepareOrchestrationV2InventoryIdentity } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash as hash } from './lesson-author-orchestration-v2.logic.js';
import { createWorkspaceEditRepository, type WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import { createWorkspaceStoryboardAcceptance, type WorkspaceStoryboardDiagnostic } from './lesson-author-workspace-storyboard.repository.js';
import { editWorkspaceStoryboard, workspaceStoryboardBoundSeed, workspaceStoryboardView,
  WORKSPACE_AGGREGATE_EDIT } from './lesson-author-workspace-storyboard.logic.js';
import { prepareWorkspaceEdit, type WorkspaceContent, type WorkspaceNodeSnapshot } from './lesson-author-workspace.logic.js';

type Row = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN = uuid(80);
const NOTE = idmAuthorNote(['QA tự động: 1 vấn đề cần xem — phản hồi chưa giải thích lựa chọn B (tiêu chí Q4).'], 8_000);

/** An IDM inventory and the unit revision 0 that generate_unit writes (with the W6 author note). */
function idmWorkspace() {
  const fixture = idmFixture();
  const assembly = assembleIdmOrchestrationArchitecture(fixture.skeleton, idmScopeViewOf(fixture.design),
    idmShardFixtures(fixture).map(item => ({ artifact_hash: item.artifact_hash, shard: item.shard as never })));
  const identity = prepareOrchestrationV2InventoryIdentity({ run_id: RUN, assembly });
  const unitNode = identity.nodes.find(node => node.kind === 'unit')!;
  const unit = assembly.architecture.chapters[0]!.lessons[0]!.units[0]!;
  const generated: WorkspaceContent = { title: unit.title, purpose: unit.purpose, data: {}, implementation_notes: NOTE };
  return { assembly, identity, unitNode, generated };
}

const seedOf = (node: ReturnType<typeof idmWorkspace>['unitNode'], baseline: unknown) => workspaceStoryboardBoundSeed({
  kind: node.kind as 'unit', canonical_path: node.canonical_path, parent_path: node.parent_path,
  sort_order: node.sort_order, binding: node.protected_contract, baseline });

test('an IDM unit binding authenticates the revision 0 that generate_unit wrote, author note included', () => {
  const { identity, unitNode, generated } = idmWorkspace();
  assert.ok(NOTE);
  // The binding formula is unchanged: architecture fields with a null note.
  assert.equal(unitNode.protected_contract.baseline_hash, hash({ ...generated, implementation_notes: null }));
  assert.notEqual(unitNode.protected_contract.baseline_hash, hash(generated), 'revision 0 differs by the note only');
  const seed = seedOf(unitNode, generated);
  assert.deepEqual(seed.baseline, generated);
  const edited = { ...generated, title: 'Tiêu đề do tác giả sửa' };
  assert.deepEqual(editWorkspaceStoryboard(seed, edited), edited);
  assert.equal(workspaceStoryboardView(seed, generated).user_modified, false, 'the AI note is not an author edit');
  assert.equal(workspaceStoryboardView(seed, edited).user_modified, true);
  assert.deepEqual(seedOf(unitNode, { ...generated, implementation_notes: null }).baseline.implementation_notes, null);
  // Every architecture field stays bound.
  for (const tampered of [{ ...generated, title: 'Khác' }, { ...generated, purpose: 'Khác' },
    { ...generated, purpose: null }]) {
    assert.throws(() => seedOf(unitNode, tampered), { code: 'WORKSPACE_CONTRACT_INVALID' });
  }
  // Only units: course/chapter/lesson notes are inventory-time content and stay bound.
  for (const node of identity.nodes.filter(item => ['course', 'chapter', 'lesson'].includes(item.kind))) {
    const baseline = node.baseline!;
    assert.doesNotThrow(() => seedOf(node, baseline));
    assert.throws(() => seedOf(node, { ...baseline, implementation_notes: `${baseline.implementation_notes ?? ''} thêm` }),
      { code: 'WORKSPACE_CONTRACT_INVALID' }, node.canonical_path);
  }
});

function storyboardHarness() {
  const { assembly, identity, unitNode, generated } = idmWorkspace();
  const target = { tenantId: uuid(1), userId: uuid(2), conversationId: uuid(3), workspaceId: uuid(4),
    nodeId: unitNode.id, operationId: uuid(6), courseId: 'course-v1:IDM+UNIT+2026' };
  const node: WorkspaceNodeSnapshot = { node_id: unitNode.id, kind: 'unit', content_state: 'content_ready',
    current_revision: 0, baseline: structuredClone(generated), current: structuredClone(generated) };
  const revisions: Row[] = [{ revision: 0, origin: 'ai_baseline', parent_revision: null, user_modified: false,
    content: generated, content_hash: hash(generated) }];
  const logs: WorkspaceStoryboardDiagnostic[] = [];
  const writes: string[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    let rows: Row[];
    if (sql.startsWith('SELECT w.blueprint_id::text')) {
      rows = [{ blueprint_id: null, id: unitNode.id, parent_id: unitNode.parent_id, kind: 'unit',
        canonical_path: unitNode.canonical_path, sort_order: unitNode.sort_order, current_revision: 0,
        protected_contract: unitNode.protected_contract, contract_hash: unitNode.contract_hash,
        parent_path: unitNode.parent_path, parent_kind: 'lesson' }];
    } else if (sql.startsWith('SELECT r.id::text AS run_id')) {
      rows = [{ run_id: RUN, payload: assembly, artifact_hash: assembly.assembly_hash }];
    } else if (sql.startsWith('SELECT id FROM courses')) rows = [{ id: target.courseId }];
    else if (sql.includes('FROM lesson_author_session_deletion_jobs')) rows = [];
    else if (sql.startsWith('SELECT w.id,w.status')) {
      rows = [{ id: target.workspaceId, status: 'ready', contract_version: 1, content_locale: 'vi',
        correlation_id: uuid(90), source_snapshot_hash: assembly.source_snapshot_hash }];
    } else if (sql.startsWith('SELECT id,kind,content_state')) {
      rows = [{ ...node, id: unitNode.id, protected_contract: unitNode.protected_contract,
        contract_hash: unitNode.contract_hash }];
    } else if (sql.startsWith('SELECT revision,parent_revision')) rows = revisions.filter(r => r.revision === params[4]);
    else { writes.push(sql); throw new Error('UNEXPECTED_TEST_QUERY'); }
    return { rows: structuredClone(rows) as T[], rowCount: rows.length };
  } };
  const validate = createWorkspaceStoryboardAcceptance(event => { logs.push(event); });
  const context = (): WorkspaceEditContext => ({ target, correlation_id: uuid(90), content_locale: 'vi',
    source_snapshot_hash: assembly.source_snapshot_hash, contract_hash: unitNode.contract_hash,
    protected_contract: unitNode.protected_contract, node: structuredClone(node) });
  const db: GenerationJobDatabase = { transaction: work => work(tx) };
  const repo = createWorkspaceEditRepository({ db, canEdit: async () => true,
    currentSourceHash: async () => assembly.source_snapshot_hash, validate });
  return { identity, target, tx, validate, context, repo, revisions, logs, writes };
}

test('an IDM unit authenticates for review, but Save/Reset stay component-only (WORKSPACE_EDIT_STATE_INVALID)', async () => {
  const h = storyboardHarness();
  const ctx = h.context();
  const receipt = await h.validate(h.tx, ctx, prepareWorkspaceEdit(ctx.node,
    { expected_revision: 0, changes: { title: 'Tiêu đề do tác giả sửa' } }));
  assert.equal(receipt.validation_contract, WORKSPACE_AGGREGATE_EDIT);
  assert.equal(h.logs[0]!.status, 'PASS_METADATA_ONLY', 'no contract failure on the AI-written note');
  await assert.rejects(h.repo.save(h.target, { expected_revision: 0, changes: { title: 'Không được sửa' } }),
    { code: 'WORKSPACE_EDIT_STATE_INVALID' });
  await assert.rejects(h.repo.reset({ ...h.target, operationId: uuid(7) }, 0), { code: 'WORKSPACE_EDIT_STATE_INVALID' });
  assert.deepEqual([h.revisions.length, h.writes.length], [1, 0], 'nothing written');
});
