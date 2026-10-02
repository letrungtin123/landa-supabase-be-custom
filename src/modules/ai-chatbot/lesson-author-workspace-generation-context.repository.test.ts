import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspaceGenerationContext, loadWorkspaceChapterGenerationContext, acceptWorkspaceGeneratedUnit } from './lesson-author-workspace-generation-context.repository.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const path = (i: number) => `chapter_1.lesson_1.unit_${i}`;
const allowed = new Set<CourseComponentType>(['html']);
function generated(i: number): LessonAuthorComponentProposal {
  return { type: 'html', title: `Explanation ${i}`, data: `<p>Concept ${i} describes the relationship between the stated information and its intended meaning. Read the definition carefully, identify its distinguishing characteristics, and compare those characteristics with the explanation provided here. For example, an observation records what is visible, whereas an interpretation explains the significance of that observation. Keep these categories separate when discussing the concept. Explain each distinction in your own words and review the original definition before proceeding to the next topic.</p>`,
    metadata: { component_plan_id: `plan_${i}`, source_fact_ids: [`fact_${i}`], covered_source_fact_ids: [`fact_${i}`], supporting_evidence_fact_ids: [], learning_objective_refs: ['lo_1'] } };
}
function fixture(locale: 'en' | 'vi' = 'en') {
  const blueprint = workspaceInventoryFixture(2, locale), inventory = buildWorkspaceInventory(blueprint, allowed);
  const ids = new Map(inventory.nodes.map((n, i) => [n.canonical_path, uuid(100+i)]));
  const nodes = inventory.nodes.filter(n => n.kind !== 'course').map(n => ({ id: ids.get(n.canonical_path)!, parent_id: ids.get(n.parent_path!), kind: n.kind,
    canonical_path: n.canonical_path, sort_order: n.sort_order, protected_contract: n.protected_contract, contract_hash: n.contract_hash,
    current_revision: n.baseline ? 0 as number | null : null, content_state: n.baseline ? 'content_ready' : 'planned',
    baseline_content: n.baseline, baseline_hash: n.baseline ? hash(n.baseline) : null,
    baseline_origin: n.baseline ? 'ai_baseline' : null, baseline_modified: n.baseline ? false : null }));
  const target = { workspaceId: uuid(1), tenantId: uuid(2), userId: uuid(3), conversationId: uuid(4), nodeId: ids.get(path(1))!, courseId: 'course-v1:TEST+WORKSPACE+2026' };
  const state = { bound: true, source: 'a'.repeat(64), bytes: 10000, corruptCount: false, unitPath: path(1) };
  const queries: string[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string) {
    queries.push(sql); assert.match(sql, /^SELECT /);
    const rows = sql.startsWith('SELECT n.canonical_path') ? state.bound ? [{ canonical_path: state.unitPath, source_snapshot_hash: state.source, correlation_id: uuid(10), content_locale: locale, blueprint }] : []
      : sql.startsWith('SELECT count(*)') ? [{ node_count: String(nodes.length + Number(state.corruptCount)), bytes: String(state.bytes) }] : nodes;
    return { rows: structuredClone(rows) as unknown as T[], rowCount: rows.length };
  } };
  const load = () => loadWorkspaceGenerationContext(tx, target, allowed);
  async function completeFirst() {
    const context = await load(), accepted = acceptWorkspaceGeneratedUnit(context, context.input_context_hash, [generated(1)]);
    for (const b of accepted.baselines) {
      const n = nodes.find(n => n.id === b.node_id)!;
      Object.assign(n, { baseline_content: b.content, baseline_hash: b.content_hash, baseline_origin: 'ai_baseline', baseline_modified: false, current_revision: 0, content_state: 'content_ready' });
    }
    state.unitPath = path(2); target.nodeId = ids.get(path(2))!;
  }
  const chapter = () => loadWorkspaceChapterGenerationContext(tx, target, allowed);
  return { blueprint, nodes, target, state, queries, load, completeFirst, chapter };
}
test('real sealed inventory → exact unit baseline set → next unit AI-only context in EN/VI', async () => {
  for (const locale of ['en','vi'] as const) {
    const f = fixture(locale), first = await f.load(); assert.equal(first.previous.size, 0);
    const accepted = acceptWorkspaceGeneratedUnit(first, first.input_context_hash, [generated(1)]);
    assert.equal(accepted.baselines.length, 2); assert.equal(accepted.chapter_scope_complete, false);
    await f.completeFirst(); const second = await f.load(); assert.equal(second.previous.size, 1);
    assert.equal(second.previous.get(path(1))![0].metadata!.component_plan_id, 'plan_1');
    assert.equal(acceptWorkspaceGeneratedUnit(second, second.input_context_hash, [generated(2)]).chapter_scope_complete, true);
    assert.ok(f.queries.every(q => !/\bINSERT INTO|\bUPDATE .* SET|\bDELETE FROM/.test(q)));
  }
});
test('generation context ignores author overlay but detects source, baseline, inventory and capability changes', async () => {
  const f = fixture(); await f.completeFirst(); const a = await f.load();
  const first = f.nodes.find(n => n.canonical_path === `${path(1)}.component_1`)!;
  first.current_revision = 7; Object.assign(first, { current_content: { title: 'User private edit' } });
  assert.equal((await f.load()).input_context_hash, a.input_context_hash);
  f.state.source = 'b'.repeat(64); const changed = await f.load(); assert.notEqual(changed.input_context_hash, a.input_context_hash);
  assert.throws(() => acceptWorkspaceGeneratedUnit(changed, a.input_context_hash, [generated(2)]), /WORKSPACE_GENERATION_CONTEXT_CHANGED/);
  first.baseline_hash = 'c'.repeat(64); await assert.rejects(f.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
});
test('foreign/missing workspace, wrong target identity and oversized private snapshot are rejected', async () => {
  const a = fixture(); a.state.bound = false; await assert.rejects(a.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
  const b = fixture(); b.target.nodeId = uuid(999); await assert.rejects(b.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
  const c = fixture(); c.state.bytes = 16 * 1024 * 1024 + 1; await assert.rejects(c.load, /WORKSPACE_GENERATION_CONTEXT_TOO_LARGE/);
  const d = fixture(); d.state.corruptCount = true; await assert.rejects(d.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
});
test('partial unit, out-of-order invocation, contract tampering and forbidden overwrite fail closed', async () => {
  const a = fixture(); a.state.unitPath = path(2); a.target.nodeId = a.nodes.find(n => n.canonical_path === path(2))!.id;
  await assert.rejects(a.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
  const b = fixture(); await b.completeFirst(); b.state.unitPath = path(1); b.target.nodeId = b.nodes.find(n => n.canonical_path === path(1))!.id;
  await assert.rejects(b.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
  const c = fixture(); c.nodes.find(n => n.kind === 'component')!.contract_hash = 'f'.repeat(64);
  await assert.rejects(c.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
  const d = fixture(); await d.completeFirst(); d.nodes.find(n => n.canonical_path === path(1))!.baseline_content!.title = 'Forged baseline';
  const n = d.nodes.find(n => n.canonical_path === path(1))!; n.baseline_hash = hash(n.baseline_content);
  await assert.rejects(d.load, /WORKSPACE_GENERATION_CONTEXT_INVALID/);
});
test('post-provider acceptance cannot manufacture missing actual coverage or change component identity', async () => {
  const f = fixture(), context = await f.load(), component = generated(1); component.metadata!.covered_source_fact_ids = [];
  assert.throws(() => acceptWorkspaceGeneratedUnit(context, context.input_context_hash, [component]), /WORKSPACE_BASELINE_VALIDATION_FAILED/);
  const changed = generated(1); changed.metadata!.component_plan_id = 'different';
  assert.throws(() => acceptWorkspaceGeneratedUnit(context, context.input_context_hash, [changed]));
});

test('chapter context requires all units complete, ignores author overlay, preserves immutable baseline and hashes', async () => {
  const f=fixture();await f.completeFirst();
  const context=await f.load(), accepted=acceptWorkspaceGeneratedUnit(context,context.input_context_hash,[generated(2)]);
  f.state.unitPath='chapter_1';f.target.nodeId=f.nodes.find(n=>n.canonical_path==='chapter_1')!.id;
  await assert.rejects(f.chapter,/WORKSPACE_GENERATION_CONTEXT_INVALID/);
  for(const b of accepted.baselines){const n=f.nodes.find(n=>n.id===b.node_id)!;
    Object.assign(n,{baseline_content:b.content,baseline_hash:b.content_hash,baseline_origin:'ai_baseline',baseline_modified:false,current_revision:0,content_state:'content_ready'});
  }
  const complete=await f.chapter();assert.equal(complete.chapterIndex,0);assert.equal(complete.proposal.chapters[0].lessons[0].units.length,2);
  const n=f.nodes.find(n=>n.kind==='component')!;n.current_revision=9;
  assert.equal((await f.chapter()).input_context_hash,complete.input_context_hash);
  assert.ok(complete.targetNodes.some(n=>n.path==='chapter_1'));
  assert.equal(complete.proposal.chapters[0].lessons[0].units[0].components![0].title,generated(1).title);
});
