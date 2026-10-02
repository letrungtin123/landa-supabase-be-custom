import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareWorkspaceUnitBaseline } from './lesson-author-workspace-baseline.logic.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';
const allowed = new Set<CourseComponentType>(['html']);
const path = (i: number) => `chapter_1.lesson_1.unit_${i}`;
function setup() {
  const blueprint = workspaceInventoryFixture();
  const generated = (i: number): LessonAuthorComponentProposal => ({ type: 'html', title: `Explanation ${i}`,
    data: `<p>Concept ${i} describes the relationship between the stated information and its intended meaning. Read the definition carefully, identify its distinguishing characteristics, and compare those characteristics with the explanation provided here. For example, an observation records what is visible, whereas an interpretation explains the significance of that observation. Keep these categories separate when discussing the concept. Explain each distinction in your own words and review the original definition before proceeding to the next topic.</p>`,
    metadata: { component_plan_id: `plan_${i}`, source_fact_ids: [`fact_${i}`], covered_source_fact_ids: [`fact_${i}`],
      supporting_evidence_fact_ids: [], learning_objective_refs: ['lo_1'] } });
  return { blueprint, generated };
}
test('real generated content → raw coverage validation → planned binding hydration → ready-scope validation', () => {
  const { blueprint, generated } = setup();
  const first = prepareWorkspaceUnitBaseline({ blueprint, unitPath: path(1), components: [generated(1)], previous: new Map(), allowed });
  assert.equal(first.nodes.length, 2); assert.equal(first.chapter_scope_complete, false); assert.equal(first.apply_readiness, 'NOT_EVALUATED');
  const second = prepareWorkspaceUnitBaseline({ blueprint, unitPath: path(2), components: [generated(2)], previous: new Map([[path(1), [generated(1)]]]), allowed });
  assert.equal(second.chapter_scope_complete, true); assert.equal(second.deferred_checks.length, 0);
  assert.equal(first.nodes[0].path, path(1)); assert.equal(first.nodes[1].path, `${path(1)}.component_1`);
});
test('missing generated coverage cannot be manufactured from immutable plan ownership', () => {
  const { blueprint, generated } = setup(), component = generated(1);
  component.metadata!.covered_source_fact_ids = [];
  assert.throws(() => prepareWorkspaceUnitBaseline({ blueprint, unitPath: path(1), components: [component], previous: new Map(), allowed }), /WORKSPACE_BASELINE_VALIDATION_FAILED/);
});
test('out-of-order generation, unrelated previous units and replay overwrites fail closed', () => {
  const { blueprint, generated } = setup();
  for (const [unitPath, previous] of [[path(2), new Map()], [path(1), new Map([[path(1), [generated(1)]]])],
    [path(2), new Map([['chapter_9.lesson_1.unit_1', [generated(1)]]])]] as const) {
    assert.throws(() => prepareWorkspaceUnitBaseline({ blueprint, unitPath, components: [generated(2)], previous, allowed }), /WORKSPACE_BASELINE_SEQUENCE_INVALID/);
  }
});
test('component identity, provenance and local objective cannot change during baseline projection', () => {
  for (const field of ['component_plan_id', 'source_fact_ids', 'supporting_evidence_fact_ids', 'learning_objective_refs']) {
    const { blueprint, generated } = setup(), component = generated(1);
    component.metadata![field] = field === 'component_plan_id' ? 'wrong' : ['wrong'];
    assert.throws(() => prepareWorkspaceUnitBaseline({ blueprint, unitPath: path(1), components: [component], previous: new Map(), allowed }));
  }
});
test('disabled type, malformed payload or missing component cannot publish a ready unit', () => {
  const { blueprint, generated } = setup();
  for (const components of [[], [{ ...generated(1), data: '<script>bad()</script>' }]]) {
    assert.throws(() => prepareWorkspaceUnitBaseline({ blueprint, unitPath: path(1), components, previous: new Map(), allowed }));
  }
  assert.throws(() => prepareWorkspaceUnitBaseline({ blueprint, unitPath: path(1), components: [generated(1)], previous: new Map(), allowed: new Set() }));
});
test('preparation is detached and deterministic; EN/VI user-facing text is not translated', () => {
  for (const locale of ['vi', 'en'] as const) {
    const { generated } = setup(), blueprint = workspaceInventoryFixture(2, locale), component = generated(1);
    component.title = locale === 'vi' ? 'Giải thích' : 'Explanation';
    const before = structuredClone({ blueprint, component });
    const input = { blueprint, unitPath: path(1), components: [component], previous: new Map(), allowed };
    const a = prepareWorkspaceUnitBaseline(input), b = prepareWorkspaceUnitBaseline(input);
    assert.deepEqual(a, b); assert.deepEqual({ blueprint, component }, before);
    assert.equal(a.nodes[1].content.title, component.title);
    a.nodes[1].content.title = 'Changed'; assert.equal(component.title, before.component.title);
  }
});
