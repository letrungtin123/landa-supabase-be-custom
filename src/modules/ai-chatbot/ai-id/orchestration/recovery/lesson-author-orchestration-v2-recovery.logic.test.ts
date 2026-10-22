import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORCHESTRATION_V2_RECOVERY_DETERMINISTIC_REOPEN_LIMIT,
  ORCHESTRATION_V2_RECOVERY_ERROR_CODES,
  ORCHESTRATION_V2_RECOVERY_UNIT_REWRITE_LIMIT,
  describeOrchestrationV2Recovery,
  orchestrationV2RecoveryErrorFor,
  orchestrationV2RecoveryRequestHash,
  orchestrationV2RecoveryRunBlocker,
  orchestrationV2StopReason,
  planOrchestrationV2Recovery,
  type OrchestrationV2RecoveryReason,
  type OrchestrationV2RecoveryRun,
  type OrchestrationV2RecoveryTask,
  type OrchestrationV2RecoveryTaskStatus,
} from './lesson-author-orchestration-v2-recovery.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const INVENTORY = uuid(100), FINALIZE = uuid(900), COURSE_NODE = uuid(990);
const unitId = (chapter: number, unit: number) => uuid(1000 + chapter * 10 + unit);
const unitNode = (chapter: number, unit: number) => uuid(3000 + chapter * 10 + unit);
const validateId = (chapter: number) => uuid(2000 + chapter);
const chapterNode = (chapter: number) => uuid(4000 + chapter);

function run(overrides: Partial<OrchestrationV2RecoveryRun> = {}): OrchestrationV2RecoveryRun {
  return { run_id: uuid(1), status: 'needs_action', failure_code: 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID',
    finished_at: '2026-10-20 10:00:00.123456+07', manifest_sealed: true, completion_receipt: false,
    review_receipt: false, workspace_status: 'needs_action', event_head: 42, ...overrides };
}

function terminal(status: OrchestrationV2RecoveryTaskStatus, kind: 'unit' | 'deterministic') {
  if (status === 'succeeded') return { failure_code: null, attempt_count: 1, dispatch_epoch: 1 };
  if (status === 'canceled') return { failure_code: 'UPSTREAM_UNIT_UNAVAILABLE', attempt_count: 0, dispatch_epoch: 0 };
  if (status === 'outcome_unknown') {
    return { failure_code: 'PROVIDER_OUTCOME_UNKNOWN', attempt_count: 1, dispatch_epoch: 1,
      ai_reservation_id: uuid(7000), accounting_state: 'pending_reconciliation', reservation_status: 'reserved' };
  }
  if (['blocked', 'queued', 'running'].includes(status)) return { failure_code: null, attempt_count: 0, dispatch_epoch: 0 };
  return { failure_code: kind === 'unit' ? 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID' : 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID',
    attempt_count: 2, dispatch_epoch: 2 };
}

function task(overrides: Partial<OrchestrationV2RecoveryTask> & Pick<OrchestrationV2RecoveryTask, 'task_id' | 'kind'
  | 'ordinal'>): OrchestrationV2RecoveryTask {
  return { status: 'succeeded', failure_code: null, attempt_count: 1, max_attempts: 2, dispatch_epoch: 1,
    chapter_key: null, node_id: null, node_path: null, node_has_content: false, ai_reservation_id: null,
    accounting_state: 'not_required', reservation_status: null, generation: 0, depends_on: [], ...overrides };
}

