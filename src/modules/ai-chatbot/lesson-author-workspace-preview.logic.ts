import { orchestrationV2DeterministicUuid } from './lesson-author-orchestration-v2-inventory.logic.js';
import {
  readOrchestrationV2ChapterShardResponse,
  readOrchestrationV2CourseSkeletonResponse,
  type OrchestrationV2ChapterShard,
  type OrchestrationV2ChapterShardPlan,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';

export type WorkspaceArchitecturePreviewState = 'planned' | 'generating' | 'ready' | 'needs_action';
export type WorkspaceArchitecturePreviewKind = 'course' | 'chapter' | 'lesson' | 'unit' | 'component' | 'media_brief';

export interface WorkspaceArchitecturePreviewNode {
  node_id: string;
  parent_id: string | null;
  kind: WorkspaceArchitecturePreviewKind;
  canonical_path: string;
  sort_order: number;
  title: string;
  state: WorkspaceArchitecturePreviewState;
  component_type: 'html' | 'problem' | 'la_faq' | 'la_sortable' | 'la_crossword' | 'la_diagram' | null;
  media_type: 'video' | 'static_infographic' | null;
}

export interface WorkspaceArchitecturePreview {
  run_id: string;
  course_title: string;
  total_chapters: number;
  completed_chapters: number;
  total_nodes: number;
  truncated: boolean;
  chapters: Array<{ chapter_key: string; order: number; title: string; state: WorkspaceArchitecturePreviewState }>;
  nodes: WorkspaceArchitecturePreviewNode[];
}

export class WorkspaceArchitecturePreviewError extends Error {
  constructor(readonly code: 'WORKSPACE_ARCHITECTURE_PREVIEW_INVALID') {
    super(code);
    this.name = 'WorkspaceArchitecturePreviewError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_STATES = new Set(['blocked', 'queued', 'running', 'succeeded', 'failed', 'timed_out', 'outcome_unknown', 'canceled']);
const TERMINAL_FAILURES = new Set(['failed', 'timed_out', 'outcome_unknown', 'canceled']);
const MAX_PREVIEW_NODES = 10_000;

const fail = (): never => { throw new WorkspaceArchitecturePreviewError('WORKSPACE_ARCHITECTURE_PREVIEW_INVALID'); };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= maximum;

interface PreviewTaskRow {
  task_id: string;
  task_key: string;
  chapter_key: string;
  status: string;
  artifact_payload: Record<string, unknown> | null;
}

interface PreviewUnitTaskRow { node_id: string; status: string }

function taskState(rows: readonly { status: string }[]): WorkspaceArchitecturePreviewState {
  if (!rows.length || rows.every(row => row.status === 'blocked')) return 'planned';
  if (rows.some(row => TERMINAL_FAILURES.has(row.status))) return 'needs_action';
  if (rows.every(row => row.status === 'succeeded')) return 'ready';
  return 'generating';
}

function readTaskRows(value: unknown): PreviewTaskRow[] {
  if (!Array.isArray(value)) return fail();
  if (value.length > 4_096) return fail();
  return (value as unknown[]).map((candidate: unknown) => {
    const row = record(candidate);
    if (!row) return fail();
    if (!UUID.test(String(row.task_id)) || !text(row.task_key, 240) || !text(row.chapter_key, 160)
      || !TASK_STATES.has(String(row.status)) || row.artifact_payload !== null && !record(row.artifact_payload)) fail();
    return { task_id: String(row.task_id), task_key: String(row.task_key), chapter_key: String(row.chapter_key),
      status: String(row.status), artifact_payload: record(row.artifact_payload) };
  });
}

function readUnitTaskRows(value: unknown): PreviewUnitTaskRow[] {
  if (!Array.isArray(value)) return fail();
  if (value.length > MAX_PREVIEW_NODES) return fail();
  return (value as unknown[]).map((candidate: unknown) => {
    const row = record(candidate);
    if (!row) return fail();
    if (!UUID.test(String(row.node_id)) || !TASK_STATES.has(String(row.status))) fail();
    return { node_id: String(row.node_id).toLowerCase(), status: String(row.status) };
  });
}

/**
 * Builds a bounded, presentation-only projection from durable orchestration
 * artifacts. It never grants read/edit/apply authority. Deterministic IDs and
 * canonical paths intentionally match the later accepted inventory so React
 * Flow can replace a progress node in place after the authoritative commit.
 */
export function buildWorkspaceArchitecturePreview(value: unknown): WorkspaceArchitecturePreview {
  const input = record(value);
  if (!input) return fail();
  if (!UUID.test(String(input.run_id)) || !text(input.course_title, 500)) fail();
  const runId = String(input.run_id).toLowerCase();
  const courseId = orchestrationV2DeterministicUuid(runId, 'node:course');
  const nodes: WorkspaceArchitecturePreviewNode[] = [];
  let truncated = false;
  const add = (node: WorkspaceArchitecturePreviewNode) => {
    if (nodes.length >= MAX_PREVIEW_NODES) { truncated = true; return false; }
    nodes.push(node); return true;
  };
  const courseNode = (title: string, state: WorkspaceArchitecturePreviewState) => add({
    node_id: courseId, parent_id: null, kind: 'course', canonical_path: 'course', sort_order: 0,
    title, state, component_type: null, media_type: null,
  });
  const skeletonArtifact = record(input.skeleton_artifact);
  if (!skeletonArtifact) {
    courseNode(String(input.course_title).trim(), 'generating');
    return { run_id: runId, course_title: String(input.course_title).trim(), total_chapters: 0,
      completed_chapters: 0, total_nodes: nodes.length, truncated, chapters: [], nodes };
  }
  const rawSkeleton = record(skeletonArtifact.skeleton);
  const rawPlans = skeletonArtifact.shard_plans;
  if (!rawSkeleton) return fail();
  if (!Array.isArray(rawPlans)) return fail();
  const skeleton = readOrchestrationV2CourseSkeletonResponse({ contract_version: 2, skeleton: rawSkeleton },
    String(rawSkeleton.source_snapshot_hash)).skeleton;
  const plans: OrchestrationV2ChapterShardPlan[] = (rawPlans as unknown[]).map((candidate: unknown) => {
    const plan = record(candidate);
    if (!plan) return fail();
    if (typeof plan.chapter_key !== 'string' || !Number.isSafeInteger(plan.order)
      || !Number.isSafeInteger(plan.shard_index) || !Number.isSafeInteger(plan.shard_count)
      || !Array.isArray(plan.source_scope_ids) || !Number.isSafeInteger(plan.source_fact_count)
      || !Number.isSafeInteger(plan.source_content_chars)) fail();
    return plan as unknown as OrchestrationV2ChapterShardPlan;
  });
  const chapterTasks = readTaskRows(input.chapter_tasks ?? []);
  const unitTasks = new Map(readUnitTaskRows(input.unit_tasks ?? []).map(row => [row.node_id, row.status]));
  courseNode(skeleton.title, 'ready');
  const chapters: WorkspaceArchitecturePreview['chapters'] = [];
  for (const chapter of [...skeleton.chapters].sort((left, right) => left.order - right.order)) {
    const chapterPath = `chapter_${chapter.order + 1}`;
    const chapterId = orchestrationV2DeterministicUuid(runId, `node:${chapterPath}`);
    const chapterPlans = plans.filter(plan => plan.chapter_key === chapter.chapter_key)
      .sort((left, right) => left.shard_index - right.shard_index);
    const taskByKey = new Map(chapterTasks.filter(task => task.chapter_key === chapter.chapter_key)
      .map(task => [task.task_key, task]));
    const tasks = chapterPlans.map(plan => taskByKey.get(
      `architecture:chapter:${plan.chapter_key}:shard:${plan.shard_index + 1}`)).filter(Boolean) as PreviewTaskRow[];
    const state = tasks.length === chapterPlans.length ? taskState(tasks) : 'planned';
    chapters.push({ chapter_key: chapter.chapter_key, order: chapter.order, title: chapter.title, state });
    if (!add({ node_id: chapterId, parent_id: courseId, kind: 'chapter', canonical_path: chapterPath,
      sort_order: chapter.order, title: chapter.title, state, component_type: null, media_type: null })) continue;

    // Only a contiguous succeeded shard prefix has stable final lesson indexes.
    // A later shard is deliberately withheld until every preceding offset is known.
    const readyShards: OrchestrationV2ChapterShard[] = [];
    for (const plan of chapterPlans) {
      const task = taskByKey.get(`architecture:chapter:${plan.chapter_key}:shard:${plan.shard_index + 1}`);
      if (!task || task.status !== 'succeeded' || !task.artifact_payload) break;
      try {
        readyShards.push(readOrchestrationV2ChapterShardResponse({ contract_version: 2,
          shard: task.artifact_payload.shard }, skeleton, plan).shard);
      } catch { break; }
    }
    const lessons = readyShards.flatMap(shard => shard.lessons);
    for (const [lessonIndex, lesson] of lessons.entries()) {
      const lessonPath = `${chapterPath}.lesson_${lessonIndex + 1}`;
      const lessonId = orchestrationV2DeterministicUuid(runId, `node:${lessonPath}`);
      if (!add({ node_id: lessonId, parent_id: chapterId, kind: 'lesson', canonical_path: lessonPath,
        sort_order: lessonIndex, title: lesson.title, state: 'ready', component_type: null, media_type: null })) break;
      for (const [unitIndex, unit] of lesson.units.entries()) {
        const unitPath = `${lessonPath}.unit_${unitIndex + 1}`;
        const unitId = orchestrationV2DeterministicUuid(runId, `node:${unitPath}`);
        const persistedTaskState = unitTasks.get(unitId.toLowerCase());
        const unitState = persistedTaskState ? taskState([{ status: persistedTaskState }]) : 'planned';
        if (!add({ node_id: unitId, parent_id: lessonId, kind: 'unit', canonical_path: unitPath,
          sort_order: unitIndex, title: unit.title, state: unitState, component_type: null, media_type: null })) break;
        for (const [componentIndex, component] of unit.component_plan.entries()) {
          const componentPath = `${unitPath}.component_${componentIndex + 1}`;
          if (!add({ node_id: orchestrationV2DeterministicUuid(runId, `node:${componentPath}`), parent_id: unitId,
            kind: 'component', canonical_path: componentPath, sort_order: componentIndex, title: component.title,
            state: unitState, component_type: component.type, media_type: null })) break;
        }
        if (unit.media_brief) {
          const mediaPath = `${unitPath}.media_1`;
          add({ node_id: orchestrationV2DeterministicUuid(runId, `node:${mediaPath}`), parent_id: unitId,
            kind: 'media_brief', canonical_path: mediaPath, sort_order: unit.component_plan.length,
            title: unit.media_brief.title, state: unitState, component_type: null, media_type: unit.media_brief.type });
        }
      }
    }
  }
  return { run_id: runId, course_title: skeleton.title, total_chapters: chapters.length,
    completed_chapters: chapters.filter(chapter => chapter.state === 'ready').length,
    total_nodes: nodes.length, truncated, chapters, nodes };
}
