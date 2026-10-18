import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// Queue wake-ups written next to a database change are published only after
// that transaction committed (never while it is open, never after a
// rollback) and after the connection went back to the pool. RabbitMQ is not
// connected in tests, so every publish attempt fails fast and is logged by
// its caller: the log line marks when the publish was attempted. In-memory
// pg double; no database, no broker.

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = 'c0000000-0000-4000-8000-000000000001';

interface Harness { log: string[] }

function verb(text: string): string {
  return text.trim().split(/\s+/).slice(0, 2).join(' ');
}

async function install(t: TestContext, respond: (text: string) => { rows: unknown[]; rowCount: number } | undefined) {
  const h: Harness = { log: [] };
  const db = await import('../database.js');
  const handle = (prefix: string) => async (text: string) => {
    h.log.push(`${prefix}${verb(text)}`);
    return respond(text) ?? { rows: [], rowCount: 0 };
  };
  t.mock.method(db.pool, 'query', handle('pool:'));
  t.mock.method(db.pool, 'connect', async () => ({ query: handle('tx:'), release: () => { h.log.push('release'); } }));
  t.mock.method(console, 'error', (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (/publish/i.test(line)) h.log.push('publish-attempt');
  });
  t.mock.method(console, 'warn', () => undefined);
  return { h, db };
}

const auditEntry = (code: string) => ({
  tenantId: TENANT,
  action: 'UPDATE' as const,
  entityType: 'deletion_job',
  entityId: JOB,
  entityName: 'job',
  event: { code },
});

function assertPublishedAfterCommit(log: string[]): void {
  const commit = log.indexOf('tx:COMMIT');
  const release = log.indexOf('release');
  const publish = log.indexOf('publish-attempt');
  assert.ok(commit >= 0, `committed: ${log.join(', ')}`);
  assert.ok(publish > commit && publish > release, `published after COMMIT and release: ${log.join(', ')}`);
}

test('progress recalculation scheduled inside a transaction is woken up after COMMIT, not on rollback', async (t) => {
  const { h, db } = await install(t, (text) => (text.includes('INSERT INTO course_progress_recalculation_jobs')
    ? { rows: [{ id: JOB }], rowCount: 1 } : undefined));
  const { scheduleCourseProgressRecalculation } = await import('../../modules/learner/progress-recalculation-job.service.js');

  await db.withDatabaseTransaction(async () => {
    await scheduleCourseProgressRecalculation({ tenantId: TENANT, courseId: 'course-1', reason: 'enrollment_reactivated' });
    h.log.push('work done');
  });
  assert.ok(h.log.indexOf('tx:INSERT INTO') < h.log.indexOf('tx:COMMIT'), 'the job row is written in the transaction');
  assertPublishedAfterCommit(h.log);

  h.log.length = 0;
  await assert.rejects(db.withDatabaseTransaction(async () => {
    await scheduleCourseProgressRecalculation({ tenantId: TENANT, courseId: 'course-1', reason: 'enrollment_reactivated' });
    throw new Error('audit failed');
  }), /audit failed/);
  assert.equal(h.log.includes('publish-attempt'), false, 'a rolled-back job is never announced');

  // Without a transaction the wake-up is sent right away, as before.
  h.log.length = 0;
  await scheduleCourseProgressRecalculation({ tenantId: TENANT, courseId: 'course-1', reason: 'assignment_deleted' });
  assert.deepEqual(h.log, ['pool:INSERT INTO', 'publish-attempt']);
});

test('bulk enrollment re-activation announces the recalculation after its audited transaction commits', async (t) => {
  const { h } = await install(t, (text) => {
    if (text.includes('FROM courses WHERE id = $1')) return { rows: [{ id: 'course-1' }], rowCount: 1 };
    if (text.includes('reactivated AS')) return { rows: [{ inserted_count: 0, reactivated_count: 2 }], rowCount: 1 };
    if (text.includes('INSERT INTO course_progress_recalculation_jobs')) return { rows: [{ id: JOB }], rowCount: 1 };
    return undefined;
  });
  const { runAuditedTransaction } = await import('../../middleware/audit-log.js');
  const { bulkEnroll } = await import('../../modules/enrollments/enrollments.service.js');
  const result = await runAuditedTransaction(
    () => bulkEnroll(['a0000000-0000-4000-8000-000000000002'], 'course-1', TENANT),
    () => auditEntry('enrollment.bulk.created'),
  );
  assert.deepEqual(result, { enrolled: 2, skipped: -1 });
  assertPublishedAfterCommit(h.log);
});

test('a terminal user deletion job retried in its audited transaction is published after COMMIT', async (t) => {
  const { h } = await install(t, (text) => (text.includes('UPDATE user_deletion_jobs')
    ? { rows: [{ id: JOB, user_id: 'a0000000-0000-4000-8000-000000000002' }], rowCount: 1 } : undefined));
  const { runAuditedTransaction } = await import('../../middleware/audit-log.js');
  const { retryTerminalUserDeletionJob } = await import('../../modules/users/user-deletion.service.js');

  await runAuditedTransaction(() => retryTerminalUserDeletionJob(JOB, TENANT), () => auditEntry('user.deletion_job.retry_queued'));
  assertPublishedAfterCommit(h.log);

  h.log.length = 0;
  await assert.rejects(runAuditedTransaction(
    () => retryTerminalUserDeletionJob(JOB, TENANT),
    () => { throw new Error('audit insert failed'); },
  ), /audit insert failed/);
  assert.ok(h.log.includes('tx:ROLLBACK'));
  assert.equal(h.log.includes('publish-attempt'), false);
});

test('a terminal course deletion job retried in its audited transaction is published after COMMIT', async (t) => {
  const { h } = await install(t, (text) => (text.includes('UPDATE course_deletion_jobs')
    ? { rows: [{ id: JOB, course_id: 'course-1', root_block_id: null, target_type: 'course' }], rowCount: 1 } : undefined));
  const { runAuditedTransaction } = await import('../../middleware/audit-log.js');
  const { retryTerminalCourseDeletionJob } = await import('../../modules/course-deletion/course-deletion.service.js');

  await runAuditedTransaction(() => retryTerminalCourseDeletionJob(JOB, TENANT), () => auditEntry('course.deletion_job.retry_queued'));
  assertPublishedAfterCommit(h.log);
});

test('deleting an assignment announces the recalculation after COMMIT and after the connection is released', async (t) => {
  const { h } = await install(t, (text) => {
    if (text.includes('FROM course_assignments ca')) {
      return { rows: [{ id: JOB, course_id: 'course-1', course_name: 'Course', title: 'Essay', tenant_id: TENANT }], rowCount: 1 };
    }
    if (text.includes('UPDATE course_assignments')) return { rows: [{ id: JOB }], rowCount: 1 };
    if (text.includes('INSERT INTO course_progress_recalculation_jobs')) return { rows: [{ id: 'job-2' }], rowCount: 1 };
    return undefined;
  });
  const { deleteAssignment } = await import('../../modules/assignments/assignments.service.js');
  const deleted = await deleteAssignment(JOB, TENANT);
  assert.equal(deleted.id, JOB);
  assertPublishedAfterCommit(h.log);
  assert.ok(h.log.indexOf('pool:INSERT INTO') > h.log.indexOf('release'), 'the job row is written on a pool connection after release');
});
