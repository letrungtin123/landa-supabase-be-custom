import type { LessonAuthorBlueprint } from './chat.service.js';
import type { LessonAuthorComponentProposal, LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { hydrateWorkspaceComponent } from './lesson-author-workspace-component.logic.js';
import { prepareWorkspaceUnitBaseline } from './lesson-author-workspace-baseline.logic.js';
import { readWorkspaceContent, type WorkspaceContent } from './lesson-author-workspace.logic.js';

export class WorkspaceGenerationContextError extends Error {
  constructor(readonly code: 'WORKSPACE_GENERATION_CONTEXT_INVALID' | 'WORKSPACE_GENERATION_CONTEXT_TOO_LARGE' | 'WORKSPACE_GENERATION_CONTEXT_CHANGED') { super(code); }
}
function invalid(): never { throw new WorkspaceGenerationContextError('WORKSPACE_GENERATION_CONTEXT_INVALID'); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (v: unknown) => {
  if (!(typeof v === 'number' || typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) || !Number.isSafeInteger(Number(v)) || Number(v) < 0) invalid();
  return Number(v);
};
export interface WorkspaceGenerationTarget extends WorkspaceReadOwner { workspaceId: string; nodeId: string; }
export interface WorkspaceGenerationContext {
  blueprint: LessonAuthorBlueprint; unitPath: string;
  previous: Map<string, LessonAuthorComponentProposal[]>;
  allowed: ReadonlySet<CourseComponentType>;
  input_context_hash: string;
  source_snapshot_hash: string;
  correlation_id: string;
  targetNodes: Array<{ id: string; path: string; contract_hash: string }>;
}

/** Internal worker-only SELECT materializer. Caller must hold the workspace
 * lock and use fresh actor/source/runtime/lease authority on this transaction.
 * Never return this private context through an HTTP read or operational logs.
 * Reads AI revision 0 only: concurrent author changes cannot become generation
 * context or be overwritten. Re-load at publication and compare the frozen hash.
 */
export async function loadWorkspaceGenerationContext(tx: GenerationJobSql, target: WorkspaceGenerationTarget,
  allowed: ReadonlySet<CourseComponentType>): Promise<WorkspaceGenerationContext> {
  return loadWorkspaceContext(tx, target, allowed, 'unit');
}

export interface WorkspaceChapterGenerationContext {
  blueprint: LessonAuthorBlueprint; chapterIndex: number;
  proposal: LessonAuthorProposal;
  allowed: ReadonlySet<CourseComponentType>;
  input_context_hash: string; source_snapshot_hash: string; correlation_id: string;
  targetNodes: Array<{ id: string; path: string; contract_hash: string }>;
}

/** Complete chapter validation uses ALL immutable AI baselines, not the current
 * author overlay. A missing/partial unit is a rejection, not an empty placeholder.
 * Same private read/lease/authority requirements as the unit loader above. */
export async function loadWorkspaceChapterGenerationContext(tx: GenerationJobSql, target: WorkspaceGenerationTarget,
  allowed: ReadonlySet<CourseComponentType>): Promise<WorkspaceChapterGenerationContext> {
  const loaded = await loadWorkspaceContext(tx, target, allowed, 'chapter');
  const chapterIndex = Number(loaded.unitPath.slice('chapter_'.length)) - 1;
  const chapter = loaded.blueprint.chapters[chapterIndex];
  const proposal: LessonAuthorProposal = { summary: '', chapters: [{ title: chapter.title,
    lessons: chapter.lessons.map((l, li) => ({ title: l.title, units: l.units.map((u, ui) => {
      const components = loaded.previous.get(`chapter_${chapterIndex + 1}.lesson_${li + 1}.unit_${ui + 1}`);
      if (!components) invalid();
      return { title: u.title, components: structuredClone(components) };
    }) })) }] };
  return { blueprint: loaded.blueprint, chapterIndex, proposal, allowed: loaded.allowed,
    input_context_hash: loaded.input_context_hash, source_snapshot_hash: loaded.source_snapshot_hash,
    correlation_id: loaded.correlation_id, targetNodes: loaded.targetNodes };
}

async function loadWorkspaceContext(tx: GenerationJobSql, target: WorkspaceGenerationTarget,
  allowed: ReadonlySet<CourseComponentType>, kind: 'unit' | 'chapter'): Promise<WorkspaceGenerationContext> {
  if (![target.workspaceId, target.nodeId, target.tenantId, target.userId, target.conversationId].every(id => uuid.test(id))) invalid();
  const params = [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId, target.nodeId, kind];
  const found = await tx.query(`SELECT n.canonical_path,w.source_snapshot_hash,w.correlation_id,w.content_locale,
      CASE WHEN octet_length(b.blueprint::text)<=16777216 THEN b.blueprint ELSE NULL END AS blueprint
    FROM lesson_author_workspaces w JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id
      AND c.user_id=w.requested_by AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
    JOIN lesson_author_blueprints b ON b.id=w.blueprint_id AND b.tenant_id=w.tenant_id AND b.course_id=w.course_id
      AND b.conversation_id=w.conversation_id AND b.requested_by=w.requested_by AND b.bot_id=w.bot_id AND b.kb_id=w.kb_id
      AND b.source_snapshot_hash=w.source_snapshot_hash AND b.status='proposed' AND b.engine=w.engine
    JOIN lesson_author_workspace_nodes n ON n.workspace_id=w.id AND n.id=$6 AND n.kind=$7
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
      AND w.status='drafting' AND w.engine='self_built_rag' AND w.contract_version=1
      AND EXISTS (SELECT 1 FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id AND e.event_kind='structure_ready')`, params);
  const row = found.rows[0];
  if (found.rows.length !== 1 || !row.blueprint || !uuid.test(String(row.correlation_id)) || !['en','vi'].includes(String(row.content_locale))
    || !/^[0-9a-f]{64}$/.test(String(row.source_snapshot_hash))) invalid();
  const unitPath = String(row.canonical_path), chapterPath = unitPath.split('.')[0];
  if (!(kind === 'unit' ? /^chapter_[1-9][0-9]*\.lesson_[1-9][0-9]*\.unit_[1-9][0-9]*$/
    : /^chapter_[1-9][0-9]*$/).test(unitPath)) invalid();
  const blueprint = structuredClone(row.blueprint) as LessonAuthorBlueprint;
  const inventory = buildWorkspaceInventory(blueprint, allowed);
  const expected = inventory.nodes.filter(n => n.canonical_path === chapterPath || n.canonical_path.startsWith(chapterPath + '.'));
  const scoped = [...params.slice(0, 3), chapterPath];
  const size = await tx.query(`SELECT count(*)::text AS node_count,
      COALESCE(sum(octet_length(n.protected_contract::text)+COALESCE(octet_length(r.content::text),0)),0)::text AS bytes
    FROM lesson_author_workspace_nodes n LEFT JOIN lesson_author_workspace_revisions r
      ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=0
    WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3
      AND (n.canonical_path=$4 OR left(n.canonical_path,length($4)+1)=$4||'.')`, scoped);
  if (size.rows.length !== 1 || integer(size.rows[0].node_count) !== expected.length) invalid();
  if (integer(size.rows[0].node_count) > 4096 || integer(size.rows[0].bytes) > 16 * 1024 * 1024) throw new WorkspaceGenerationContextError('WORKSPACE_GENERATION_CONTEXT_TOO_LARGE');
  const nodes = await tx.query(`SELECT n.id,n.parent_id,n.kind,n.canonical_path,n.sort_order,n.protected_contract,n.contract_hash,n.current_revision,n.content_state,
      r.content AS baseline_content,r.content_hash AS baseline_hash,r.origin AS baseline_origin,r.user_modified AS baseline_modified
    FROM lesson_author_workspace_nodes n LEFT JOIN lesson_author_workspace_revisions r
      ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=0
    WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3
      AND (n.canonical_path=$4 OR left(n.canonical_path,length($4)+1)=$4||'.') ORDER BY n.canonical_path LIMIT 4097`, scoped);
  const byPath = new Map(nodes.rows.map(n => [String(n.canonical_path), n]));
  if (nodes.rows.length !== expected.length || byPath.size !== expected.length) invalid();
  const baselines = new Map<string, WorkspaceContent>();
  for (const e of expected) {
    const n = byPath.get(e.canonical_path);
    if (!n || !uuid.test(String(n.id)) || n.kind !== e.kind || n.sort_order !== e.sort_order || n.contract_hash !== e.contract_hash
      || hash(n.protected_contract) !== e.contract_hash || (e.canonical_path !== chapterPath && n.parent_id !== byPath.get(e.parent_path!)?.id)) invalid();
    if (n.baseline_content !== null) {
      const content = readWorkspaceContent(n.baseline_content);
      if (n.baseline_origin !== 'ai_baseline' || n.baseline_modified !== false || hash(content) !== n.baseline_hash
        || n.current_revision === null || n.content_state !== 'content_ready') invalid();
      if (e.baseline && hash(content) !== hash(e.baseline)) invalid();
      if (e.kind === 'unit' && hash(content) !== (n.protected_contract as Record<string, unknown>).baseline_hash) invalid();
      baselines.set(e.canonical_path, content);
    } else if (e.baseline || n.current_revision !== null || !['planned','generating'].includes(String(n.content_state))) invalid();
  }
  const unitPaths = expected.filter(n => n.kind === 'unit').map(n => n.canonical_path);
  const index = kind === 'unit' ? unitPaths.indexOf(unitPath) : unitPaths.length;
  if (index < 0 || byPath.get(unitPath)?.id !== target.nodeId) invalid();
  const previous = new Map<string, LessonAuthorComponentProposal[]>();
  for (let i = 0; i < unitPaths.length; i++) {
    const path = unitPaths[i], children = expected.filter(n => n.kind === 'component' && n.parent_path === path);
    const ready = baselines.has(path) && children.every(n => baselines.has(n.canonical_path));
    if (i < index) {
      if (!ready) invalid();
      previous.set(path, children.map(n => hydrateWorkspaceComponent(n.protected_contract, baselines.get(n.canonical_path)!, allowed)));
    } else if (baselines.has(path) || children.some(n => baselines.has(n.canonical_path))) invalid();
  }
  const targetNodes = expected.filter(n => kind === 'chapter' || n.canonical_path === unitPath || n.kind === 'component' && n.parent_path === unitPath)
    .map(n => ({ id: String(byPath.get(n.canonical_path)!.id), path: n.canonical_path, contract_hash: n.contract_hash }));
  return { blueprint, unitPath, previous, allowed: new Set(allowed), targetNodes,
    correlation_id: String(row.correlation_id), source_snapshot_hash: String(row.source_snapshot_hash),
    input_context_hash: hash({ workspace_id: target.workspaceId, node_id: target.nodeId, blueprint, inventory_hash: inventory.inventory_hash,
      content_locale: row.content_locale, source_snapshot_hash: row.source_snapshot_hash,
      previous: [...previous], targetNodes, allowed: [...allowed].sort() }) };
}

/** Actual generation metadata is checked before hydration. No publication
 * occurs here; pass the accepted set to the SQL live-lease fenced repository. */
export function acceptWorkspaceGeneratedUnit(context: WorkspaceGenerationContext, expectedInputHash: string,
  components: readonly LessonAuthorComponentProposal[]) {
  if (context.input_context_hash !== expectedInputHash) throw new WorkspaceGenerationContextError('WORKSPACE_GENERATION_CONTEXT_CHANGED');
  const accepted = prepareWorkspaceUnitBaseline({ blueprint: context.blueprint, unitPath: context.unitPath,
    components, previous: context.previous, allowed: context.allowed });
  const baselines = accepted.nodes.map(n => {
    const target = context.targetNodes.find(t => t.path === n.path);
    if (!target || target.contract_hash !== n.contract_hash) invalid();
    return { node_id: target.id, contract_hash: target.contract_hash, content: n.content, content_hash: n.content_hash };
  });
  if (baselines.length !== context.targetNodes.length) invalid();
  return { baselines, input_context_hash: expectedInputHash, result_hash: hash({ input_context_hash: expectedInputHash, baselines }),
    validation_contract: accepted.validation_contract, deferred_checks: accepted.deferred_checks,
    chapter_scope_complete: accepted.chapter_scope_complete };
}