/** A sealed course: inventory, units per chapter, one validation per chapter, one finalizer. */
function course(chapters: Array<{ units: OrchestrationV2RecoveryTaskStatus[]; validate?: OrchestrationV2RecoveryTaskStatus }>,
  finalize: OrchestrationV2RecoveryTaskStatus = 'canceled'): OrchestrationV2RecoveryTask[] {
  const tasks: OrchestrationV2RecoveryTask[] = [task({ task_id: INVENTORY, kind: 'publish_inventory', ordinal: 11 })];
  let ordinal = 12;
  chapters.forEach((chapter, index) => chapter.units.forEach((status, unitIndex) => {
    const c = index + 1, u = unitIndex + 1;
    tasks.push(task({ task_id: unitId(c, u), kind: 'generate_unit', ordinal: ordinal++, status, ...terminal(status, 'unit'),
      chapter_key: `chapter-${c}`, node_id: unitNode(c, u), node_path: `chapter_${c}.lesson_1.unit_${u}`,
      node_has_content: status === 'succeeded', depends_on: [INVENTORY] }));
  }));
  const validates = chapters.map((chapter, index) => {
    const c = index + 1;
    const status = chapter.validate ?? (chapter.units.every(unit => unit === 'succeeded') ? 'succeeded' : 'canceled');
    return task({ task_id: validateId(c), kind: 'validate_chapter', ordinal: ordinal++, status,
      ...terminal(status, 'deterministic'), chapter_key: `chapter-${c}`, node_id: chapterNode(c),
      node_path: `chapter_${c}`, node_has_content: true, depends_on: chapter.units.map((_, u) => unitId(c, u + 1)) });
  });
  tasks.push(...validates);
  tasks.push(task({ task_id: FINALIZE, kind: 'finalize_course', ordinal: ordinal++, status: finalize,
    ...terminal(finalize, 'deterministic'), depends_on: validates.map(item => item.task_id) }));
  return tasks;
}

const unitScope = (chapter: number, unit: number) => ({ node_id: unitNode(chapter, unit), kind: 'unit' as const,
  path: `chapter_${chapter}.lesson_1.unit_${unit}` });
const chapterScope = (chapter: number) => ({ node_id: chapterNode(chapter), kind: 'chapter' as const,
  path: `chapter_${chapter}` });
const courseScope = { node_id: COURSE_NODE, kind: 'course' as const, path: 'course' };

function plan(tasks: OrchestrationV2RecoveryTask[], request: Parameters<typeof planOrchestrationV2Recovery>[0]['request'],
  runOverrides: Partial<OrchestrationV2RecoveryRun> = {}) {
  return planOrchestrationV2Recovery({ run: run(runOverrides), tasks, request });
}
function items(result: ReturnType<typeof plan>) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.plan.items.map(item => [item.task_id, item.reopened_status, item.generation,
    item.reopen_epoch]) : [];
}

test('run-level blockers: only a drained needs_action run with a sealed manifest can be reopened', () => {
  const tasks = course([{ units: ['succeeded', 'failed'] }]);
  const cases: Array<[Partial<OrchestrationV2RecoveryRun> | null, OrchestrationV2RecoveryReason | null]> = [
    [null, 'RECOVERY_NOT_SUPPORTED'],
    [{ status: 'planning' }, 'RECOVERY_RUN_ACTIVE'],
    [{ status: 'executing' }, 'RECOVERY_RUN_ACTIVE'],
    [{ status: 'finalizing' }, 'RECOVERY_RUN_ACTIVE'],
    [{ status: 'ready' }, 'RECOVERY_RUN_COMPLETE'],
    [{ completion_receipt: true }, 'RECOVERY_RUN_COMPLETE'],
    [{ status: 'canceled' }, 'RECOVERY_NOT_SUPPORTED'],
    [{ failure_code: 'ASSESSMENT_REVIEW_REQUIRED' }, 'RECOVERY_REVIEW_REQUIRED'],
    [{ review_receipt: true }, 'RECOVERY_REVIEW_REQUIRED'],
    [{ manifest_sealed: false }, 'RECOVERY_PLANNING_INCOMPLETE'],
    [{ finished_at: null }, 'RECOVERY_NOT_SUPPORTED'],
    [{ failure_code: null }, 'RECOVERY_NOT_SUPPORTED'],
    [{ workspace_status: 'drafting' }, 'RECOVERY_DRAINING'],
    [{}, null],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(orchestrationV2RecoveryRunBlocker(overrides ? run(overrides) : null, tasks), expected,
      JSON.stringify(overrides));
  }
  const running = tasks.map(item => item.task_id === unitId(1, 2) ? { ...item, status: 'running' as const } : item);
  assert.equal(orchestrationV2RecoveryRunBlocker(run(), running), 'RECOVERY_DRAINING');
  assert.equal(orchestrationV2StopReason(null), 'RECOVERY_NOT_SUPPORTED');
  assert.equal(orchestrationV2StopReason(run({ status: 'executing' })), null);
  assert.equal(orchestrationV2StopReason(run({ status: 'planning' })), null);
  assert.equal(orchestrationV2StopReason(run()), 'RUN_STOP_NOT_ACTIVE');
  assert.equal(orchestrationV2StopReason(run({ status: 'ready' })), 'RUN_STOP_NOT_ACTIVE');
});

