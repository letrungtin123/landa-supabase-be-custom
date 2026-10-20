// Author recovery of an orchestration V2 run (stop, resume, rewrite): pure rules.
//
// A run that ended in needs_action is reopened IN PLACE: its non-succeeded
// task rows get a fresh attempt budget (attempt_count 0, dispatch_epoch + 1)
// and every reopen is recorded in an append-only recovery log
// (SQL 20261020_1500). Task keys, dependencies, task_count and the finalize
// inputs never change, and a non-succeeded task never produced an artifact or
// a revision, so nothing immutable is touched.
//
// Which tasks a request reopens:
//   - rewrite: the generate_unit tasks of the chosen scope (one unit, a lesson,
//     a chapter or the whole course) that have no content, plus every
//     validate_chapter / finalize_course task that becomes runnable;
//   - resume: only those validate_chapter / finalize_course tasks (no AI cost).
// A validation or finalizer is reopened only when each dependency already
// succeeded or is reopened by the same request, so a reopened task can never
// wait forever on a task nobody will run.

import { createHash } from 'node:crypto';

export const ORCHESTRATION_V2_RECOVERY_UNIT_REWRITE_LIMIT = 3;
/** validate_chapter / finalize_course cost no AI call; they may be re-run more often. */
export const ORCHESTRATION_V2_RECOVERY_DETERMINISTIC_REOPEN_LIMIT = 10;
/** Schema CHECK of lesson_author_workspace_v2_tasks.dispatch_epoch. */
export const ORCHESTRATION_V2_MAX_DISPATCH_EPOCH = 100;
export const ORCHESTRATION_V2_RUN_STOPPED_BY_AUTHOR = 'RUN_STOPPED_BY_AUTHOR' as const;
export const ORCHESTRATION_V2_ASSESSMENT_REVIEW_REQUIRED = 'ASSESSMENT_REVIEW_REQUIRED' as const;

export const ORCHESTRATION_V2_RECOVERY_ERROR_CODES = [
  'RECOVERY_DISABLED', 'RECOVERY_FORBIDDEN', 'RECOVERY_INPUT_INVALID', 'RECOVERY_NOT_FOUND',
  'RECOVERY_STATE_CHANGED', 'RECOVERY_UNIT_HAS_CONTENT', 'RECOVERY_NOTHING_TO_DO', 'RECOVERY_LIMIT_REACHED',
  'RECOVERY_RUNTIME_CHANGED', 'RECOVERY_OTHER_RUN_ACTIVE', 'RECOVERY_IDEMPOTENCY_CONFLICT', 'RUN_STOP_NOT_ACTIVE',
  'AI_CREDIT_INSUFFICIENT_FOR_RECOVERY', 'RECOVERY_UNAVAILABLE',
] as const;
export type OrchestrationV2RecoveryErrorCode = (typeof ORCHESTRATION_V2_RECOVERY_ERROR_CODES)[number];

export class OrchestrationV2RecoveryError extends Error {
  constructor(readonly code: OrchestrationV2RecoveryErrorCode) {
    super(code);
    this.name = 'OrchestrationV2RecoveryError';
  }
}

/** Why an action is not offered (GET …/recovery). Machine codes only; the UI words them. */
export type OrchestrationV2RecoveryReason =
  | 'RECOVERY_DISABLED'
  | 'RECOVERY_NOT_SUPPORTED'
  | 'RECOVERY_RUN_ACTIVE'
  | 'RECOVERY_DRAINING'
  | 'RECOVERY_RUN_COMPLETE'
  | 'RECOVERY_REVIEW_REQUIRED'
  | 'RECOVERY_PLANNING_INCOMPLETE'
  | 'RECOVERY_RUNTIME_CHANGED'
  | 'RECOVERY_UNIT_HAS_CONTENT'
  | 'RECOVERY_NOTHING_TO_DO'
  | 'RECOVERY_LIMIT_REACHED'
  | 'RECOVERY_UNAVAILABLE'
  | 'RUN_STOP_NOT_ACTIVE';

export type OrchestrationV2RecoveryRunStatus = 'planning' | 'executing' | 'finalizing' | 'ready' | 'needs_action' | 'canceled';
export type OrchestrationV2RecoveryTaskStatus = 'blocked' | 'queued' | 'running' | 'succeeded' | 'failed'
  | 'timed_out' | 'outcome_unknown' | 'canceled';
