import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { validateLessonAuthorBlueprintArchitecture } from './lesson-author-blueprint-validator.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
const allowed = new Set<CourseComponentType>(['html', 'problem', 'la_faq', 'la_crossword', 'la_sortable', 'la_diagram']);

test('accepted EN/VI architecture produces exact parent-first inventory, not ready unit placeholders', () => {
  for (const locale of ['en', 'vi'] as const) {
    const b = workspaceInventoryFixture(2, locale), before = structuredClone(b);
    assert.notEqual(validateLessonAuthorBlueprintArchitecture(b, b.source_map).status, 'FAIL');
    const result = buildWorkspaceInventory(b, allowed);
    assert.equal(result.nodes.length, 7); assert.equal(result.unit_count, 2);
    const seen = new Set<string>();
    for (const n of result.nodes) {
      assert.ok(!n.parent_path || seen.has(n.parent_path)); seen.add(n.canonical_path);
      assert.equal(n.baseline !== null, ['course', 'chapter', 'lesson', 'media_brief'].includes(n.kind));
    }
    assert.deepEqual(b, before); assert.deepEqual(buildWorkspaceInventory(b, allowed), result);
  }
});
test('371 and 1001 canonical facts retained without fabricated baseline or truncated graph', () => {
  for (const count of [371, 1001]) {
    const b = workspaceInventoryFixture(count), result = buildWorkspaceInventory(b, allowed);
    assert.notEqual(validateLessonAuthorBlueprintArchitecture(b, b.source_map).status, 'FAIL');
    assert.equal(result.nodes.length, 1 + Math.ceil(count / 512) + Math.ceil(count / 256) + count * 2);
    const ids = result.nodes.filter(n => n.kind === 'component').flatMap(n => (n.protected_contract.metadata as { source_fact_ids: string[] }).source_fact_ids);
    assert.equal(new Set(ids).size, count); assert.equal(ids.length, count);
  }
});
test('media brief is separate, uses next sibling order, no empty recommendation node', () => {
  const b = workspaceInventoryFixture(1), unit = b.chapters[0].lessons[0].units[0];
  assert.equal(buildWorkspaceInventory(b, allowed).nodes.filter(n => n.kind === 'media_brief').length, 0);
  unit.media_plan = { type: 'video', title: 'Brief', rationale: 'Teaching support', content_outline: 'Overview' };
  const n = buildWorkspaceInventory(b, allowed).nodes.at(-1)!;
  assert.equal(n.kind, 'media_brief'); assert.equal(n.sort_order, 1); assert.equal(n.parent_path, 'chapter_1.lesson_1.unit_1');
  assert.deepEqual(n.baseline?.data, { content_points: ['Overview'], context_description: null });
});
test('duplicate instance, disabled capability, empty structure and FAQ order reject before publication', () => {
  const b = workspaceInventoryFixture();
  b.chapters[0].lessons[0].units[1].component_plan[0].component_plan_id = 'plan_1';
  assert.throws(() => buildWorkspaceInventory(b, allowed), /WORKSPACE_PUBLICATION_INVALID/);
  assert.throws(() => buildWorkspaceInventory(workspaceInventoryFixture(), new Set()), /WORKSPACE_PUBLICATION_INVALID/);
  const empty = workspaceInventoryFixture(); empty.chapters[0].lessons = [];
  assert.throws(() => buildWorkspaceInventory(empty, allowed), /WORKSPACE_PUBLICATION_INVALID/);
  const faq = workspaceInventoryFixture(), plans = faq.chapters[0].lessons[0].units[0].component_plan;
  plans.unshift({ ...plans[0], component_plan_id: 'faq_1', type: 'la_faq', source_fact_ids: [] });
  assert.throws(() => buildWorkspaceInventory(faq, allowed), /WORKSPACE_PUBLICATION_INVALID/);
});
test('chapter node limit fails closed rather than publishing an incomplete accepted architecture', () => {
  const b = workspaceInventoryFixture(512);
  for (const l of b.chapters[0].lessons) for (const u of l.units) {
    u.component_plan.push(...[2, 3, 4].map(n => ({ ...u.component_plan[0], component_plan_id: `${u.component_plan[0].component_plan_id}_${n}`, source_fact_ids: [] })));
  }
  assert.throws(() => buildWorkspaceInventory(b, allowed), /WORKSPACE_PUBLICATION_TOO_LARGE/);
});