test('rewriting one lesson reopens it with a fresh epoch and the validations it unblocks', () => {
  // Chapter 1: one failed unit; chapter 2 complete; the finalizer waits for chapter 1 only.
  const tasks = course([{ units: ['succeeded', 'failed'] }, { units: ['succeeded'] }]);
  assert.deepEqual(items(plan(tasks, { action: 'regenerate', scope: unitScope(1, 2) })), [
    [unitId(1, 2), 'queued', 1, 3],
    [validateId(1), 'blocked', 1, 1],
    [FINALIZE, 'blocked', 1, 1],
  ]);
  const result = plan(tasks, { action: 'regenerate', scope: unitScope(1, 2) });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.plan.ai_unit_count, 1);
    assert.deepEqual(result.plan.items[0], { task_id: unitId(1, 2), ordinal: 13, kind: 'generate_unit', generation: 1,
      prior_status: 'failed', prior_failure_code: 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID', prior_attempt_count: 2,
      prior_dispatch_epoch: 2, reopen_epoch: 3, reopened_status: 'queued', prior_ai_reservation_id: null,
      needs_reconcile: false });
  }
});

test('a validation or finalizer is reopened only when every dependency will be done', () => {
  // Two failed units in chapter 1: rewriting one cannot complete the chapter.
  const tasks = course([{ units: ['failed', 'failed'] }, { units: ['succeeded'] }]);
  assert.deepEqual(items(plan(tasks, { action: 'regenerate', scope: unitScope(1, 1) })), [[unitId(1, 1), 'queued', 1, 3]]);
  // The chapter rewrite covers both, so validation and finalizer follow.
  assert.deepEqual(items(plan(tasks, { action: 'regenerate', scope: chapterScope(1) })), [
    [unitId(1, 1), 'queued', 1, 3], [unitId(1, 2), 'queued', 1, 3], [validateId(1), 'blocked', 1, 1],
    [FINALIZE, 'blocked', 1, 1],
  ]);
  // Another chapter still missing a lesson: the finalizer stays canceled.
  const twoBroken = course([{ units: ['failed'] }, { units: ['succeeded', 'canceled'] }]);
  assert.deepEqual(items(plan(twoBroken, { action: 'regenerate', scope: chapterScope(1) })), [
    [unitId(1, 1), 'queued', 1, 3], [validateId(1), 'blocked', 1, 1],
  ]);
  assert.deepEqual(items(plan(twoBroken, { action: 'regenerate', scope: courseScope })), [
    [unitId(1, 1), 'queued', 1, 3], [unitId(2, 2), 'queued', 1, 1], [validateId(1), 'blocked', 1, 1],
    [validateId(2), 'blocked', 1, 1], [FINALIZE, 'blocked', 1, 1],
  ]);
});

test('resume re-runs only the free validations whose lessons are done, then the finalizer', () => {
  // Chapter evidence failed (the hash bug fixed in code): resume re-validates it, no AI call.
  const tasks = course([{ units: ['succeeded'], validate: 'failed' }, { units: ['succeeded'] }]);
  const result = plan(tasks, { action: 'resume' });
  assert.deepEqual(items(result), [[validateId(1), 'queued', 1, 3], [FINALIZE, 'blocked', 1, 1]]);
  assert.equal(result.ok && result.plan.ai_unit_count, 0);
  // Only the finalizer failed: it is queued directly.
  const finalizerOnly = course([{ units: ['succeeded'] }], 'failed');
  assert.deepEqual(items(plan(finalizerOnly, { action: 'resume' })), [[FINALIZE, 'queued', 1, 3]]);
  // Lessons missing everywhere: resume has nothing free to run.
  const missing = course([{ units: ['failed'] }]);
  assert.deepEqual(plan(missing, { action: 'resume' }), { ok: false, reason: 'RECOVERY_NOTHING_TO_DO' });
  // A rewrite still re-runs every free validation that becomes runnable.
  const mixed = course([{ units: ['succeeded'], validate: 'failed' }, { units: ['failed'] }]);
  assert.deepEqual(items(plan(mixed, { action: 'regenerate', scope: chapterScope(2) })), [
    [unitId(2, 1), 'queued', 1, 3], [validateId(1), 'queued', 1, 3], [validateId(2), 'blocked', 1, 1],
    [FINALIZE, 'blocked', 1, 1],
  ]);
});