export type OrchestrationV2RecoveryTaskKind = 'source_snapshot' | 'course_skeleton' | 'chapter_blueprint'
  | 'validate_architecture' | 'publish_inventory' | 'generate_unit' | 'validate_chapter' | 'finalize_course';
export type OrchestrationV2RecoveryScopeKind = 'unit' | 'lesson' | 'chapter' | 'course';

export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['planning', 'executing', 'finalizing']);
const REOPENABLE: ReadonlySet<string> = new Set(['failed', 'timed_out', 'outcome_unknown', 'canceled']);
const LIVE: ReadonlySet<string> = new Set(['blocked', 'queued', 'running']);
const DETERMINISTIC: ReadonlySet<string> = new Set(['validate_chapter', 'finalize_course']);

export interface OrchestrationV2RecoveryRun {
  run_id: string;
  status: OrchestrationV2RecoveryRunStatus;
  failure_code: string | null;
  /** ISO timestamp; the guard binds a resume to this exact value. */
  finished_at: string | null;
  manifest_sealed: boolean;
  completion_receipt: boolean;
  review_receipt: boolean;
  workspace_status: string;
  event_head: number;
}

export interface OrchestrationV2RecoveryTask {
  task_id: string;
  ordinal: number;
  kind: OrchestrationV2RecoveryTaskKind;
  status: OrchestrationV2RecoveryTaskStatus;
  failure_code: string | null;
  attempt_count: number;
  max_attempts: number;
  dispatch_epoch: number;
  chapter_key: string | null;
  node_id: string | null;
  /** canonical_path of the task's node (unit or chapter), null for course-level tasks. */
  node_path: string | null;
  /** True when the node holds an accepted revision (content). */
  node_has_content: boolean;
  ai_reservation_id: string | null;
  accounting_state: string;
  /** Status of ai_reservation_id, when there is one. */
  reservation_status: string | null;
  /** Reopens already recorded for this task (0 before the first recovery). */
  generation: number;
  depends_on: readonly string[];
}

export interface OrchestrationV2RecoveryScope {
  node_id: string;
  kind: OrchestrationV2RecoveryScopeKind;
  path: string;
}

export type OrchestrationV2RecoveryRequest =
  | { action: 'resume' }
  | { action: 'regenerate'; scope: OrchestrationV2RecoveryScope };

export interface OrchestrationV2RecoveryPlanItem {
  task_id: string;
  ordinal: number;
  kind: OrchestrationV2RecoveryTaskKind;
  generation: number;
  prior_status: 'failed' | 'timed_out' | 'outcome_unknown' | 'canceled';
  prior_failure_code: string;
  prior_attempt_count: number;
  prior_dispatch_epoch: number;
  reopen_epoch: number;
  reopened_status: 'queued' | 'blocked';
  prior_ai_reservation_id: string | null;
  /** outcome_unknown whose held reservation must be settled (upper bound) before the reopen. */
  needs_reconcile: boolean;
}

export interface OrchestrationV2RecoveryPlan {
  action: 'resume' | 'regenerate';
  scope: OrchestrationV2RecoveryScope | null;
  items: readonly OrchestrationV2RecoveryPlanItem[];
  /** generate_unit tasks reopened: each one is a paid AI call. */
  ai_unit_count: number;
}

export type OrchestrationV2RecoveryPlanResult =
  | { ok: true; plan: OrchestrationV2RecoveryPlan }
  | { ok: false; reason: OrchestrationV2RecoveryReason };

/** Run-level reason a stopped run cannot be reopened, or null when it can. */
export function orchestrationV2RecoveryRunBlocker(
  run: OrchestrationV2RecoveryRun | null,
  tasks: readonly OrchestrationV2RecoveryTask[],
): OrchestrationV2RecoveryReason | null {
  if (!run) return 'RECOVERY_NOT_SUPPORTED';
  if (ACTIVE_RUN_STATUSES.has(run.status)) return 'RECOVERY_RUN_ACTIVE';
  if (run.status === 'ready' || run.completion_receipt) return 'RECOVERY_RUN_COMPLETE';
  if (run.status !== 'needs_action') return 'RECOVERY_NOT_SUPPORTED';
  if (run.failure_code === ORCHESTRATION_V2_ASSESSMENT_REVIEW_REQUIRED || run.review_receipt) {
    return 'RECOVERY_REVIEW_REQUIRED';
  }
  if (!run.manifest_sealed) return 'RECOVERY_PLANNING_INCOMPLETE';
  if (!run.failure_code || !run.finished_at) return 'RECOVERY_NOT_SUPPORTED';
  // A stopped run publishes needs_action on the workspace only after its last
  // in-flight task settled: until then nothing may be reopened.
  if (run.workspace_status !== 'needs_action' || tasks.some(task => LIVE.has(task.status))) return 'RECOVERY_DRAINING';
  return null;
}

