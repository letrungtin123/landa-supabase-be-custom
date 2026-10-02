import type { LessonAuthorBlueprint } from './chat.service.js';
import type { WorkspaceContent, WorkspaceNodeKind } from './lesson-author-workspace.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { workspaceComponentPlanBinding } from './lesson-author-workspace-component.logic.js';
import { workspaceStoryboardSeed, type WorkspaceStoryboardKind } from './lesson-author-workspace-storyboard.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';

export type WorkspacePublicationCode = 'WORKSPACE_PUBLICATION_INVALID' | 'WORKSPACE_PUBLICATION_TOO_LARGE'
  | 'WORKSPACE_PUBLICATION_FORBIDDEN' | 'WORKSPACE_PUBLICATION_CONFLICT' | 'WORKSPACE_PUBLICATION_SOURCE_CHANGED'
  | 'WORKSPACE_PUBLICATION_BLUEPRINT_INVALID' | 'WORKSPACE_PUBLICATION_READBACK_INVALID' | 'WORKSPACE_PUBLICATION_UNAVAILABLE';
export class WorkspacePublicationError extends Error {
  constructor(readonly code: WorkspacePublicationCode) { super(code); this.name = 'WorkspacePublicationError'; }
}
export const WORKSPACE_INVENTORY_CONTRACT = 'workspace-inventory-1';
export interface WorkspaceInventoryNode {
  canonical_path: string; parent_path: string | null; kind: WorkspaceNodeKind; sort_order: number;
  protected_contract: Record<string, unknown>; contract_hash: string;
  /** Planned unit/component content is never marked ready by architecture. */
  baseline: WorkspaceContent | null;
}
function fail(code: WorkspacePublicationCode = 'WORKSPACE_PUBLICATION_INVALID'): never { throw new WorkspacePublicationError(code); }
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** Pure inventory projection, not Blueprint acceptance. Production publisher
 * revalidates the exact stored V5 artifact first. No model calls or fact-ID
 * matching/assignment. All paths come from the accepted canonical hierarchy. */
export function buildWorkspaceInventory(blueprint: LessonAuthorBlueprint, allowed: ReadonlySet<CourseComponentType>) {
  if (blueprint?.architecture_contract_version !== 5 || blueprint.content_contract_version !== 1
    || !Array.isArray(blueprint.chapters) || !blueprint.chapters.length) fail();
  const nodes: WorkspaceInventoryNode[] = [];
  const paths = new Set<string>(), siblings = new Set<string>(), instances = new Set<string>();
  let totalBytes = 0, unitCount = 0;
  function add(node: WorkspaceInventoryNode) {
    const sibling = `${node.parent_path ?? ''}:${node.sort_order}`;
    if (paths.has(node.canonical_path) || siblings.has(sibling) || (node.parent_path && !paths.has(node.parent_path))) fail();
    paths.add(node.canonical_path); siblings.add(sibling);
    // Conservative JSONB headroom for SQL's byte constraints; never truncate.
    if (bytes(node.protected_contract) > 512 * 1024 || (node.baseline && bytes(node.baseline) > 1024 * 1024)) fail('WORKSPACE_PUBLICATION_TOO_LARGE');
    totalBytes += bytes(node);
    if (nodes.length >= 8192 || totalBytes > 64 * 1024 * 1024) fail('WORKSPACE_PUBLICATION_TOO_LARGE');
    nodes.push(node);
  }
  function metadata(kind: WorkspaceStoryboardKind, path: string) {
    const seed = workspaceStoryboardSeed(blueprint, kind, path);
    if (!seed) return;
    add({ canonical_path: path, parent_path: seed.parent_path, kind, sort_order: seed.sort_order,
      protected_contract: seed.binding, contract_hash: hash(seed.binding), baseline: kind === 'unit' ? null : seed.baseline });
  }
  metadata('course', 'course');
  blueprint.chapters.forEach((chapter, ci) => {
    const chapterStart = nodes.length, chapterUnitStart = unitCount, chapterPath = `chapter_${ci + 1}`;
    metadata('chapter', chapterPath);
    if (!Array.isArray(chapter.lessons) || !chapter.lessons.length || chapter.lessons.length > 256) fail();
    chapter.lessons.forEach((lesson, li) => {
      const lessonPath = `${chapterPath}.lesson_${li + 1}`;
      metadata('lesson', lessonPath);
      if (!Array.isArray(lesson.units) || !lesson.units.length || lesson.units.length > 256) fail();
      lesson.units.forEach((unit, ui) => {
        const unitPath = `${lessonPath}.unit_${ui + 1}`;
        metadata('unit', unitPath); unitCount++;
        if (!Array.isArray(unit.component_plan) || !unit.component_plan.length || unit.component_plan.length > 64) fail();
        let faq = false;
        unit.component_plan.forEach((plan, pi) => {
          if (!plan.component_plan_id || instances.has(plan.component_plan_id) || !allowed.has(plan.type)
            || (faq && plan.type !== 'la_faq')) fail();
          faq ||= plan.type === 'la_faq'; instances.add(plan.component_plan_id);
          const binding = workspaceComponentPlanBinding(plan);
          add({ kind: 'component', canonical_path: `${unitPath}.component_${pi + 1}`, parent_path: unitPath,
            sort_order: pi, protected_contract: binding, contract_hash: hash(binding), baseline: null });
        });
        metadata('media_brief', `${unitPath}.media_1`);
      });
    });
    // Same node/byte admission boundary as the component edit materializer;
    // future generated/current payload size must be rechecked at publication.
    const chapterNodes = nodes.slice(chapterStart).filter(n => n.kind !== 'media_brief');
    if (unitCount - chapterUnitStart > 512 || chapterNodes.length > 2048
      || chapterNodes.reduce((n, item) => n + bytes(item), 0) > 8 * 1024 * 1024) fail('WORKSPACE_PUBLICATION_TOO_LARGE');
  });
  return { contract: WORKSPACE_INVENTORY_CONTRACT, nodes, unit_count: unitCount,
    component_count: instances.size, inventory_hash: hash(nodes.map(n => ({ path: n.canonical_path, parent: n.parent_path,
      kind: n.kind, order: n.sort_order, contract_hash: n.contract_hash, baseline_hash: n.baseline ? hash(n.baseline) : null }))) };
}