test('content, scope and limit refusals', () => {
  const tasks = course([{ units: ['succeeded', 'failed'] }]);
  assert.deepEqual(plan(tasks, { action: 'regenerate', scope: unitScope(1, 1) }),
    { ok: false, reason: 'RECOVERY_UNIT_HAS_CONTENT' });
  assert.deepEqual(plan(course([{ units: ['succeeded'] }, { units: ['failed'] }]),
    { action: 'regenerate', scope: chapterScope(1) }), { ok: false, reason: 'RECOVERY_NOTHING_TO_DO' });
  assert.deepEqual(plan(tasks, { action: 'regenerate', scope: { node_id: uuid(5555), kind: 'unit', path: 'x' } }),
    { ok: false, reason: 'RECOVERY_NOTHING_TO_DO' });
  const third = tasks.map(item => item.task_id === unitId(1, 2)
    ? { ...item, generation: ORCHESTRATION_V2_RECOVERY_UNIT_REWRITE_LIMIT } : item);
  assert.deepEqual(plan(third, { action: 'regenerate', scope: unitScope(1, 2) }),
    { ok: false, reason: 'RECOVERY_LIMIT_REACHED' });
  const second = tasks.map(item => item.task_id === unitId(1, 2) ? { ...item, generation: 2 } : item);
  assert.equal(items(plan(second, { action: 'regenerate', scope: unitScope(1, 2) }))[0]![2], 3);
  // Epoch headroom: reopen + max_attempts claims must stay within dispatch_epoch <= 100.
  const late = tasks.map(item => item.task_id === unitId(1, 2) ? { ...item, dispatch_epoch: 98 } : item);
  assert.deepEqual(plan(late, { action: 'regenerate', scope: unitScope(1, 2) }),
    { ok: false, reason: 'RECOVERY_LIMIT_REACHED' });
  const edge = tasks.map(item => item.task_id === unitId(1, 2) ? { ...item, dispatch_epoch: 97 } : item);
  assert.equal(items(plan(edge, { action: 'regenerate', scope: unitScope(1, 2) }))[0]![3], 98);
  // A deterministic task past its own limit is left closed (no stuck blocked task is created).
  const tired = course([{ units: ['succeeded'], validate: 'failed' }]).map(item => item.task_id === validateId(1)
    ? { ...item, generation: ORCHESTRATION_V2_RECOVERY_DETERMINISTIC_REOPEN_LIMIT } : item);
  assert.deepEqual(plan(tired, { action: 'resume' }), { ok: false, reason: 'RECOVERY_NOTHING_TO_DO' });
});

test('accounting evidence: an unknown outcome is reconciled first; held credit is never dropped', () => {
  const tasks = course([{ units: ['succeeded', 'outcome_unknown'] }]);
  const result = plan(tasks, { action: 'regenerate', scope: unitScope(1, 2) });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.plan.items[0]!.needs_reconcile, true);
    assert.equal(result.plan.items[0]!.prior_ai_reservation_id, uuid(7000));
  }
  const settled = tasks.map(item => item.task_id === unitId(1, 2) ? { ...item, reservation_status: 'finalized' } : item);
  const settledPlan = plan(settled, { action: 'regenerate', scope: unitScope(1, 2) });
  assert.ok(settledPlan.ok && settledPlan.plan.items[0]!.needs_reconcile === false);
  const released = tasks.map(item => item.task_id === unitId(1, 2) ? { ...item, reservation_status: 'released' } : item);
  assert.deepEqual(plan(released, { action: 'regenerate', scope: unitScope(1, 2) }),
    { ok: false, reason: 'RECOVERY_UNAVAILABLE' });
  const leaked = course([{ units: ['failed'] }]).map(item => item.task_id === unitId(1, 1)
    ? { ...item, ai_reservation_id: uuid(7001), accounting_state: 'reserved' } : item);
  assert.deepEqual(plan(leaked, { action: 'regenerate', scope: unitScope(1, 1) }),
    { ok: false, reason: 'RECOVERY_UNAVAILABLE' });
});