/** Stop is offered while the run is active. */
export function orchestrationV2StopReason(run: OrchestrationV2RecoveryRun | null): OrchestrationV2RecoveryReason | null {
  if (!run) return 'RECOVERY_NOT_SUPPORTED';
  return ACTIVE_RUN_STATUSES.has(run.status) ? null : 'RUN_STOP_NOT_ACTIVE';
}

function epochHeadroom(task: OrchestrationV2RecoveryTask): boolean {
  // One epoch for the reopen, one per claim of the fresh attempt budget.
  return task.dispatch_epoch + 1 + task.max_attempts <= ORCHESTRATION_V2_MAX_DISPATCH_EPOCH;
}

function accountingReady(task: OrchestrationV2RecoveryTask): boolean {
  if (task.status === 'outcome_unknown') {
    return task.ai_reservation_id !== null && task.accounting_state === 'pending_reconciliation'
      && (task.reservation_status === 'reserved' || task.reservation_status === 'finalized');
  }
  return task.ai_reservation_id === null && task.accounting_state === 'not_required';
}

function inScope(task: OrchestrationV2RecoveryTask, scope: OrchestrationV2RecoveryScope): boolean {
  if (task.kind !== 'generate_unit') return false;
  if (scope.kind === 'course') return true;
  if (scope.kind === 'unit') return task.node_id === scope.node_id;
  return typeof task.node_path === 'string' && task.node_path.startsWith(`${scope.path}.`);
}

/**
 * The exact set of task reopens for one request. Pure and deterministic: the
 * repository runs it again under the row locks, and the SQL guards re-check
 * every item against the recorded evidence.
 */
export function planOrchestrationV2Recovery(input: {
  run: OrchestrationV2RecoveryRun | null;
  tasks: readonly OrchestrationV2RecoveryTask[];
  request: OrchestrationV2RecoveryRequest;
}): OrchestrationV2RecoveryPlanResult {
  const blocker = orchestrationV2RecoveryRunBlocker(input.run, input.tasks);
  if (blocker) return { ok: false, reason: blocker };
  const tasks = [...input.tasks].sort((left, right) => left.ordinal - right.ordinal);
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  const chosen = new Map<string, OrchestrationV2RecoveryTask>();

  if (input.request.action === 'regenerate') {
    const scope = input.request.scope;
    const scoped = tasks.filter(task => inScope(task, scope));
    const missing = scoped.filter(task => task.status !== 'succeeded' && !task.node_has_content);
    if (!missing.length) {
      return { ok: false, reason: scope.kind === 'unit' && scoped.length === 1 ? 'RECOVERY_UNIT_HAS_CONTENT'
        : 'RECOVERY_NOTHING_TO_DO' };
    }
    for (const task of missing) {
      // A unit depends only on the published inventory; anything else could never become runnable.
      if (!REOPENABLE.has(task.status) || !accountingReady(task)
        || !task.depends_on.every(id => byId.get(id)?.status === 'succeeded')) {
        return { ok: false, reason: 'RECOVERY_UNAVAILABLE' };
      }
      if (task.generation + 1 > ORCHESTRATION_V2_RECOVERY_UNIT_REWRITE_LIMIT || !epochHeadroom(task)) {
        return { ok: false, reason: 'RECOVERY_LIMIT_REACHED' };
      }
      chosen.set(task.task_id, task);
    }
  }
  for (const task of tasks) {
    if (!DETERMINISTIC.has(task.kind) || !REOPENABLE.has(task.status) || !accountingReady(task)) continue;
    const runnable = task.depends_on.every(id => byId.get(id)?.status === 'succeeded' || chosen.has(id));
    if (!runnable || task.generation + 1 > ORCHESTRATION_V2_RECOVERY_DETERMINISTIC_REOPEN_LIMIT
      || !epochHeadroom(task)) continue;
    chosen.set(task.task_id, task);
  }
  if (!chosen.size) return { ok: false, reason: 'RECOVERY_NOTHING_TO_DO' };

  const items = [...chosen.values()].sort((left, right) => left.ordinal - right.ordinal).map(task => ({
    task_id: task.task_id, ordinal: task.ordinal, kind: task.kind, generation: task.generation + 1,
    prior_status: task.status as OrchestrationV2RecoveryPlanItem['prior_status'],
    prior_failure_code: task.failure_code ?? '',
    prior_attempt_count: task.attempt_count, prior_dispatch_epoch: task.dispatch_epoch,
    reopen_epoch: task.dispatch_epoch + 1,
    reopened_status: task.depends_on.every(id => byId.get(id)?.status === 'succeeded') ? 'queued' as const : 'blocked' as const,
    prior_ai_reservation_id: task.ai_reservation_id,
    needs_reconcile: task.status === 'outcome_unknown' && task.reservation_status === 'reserved',
  }));
  // A terminal task always carries its failure code (schema CHECK); never record a blank one.
  if (items.some(item => !/^[A-Z][A-Z0-9_]{0,99}$/.test(item.prior_failure_code))) {
    return { ok: false, reason: 'RECOVERY_UNAVAILABLE' };
  }
  return { ok: true, plan: Object.freeze({ action: input.request.action,
    scope: input.request.action === 'regenerate' ? input.request.scope : null,
    items: Object.freeze(items), ai_unit_count: items.filter(item => item.kind === 'generate_unit').length }) };
}

