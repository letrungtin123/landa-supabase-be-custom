import type { LessonAuthorBlueprint } from './chat.service.js';
import type { LessonAuthorComponentProposal, LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { workspaceComponentContent, workspaceComponentPlanBinding, hydrateWorkspaceComponent, validateWorkspaceReadyComponentChapter, WorkspaceComponentError } from './lesson-author-workspace-component.logic.js';
import { workspaceStoryboardSeed } from './lesson-author-workspace-storyboard.logic.js';

export const WORKSPACE_BASELINE_CONTRACT = 'workspace-unit-baseline-1';
export class WorkspaceBaselineError extends Error {
  constructor(readonly code: 'WORKSPACE_BASELINE_INVALID' | 'WORKSPACE_BASELINE_SEQUENCE_INVALID' | 'WORKSPACE_BASELINE_VALIDATION_FAILED',
    readonly findings: Array<{ code: string; path: string }> = []) { super(code); }
}
function fail(code: WorkspaceBaselineError['code'] = 'WORKSPACE_BASELINE_INVALID'): never { throw new WorkspaceBaselineError(code); }

/** Accepted generated components only, never raw provider JSON. The caller
 * must verify source, lease/dispatch, persisted baseline hashes and actual
 * Python unit acceptance. This extra Node gate precedes an ATOMIC unit commit.
 * Previous context contains AI baselines only, not concurrent author overlays.
 * This helper is not an Apply or full-course readiness certificate. */
export function prepareWorkspaceUnitBaseline(input: {
  blueprint: LessonAuthorBlueprint; unitPath: string;
  components: readonly LessonAuthorComponentProposal[];
  previous: ReadonlyMap<string, readonly LessonAuthorComponentProposal[]>;
  allowed: ReadonlySet<CourseComponentType>;
}) {
  const { blueprint, unitPath, components, previous, allowed } = input;
  const match = /^chapter_([1-9][0-9]*)\.lesson_([1-9][0-9]*)\.unit_([1-9][0-9]*)$/.exec(unitPath);
  if (!match || blueprint.architecture_contract_version !== 5 || blueprint.content_contract_version !== 1) fail();
  const ci = Number(match[1]) - 1, chapter = blueprint.chapters[ci];
  if (!chapter) fail();
  const paths = chapter.lessons.flatMap((l, li) => l.units.map((_u, ui) => `chapter_${ci + 1}.lesson_${li + 1}.unit_${ui + 1}`));
  const index = paths.indexOf(unitPath);
  if (index < 0 || previous.size !== index || paths.slice(0, index).some(p => !previous.has(p))) fail('WORKSPACE_BASELINE_SEQUENCE_INVALID');
  const unit = chapter.lessons[Number(match[2]) - 1]?.units[Number(match[3]) - 1];
  if (!unit || !Array.isArray(components) || components.length !== unit.component_plan.length || !components.length) fail();
  const seed = workspaceStoryboardSeed(blueprint, 'unit', unitPath);
  if (!seed) fail();
  const ready = new Set<string>();
  function proposalFor(targetComponents: readonly LessonAuthorComponentProposal[]): LessonAuthorProposal {
    return { summary: '', chapters: [{ title: chapter.title, lessons: chapter.lessons.map((l, li) => ({ title: l.title,
      units: l.units.map((u, ui) => {
        const path = `chapter_${ci + 1}.lesson_${li + 1}.unit_${ui + 1}`;
        const value = path === unitPath ? targetComponents : previous.get(path);
        if (value) ready.add(`${li}:${ui}`);
        return { title: u.title, components: value ? structuredClone([...value]) : [] };
      }) })) }] };
  }
  // Validate genuine generated ownership/coverage BEFORE planned metadata can
  // be injected by hydration. Otherwise required facts could masquerade as
  // covered facts even when generation omitted them.
  const rawProposal = proposalFor(components);
  const raw = validateWorkspaceReadyComponentChapter({ proposal: rawProposal, blueprint: chapter, allowed, readyUnits: ready });
  if (raw.status === 'FAIL') throw new WorkspaceBaselineError('WORKSPACE_BASELINE_VALIDATION_FAILED', raw.findings);
  const bindings = unit.component_plan.map(workspaceComponentPlanBinding);
  const baselines = components.map((component, i) => {
    const plan = unit.component_plan[i];
    if (component.type !== plan.type || component.metadata?.component_plan_id !== plan.component_plan_id) fail();
    for (const field of ['source_fact_ids', 'supporting_evidence_fact_ids', 'learning_objective_refs'] as const) {
      const actual = component.metadata?.[field] ?? [], expected = plan[field] ?? [];
      if (!Array.isArray(actual) || actual.some(x => typeof x !== 'string') || new Set(actual).size !== actual.length
        || actual.length !== expected.length || actual.some(x => !expected.includes(x))) fail();
    }
    try { return workspaceComponentContent(component, allowed); }
    catch (e) { if (e instanceof WorkspaceComponentError) throw new WorkspaceBaselineError('WORKSPACE_BASELINE_VALIDATION_FAILED', [{ code: e.code, path: `${unitPath}.component_${i + 1}` }]); throw e; }
  });
  const hydrated = baselines.map((content, i) => hydrateWorkspaceComponent(bindings[i], content, allowed));
  const compiled = validateWorkspaceReadyComponentChapter({ proposal: proposalFor(hydrated), blueprint: chapter, allowed, readyUnits: ready });
  if (compiled.status === 'FAIL') throw new WorkspaceBaselineError('WORKSPACE_BASELINE_VALIDATION_FAILED', compiled.findings);
  const result = [
    { path: unitPath, content: seed.baseline, contract_hash: hash(seed.binding) },
    ...baselines.map((content, i) => ({ path: `${unitPath}.component_${i + 1}`, content, contract_hash: hash(bindings[i]) })),
  ].map(n => ({ ...n, content_hash: hash(n.content) }));
  return { validation_contract: WORKSPACE_BASELINE_CONTRACT as typeof WORKSPACE_BASELINE_CONTRACT, nodes: result,
    chapter_scope_complete: compiled.scope_complete, deferred_checks: compiled.deferred_checks,
    semantic_fidelity: 'not_measured' as const, apply_readiness: 'NOT_EVALUATED' as const,
    fingerprint: hash(result) };
}