test('golden transition matrix: run status x unit status x action', () => {
  const runStatuses: Array<Partial<OrchestrationV2RecoveryRun>> = [
    { status: 'executing', failure_code: null, finished_at: null, workspace_status: 'drafting' },
    { status: 'needs_action', failure_code: 'RUN_STOPPED_BY_AUTHOR' },
    { status: 'needs_action', failure_code: 'ASSESSMENT_REVIEW_REQUIRED' },
    { status: 'ready', failure_code: null, workspace_status: 'ready' },
  ];
  const unitStatuses: OrchestrationV2RecoveryTaskStatus[] = ['succeeded', 'failed', 'timed_out', 'canceled',
    'outcome_unknown'];
  const lines: string[] = [];
  for (const runOverrides of runStatuses) {
    for (const status of unitStatuses) {
      const tasks = course([{ units: ['succeeded', status] }]);
      const regenerate = plan(tasks, { action: 'regenerate', scope: unitScope(1, 2) }, runOverrides);
      const resume = plan(tasks, { action: 'resume' }, runOverrides);
      const show = (result: ReturnType<typeof plan>) => result.ok
        ? result.plan.items.map(item => `${item.kind}:${item.reopened_status}`).join('+') : result.reason;
      lines.push(`${runOverrides.status}/${runOverrides.failure_code ?? '-'} ${status} | regenerate=${show(regenerate)}`
        + ` | resume=${show(resume)}`);
    }
  }
  assert.deepEqual(lines, [
    'executing/- succeeded | regenerate=RECOVERY_RUN_ACTIVE | resume=RECOVERY_RUN_ACTIVE',
    'executing/- failed | regenerate=RECOVERY_RUN_ACTIVE | resume=RECOVERY_RUN_ACTIVE',
    'executing/- timed_out | regenerate=RECOVERY_RUN_ACTIVE | resume=RECOVERY_RUN_ACTIVE',
    'executing/- canceled | regenerate=RECOVERY_RUN_ACTIVE | resume=RECOVERY_RUN_ACTIVE',
    'executing/- outcome_unknown | regenerate=RECOVERY_RUN_ACTIVE | resume=RECOVERY_RUN_ACTIVE',
    // Every lesson and its chapter are done: only the canceled finalizer is left, free to run.
    'needs_action/RUN_STOPPED_BY_AUTHOR succeeded | regenerate=RECOVERY_UNIT_HAS_CONTENT'
      + ' | resume=finalize_course:queued',
    'needs_action/RUN_STOPPED_BY_AUTHOR failed | regenerate=generate_unit:queued+validate_chapter:blocked'
      + '+finalize_course:blocked | resume=RECOVERY_NOTHING_TO_DO',
    'needs_action/RUN_STOPPED_BY_AUTHOR timed_out | regenerate=generate_unit:queued+validate_chapter:blocked'
      + '+finalize_course:blocked | resume=RECOVERY_NOTHING_TO_DO',
    'needs_action/RUN_STOPPED_BY_AUTHOR canceled | regenerate=generate_unit:queued+validate_chapter:blocked'
      + '+finalize_course:blocked | resume=RECOVERY_NOTHING_TO_DO',
    'needs_action/RUN_STOPPED_BY_AUTHOR outcome_unknown | regenerate=generate_unit:queued+validate_chapter:blocked'
      + '+finalize_course:blocked | resume=RECOVERY_NOTHING_TO_DO',
    'needs_action/ASSESSMENT_REVIEW_REQUIRED succeeded | regenerate=RECOVERY_REVIEW_REQUIRED | resume=RECOVERY_REVIEW_REQUIRED',
    'needs_action/ASSESSMENT_REVIEW_REQUIRED failed | regenerate=RECOVERY_REVIEW_REQUIRED | resume=RECOVERY_REVIEW_REQUIRED',
    'needs_action/ASSESSMENT_REVIEW_REQUIRED timed_out | regenerate=RECOVERY_REVIEW_REQUIRED | resume=RECOVERY_REVIEW_REQUIRED',
    'needs_action/ASSESSMENT_REVIEW_REQUIRED canceled | regenerate=RECOVERY_REVIEW_REQUIRED | resume=RECOVERY_REVIEW_REQUIRED',
    'needs_action/ASSESSMENT_REVIEW_REQUIRED outcome_unknown | regenerate=RECOVERY_REVIEW_REQUIRED'
      + ' | resume=RECOVERY_REVIEW_REQUIRED',
    'ready/- succeeded | regenerate=RECOVERY_RUN_COMPLETE | resume=RECOVERY_RUN_COMPLETE',
    'ready/- failed | regenerate=RECOVERY_RUN_COMPLETE | resume=RECOVERY_RUN_COMPLETE',
    'ready/- timed_out | regenerate=RECOVERY_RUN_COMPLETE | resume=RECOVERY_RUN_COMPLETE',
    'ready/- canceled | regenerate=RECOVERY_RUN_COMPLETE | resume=RECOVERY_RUN_COMPLETE',
    'ready/- outcome_unknown | regenerate=RECOVERY_RUN_COMPLETE | resume=RECOVERY_RUN_COMPLETE',
  ]);
});