/** Planner reason -> POST error (the run changed under the request, or nothing is left to do). */
export function orchestrationV2RecoveryErrorFor(reason: OrchestrationV2RecoveryReason): OrchestrationV2RecoveryErrorCode {
  switch (reason) {
    case 'RECOVERY_UNIT_HAS_CONTENT': return 'RECOVERY_UNIT_HAS_CONTENT';
    case 'RECOVERY_LIMIT_REACHED': return 'RECOVERY_LIMIT_REACHED';
    case 'RECOVERY_RUNTIME_CHANGED': return 'RECOVERY_RUNTIME_CHANGED';
    case 'RECOVERY_DISABLED': return 'RECOVERY_DISABLED';
    case 'RECOVERY_UNAVAILABLE': return 'RECOVERY_UNAVAILABLE';
    case 'RECOVERY_RUN_ACTIVE': case 'RECOVERY_DRAINING': case 'RUN_STOP_NOT_ACTIVE': return 'RECOVERY_STATE_CHANGED';
    case 'RECOVERY_NOT_SUPPORTED': case 'RECOVERY_RUN_COMPLETE': case 'RECOVERY_REVIEW_REQUIRED':
    case 'RECOVERY_PLANNING_INCOMPLETE': case 'RECOVERY_NOTHING_TO_DO': return 'RECOVERY_NOTHING_TO_DO';
  }
}

/** Idempotency fingerprint of a recovery request (same operation id + other body -> 409). */
export function orchestrationV2RecoveryRequestHash(input: {
  action: 'resume' | 'regenerate';
  node_id: string | null;
  expected_workspace_revision: number;
}): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, action: input.action,
    node_id: input.node_id === null ? null : input.node_id.toLowerCase(),
    expected_workspace_revision: input.expected_workspace_revision })).digest('hex');
}

export interface OrchestrationV2RecoveryOption {
  available: boolean;
  reason: OrchestrationV2RecoveryReason | null;
}

export interface OrchestrationV2RecoveryView {
  run_id: string | null;
  run_status: OrchestrationV2RecoveryRunStatus | null;
  workspace_status: string;
  failure_code: string | null;
  /** last_event_sequence the client sends back as expected_workspace_revision. */
  event_head: number;
  draining: boolean;
  stop: OrchestrationV2RecoveryOption;
  resume: OrchestrationV2RecoveryOption & { task_count: number };
  regenerate: OrchestrationV2RecoveryOption & {
    max_rewrites_per_lesson: number;
    missing_unit_count: number;
    course: (OrchestrationV2RecoveryOption & { node_id: string; unit_count: number }) | null;
    chapters: Array<OrchestrationV2RecoveryOption & { node_id: string; chapter_key: string; unit_count: number }>;
    units: Array<OrchestrationV2RecoveryOption & { node_id: string; chapter_node_id: string | null;
      rewrites_used: number }>;
  };
}