test('every planner reason maps to one documented POST error', () => {
  const reasons: OrchestrationV2RecoveryReason[] = ['RECOVERY_DISABLED', 'RECOVERY_NOT_SUPPORTED', 'RECOVERY_RUN_ACTIVE',
    'RECOVERY_DRAINING', 'RECOVERY_RUN_COMPLETE', 'RECOVERY_REVIEW_REQUIRED', 'RECOVERY_PLANNING_INCOMPLETE',
    'RECOVERY_RUNTIME_CHANGED', 'RECOVERY_UNIT_HAS_CONTENT', 'RECOVERY_NOTHING_TO_DO', 'RECOVERY_LIMIT_REACHED',
    'RECOVERY_UNAVAILABLE', 'RUN_STOP_NOT_ACTIVE', 'RECOVERY_SOURCE_DOCUMENT_MISSING'];
  const mapped = Object.fromEntries(reasons.map(reason => [reason, orchestrationV2RecoveryErrorFor(reason)]));
  for (const code of Object.values(mapped)) assert.ok(ORCHESTRATION_V2_RECOVERY_ERROR_CODES.includes(code));
  assert.equal(mapped.RECOVERY_SOURCE_DOCUMENT_MISSING, 'RECOVERY_SOURCE_DOCUMENT_MISSING');
  assert.equal(mapped.RECOVERY_DRAINING, 'RECOVERY_STATE_CHANGED');
  assert.equal(mapped.RECOVERY_RUN_ACTIVE, 'RECOVERY_STATE_CHANGED');
  assert.equal(mapped.RECOVERY_REVIEW_REQUIRED, 'RECOVERY_NOTHING_TO_DO');
  assert.equal(mapped.RECOVERY_LIMIT_REACHED, 'RECOVERY_LIMIT_REACHED');
});

test('request fingerprint binds action, node and the expected event head', () => {
  const base = { action: 'regenerate' as const, node_id: unitNode(1, 2), expected_workspace_revision: 42 };
  const hash = orchestrationV2RecoveryRequestHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(orchestrationV2RecoveryRequestHash({ ...base, node_id: base.node_id.toUpperCase() }), hash);
  assert.notEqual(orchestrationV2RecoveryRequestHash({ ...base, expected_workspace_revision: 43 }), hash);
  assert.notEqual(orchestrationV2RecoveryRequestHash({ ...base, node_id: unitNode(1, 1) }), hash);
  assert.notEqual(orchestrationV2RecoveryRequestHash({ action: 'resume', node_id: null, expected_workspace_revision: 42 }),
    hash);
});

test('describe: options follow the planner, the gates and the AI settings', () => {
  const tasks = course([{ units: ['succeeded', 'failed'] }, { units: ['canceled'] }]);
  const input = { run: run(), workspace_status: 'needs_action', event_head: 42, tasks,
    course_node: { node_id: COURSE_NODE, path: 'course' }, stop_enabled: true, recovery_enabled: true,
    runtime_changed: false };
  const view = describeOrchestrationV2Recovery(input);
  assert.equal(view.event_head, 42);
  assert.equal(view.draining, false);
  assert.deepEqual(view.stop, { available: false, reason: 'RUN_STOP_NOT_ACTIVE' });
  assert.deepEqual(view.resume, { available: false, reason: 'RECOVERY_NOTHING_TO_DO', task_count: 0 });
  assert.equal(view.regenerate.available, true);
  assert.equal(view.regenerate.missing_unit_count, 2);
  assert.deepEqual(view.regenerate.course, { node_id: COURSE_NODE, available: true, reason: null, unit_count: 2 });
  assert.deepEqual(view.regenerate.chapters.map(item => [item.chapter_key, item.available, item.unit_count]),
    [['chapter-1', true, 1], ['chapter-2', true, 1]]);
  assert.deepEqual(view.regenerate.units.map(item => [item.node_id, item.chapter_node_id, item.available,
    item.rewrites_used]), [[unitNode(1, 2), chapterNode(1), true, 0], [unitNode(2, 1), chapterNode(2), true, 0]]);

  const disabled = describeOrchestrationV2Recovery({ ...input, stop_enabled: false, recovery_enabled: false });
  assert.deepEqual(disabled.stop, { available: false, reason: 'RECOVERY_DISABLED' });
  assert.equal(disabled.regenerate.reason, 'RECOVERY_DISABLED');
  assert.ok(disabled.regenerate.units.every(item => !item.available && item.reason === 'RECOVERY_DISABLED'));

  const changed = describeOrchestrationV2Recovery({ ...input, runtime_changed: true });
  assert.equal(changed.regenerate.reason, 'RECOVERY_RUNTIME_CHANGED');
  assert.equal(changed.regenerate.available, false);

  // A source document deleted after the stop: no rewrite is offered (the reason says why); Continue is unchanged.
  const sourceless = describeOrchestrationV2Recovery({ ...input, sources_available: false });
  assert.deepEqual([sourceless.regenerate.available, sourceless.regenerate.reason], [false, 'RECOVERY_SOURCE_DOCUMENT_MISSING']);
  assert.deepEqual(sourceless.regenerate.course, { node_id: COURSE_NODE, available: false,
    reason: 'RECOVERY_SOURCE_DOCUMENT_MISSING', unit_count: 2 });
  assert.ok([...sourceless.regenerate.chapters, ...sourceless.regenerate.units]
    .every(item => !item.available && item.reason === 'RECOVERY_SOURCE_DOCUMENT_MISSING'));
  assert.deepEqual(sourceless.resume, view.resume);
  const resumable = course([{ units: ['succeeded'] }], 'failed');
  assert.deepEqual(describeOrchestrationV2Recovery({ ...input, tasks: resumable, sources_available: false }).resume,
    describeOrchestrationV2Recovery({ ...input, tasks: resumable }).resume);

  const active = describeOrchestrationV2Recovery({ ...input, run: run({ status: 'executing', failure_code: null,
    finished_at: null, workspace_status: 'drafting' }), workspace_status: 'drafting' });
  assert.deepEqual(active.stop, { available: true, reason: null });
  assert.equal(active.regenerate.reason, 'RECOVERY_RUN_ACTIVE');

  const draining = describeOrchestrationV2Recovery({ ...input, run: run({ workspace_status: 'drafting' }),
    workspace_status: 'drafting' });
  assert.equal(draining.draining, true);
  assert.equal(draining.regenerate.reason, 'RECOVERY_DRAINING');

  const none = describeOrchestrationV2Recovery({ ...input, run: null, tasks: [], course_node: null });
  assert.equal(none.run_id, null);
  assert.equal(none.stop.reason, 'RECOVERY_NOT_SUPPORTED');
  assert.equal(none.regenerate.reason, 'RECOVERY_NOT_SUPPORTED');
  assert.deepEqual(none.regenerate.units, []);
});