/**
 * What the author can do now. Every option is computed by the same planner the
 * POST runs, so the UI never offers an action the server would refuse for a
 * reason it already knows.
 */
export function describeOrchestrationV2Recovery(input: {
  run: OrchestrationV2RecoveryRun | null;
  workspace_status: string;
  event_head: number;
  tasks: readonly OrchestrationV2RecoveryTask[];
  course_node: { node_id: string; path: string } | null;
  stop_enabled: boolean;
  recovery_enabled: boolean;
  runtime_changed: boolean;
}): OrchestrationV2RecoveryView {
  const { run, tasks } = input;
  const blocker = orchestrationV2RecoveryRunBlocker(run, tasks);
  const gate = (reason: OrchestrationV2RecoveryReason | null): OrchestrationV2RecoveryOption => {
    const effective = !input.recovery_enabled ? 'RECOVERY_DISABLED'
      : reason ?? (input.runtime_changed ? 'RECOVERY_RUNTIME_CHANGED' : null);
    return { available: effective === null, reason: effective };
  };
  const plan = (request: OrchestrationV2RecoveryRequest) => planOrchestrationV2Recovery({ run, tasks, request });
  const option = (request: OrchestrationV2RecoveryRequest) => {
    const result = plan(request);
    return { ...gate(result.ok ? null : result.reason), plan: result.ok ? result.plan : null };
  };
  const stopReason = input.stop_enabled ? orchestrationV2StopReason(run) : 'RECOVERY_DISABLED';
  const units = tasks.filter(task => task.kind === 'generate_unit' && task.node_id
    && task.status !== 'succeeded' && !task.node_has_content).sort((left, right) => left.ordinal - right.ordinal);
  const chapterNodes = tasks.filter(task => task.kind === 'validate_chapter' && task.node_id && task.node_path
    && task.chapter_key).sort((left, right) => left.ordinal - right.ordinal);
  const chapterOf = (unit: OrchestrationV2RecoveryTask) => chapterNodes.find(chapter =>
    chapter.chapter_key === unit.chapter_key) ?? null;
  const resume = option({ action: 'resume' });
  const course = input.course_node && units.length
    ? option({ action: 'regenerate', scope: { node_id: input.course_node.node_id, kind: 'course',
      path: input.course_node.path } })
    : null;
  return {
    run_id: run?.run_id ?? null,
    run_status: run?.status ?? null,
    workspace_status: input.workspace_status,
    failure_code: run?.failure_code ?? null,
    event_head: input.event_head,
    draining: blocker === 'RECOVERY_DRAINING',
    stop: { available: stopReason === null, reason: stopReason },
    resume: { available: resume.available, reason: resume.reason, task_count: resume.plan?.items.length ?? 0 },
    regenerate: {
      ...(course ? { available: course.available, reason: course.reason }
        : gate(blocker ?? 'RECOVERY_NOTHING_TO_DO')),
      max_rewrites_per_lesson: ORCHESTRATION_V2_RECOVERY_UNIT_REWRITE_LIMIT,
      missing_unit_count: units.length,
      course: course && input.course_node ? { node_id: input.course_node.node_id, available: course.available,
        reason: course.reason, unit_count: course.plan?.ai_unit_count ?? 0 } : null,
      chapters: chapterNodes.filter(chapter => units.some(unit => unit.chapter_key === chapter.chapter_key))
        .map(chapter => {
          const result = option({ action: 'regenerate', scope: { node_id: chapter.node_id!, kind: 'chapter',
            path: chapter.node_path! } });
          return { node_id: chapter.node_id!, chapter_key: chapter.chapter_key!, available: result.available,
            reason: result.reason, unit_count: result.plan?.ai_unit_count ?? 0 };
        }),
      units: units.map(unit => {
        const result = option({ action: 'regenerate', scope: { node_id: unit.node_id!, kind: 'unit',
          path: unit.node_path ?? '' } });
        return { node_id: unit.node_id!, chapter_node_id: chapterOf(unit)?.node_id ?? null,
          available: result.available, reason: result.reason, rewrites_used: unit.generation };
      }),
    },
  };
}
