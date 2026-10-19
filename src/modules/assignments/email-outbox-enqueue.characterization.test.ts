import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';

// Characterization of what the email outbox enqueues: the feedback,
// owner feedback digest, assignment-created (learner and owner copies), team
// member and course notification emails, and the course-notification fan-out
// job (claim, course check, recipient batch, rendered rows, job progress).
// Every statement (whitespace-normalized text and parameters, so the
// rendered subject, HTML and text of each email) and the return value of
// each case are digested into a golden file written by the code before the
// outbox templates and enqueue code were split. A pg double answers every
// statement with one fixed row (or none, per case). Rewrite the golden file
// only for an intended change:
//   EMAIL_OUTBOX_ENQUEUE_GOLDEN_WRITE=1 npx tsx --test src/modules/assignments/email-outbox-enqueue.characterization.test.ts
// EMAIL_OUTBOX_ENQUEUE_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const outbox = await import('./email-outbox.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'email-outbox-enqueue.characterization.golden.json');
const WRITE_GOLDEN = process.env.EMAIL_OUTBOX_ENQUEUE_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.EMAIL_OUTBOX_ENQUEUE_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOTIFICATION = 'f0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+A1+2026';

/** One row with every column an enqueue or fan-out statement reads. */
const ROW = {
  id: 'job-1', is_enabled: true, username: 'owner@example.test', copy_to_sender: true, copy_to_email: null,
  name: 'Doanh nghiệp <A>', domain_learner: 'learn.example.test', user_id: 'u-1', email: 'learner1@example.test',
  enrolled_at: '2026-10-10T00:00:00.000Z', recipient_id: 'r-1', tenant_id: TENANT, notification_id: NOTIFICATION,
  course_id: COURSE, last_recipient_id: null, attempts: 0, type: 'assignment', title: 'Bài tập 1',
  message: 'Hãy nộp bài & đọc kỹ', course_name: 'Khóa học A', recipient_count: 2,
  metadata: {
    assignment_title: 'Bài tập 1', assignment_question: 'Câu hỏi?\nDòng 2', deadline_enabled: true,
    deadline_mode: 'relative_to_enrollment', deadline_after_days: 7, created_at: '2026-10-12T00:00:00.000Z',
    submission_unlock_mode: 'anytime',
  },
};

type Answer = (text: string, index: number) => { rows: unknown[]; rowCount?: number } | undefined;

interface Statement {
  text: string;
  params: unknown[];
}

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

const TEMPLATE_LOOKUP = /FROM tenant_email_templates/;

function installDb(t: TestContext, answer?: Answer): { statements: Statement[]; client: PoolClient } {
  const statements: Statement[] = [];
  const handle = async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    statements.push({ text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
    const custom = answer?.(text, statements.length - 1);
    // Default templates unless a case gives a tenant template.
    const fallback = /^\s*(BEGIN|COMMIT|ROLLBACK|SET)/i.test(text) || TEMPLATE_LOOKUP.test(text) ? [] : [ROW];
    const rows = custom?.rows ?? fallback;
    return { rows, rowCount: custom?.rowCount ?? rows.length };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  return { statements, client: { query: handle, release() {} } as unknown as PoolClient };
}

const noRowsWhen =
  (pattern: RegExp): Answer =>
  text =>
    pattern.test(text) ? { rows: [] } : undefined;
const rowsWhen =
  (pattern: RegExp, rows: unknown[]): Answer =>
  text =>
    pattern.test(text) ? { rows } : undefined;
const both =
  (...answers: Answer[]): Answer =>
  (text, index) => {
    for (const answer of answers) {
      const result = answer(text, index);
      if (result) return result;
    }
    return undefined;
  };

interface Case {
  name: string;
  run: (client: PoolClient) => Promise<unknown>;
  answer?: Answer;
}
const cases: Case[] = [];
const add = (name: string, run: (client: PoolClient) => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });

const feedback = (extra: Record<string, unknown> = {}) => ({
  tenantId: TENANT, submissionId: 's0000000-0000-4000-8000-000000000001', learnerId: 'a0000000-0000-4000-8000-000000000001',
  learnerName: 'Nguyễn <Văn> A', learnerEmail: 'learner1@example.test', courseName: 'Khóa học A',
  assignmentTitle: 'Bài tập 1', feedbackText: 'Tốt lắm!\nCần bổ sung ví dụ.', feedbackByName: 'Giảng viên B',
  feedbackByEmail: 'teacher@example.test', score: 8.5, ...extra,
});
const SMTP_LOOKUP = /FROM tenant_smtp_configs/;
const DIGEST_LOOKUP = /AND html_body LIKE/;
const CUSTOM_TEMPLATE = {
  tenant_id: TENANT, template_key: 'assignment_feedback', subject_template: 'Phản hồi: {{assignment_title}}',
  preheader_template: 'Xem phản hồi', body_template: 'Chào {{learner_name}},\n{{feedback_text}}', is_enabled: true,
  updated_at: '2026-10-01T00:00:00.000Z',
};

add('feedback with owner digest', c => outbox.enqueueFeedbackEmails(c, feedback()), noRowsWhen(DIGEST_LOOKUP));
add('feedback joins a pending owner digest', c => outbox.enqueueFeedbackEmails(c, feedback({ score: null })));
add('feedback without SMTP', c => outbox.enqueueFeedbackEmails(c, feedback()), noRowsWhen(SMTP_LOOKUP));
add('feedback no learner email no copy', c => outbox.enqueueFeedbackEmails(c, feedback({ learnerEmail: ' ' })), rowsWhen(SMTP_LOOKUP, [{ ...ROW, copy_to_sender: false }]));
add('feedback copy to set email', c => outbox.enqueueFeedbackEmails(c, feedback({ feedbackByEmail: null })), both(rowsWhen(SMTP_LOOKUP, [{ ...ROW, copy_to_email: ' copy@example.test ' }]), noRowsWhen(DIGEST_LOOKUP)));
add('feedback tenant template', c => outbox.enqueueFeedbackEmails(c, feedback()), both(rowsWhen(TEMPLATE_LOOKUP, [CUSTOM_TEMPLATE]), noRowsWhen(DIGEST_LOOKUP)));
add('feedback no learner domain', c => outbox.enqueueFeedbackEmails(c, feedback()), both(rowsWhen(/FROM tenants/, [{ name: '', domain_learner: null }]), noRowsWhen(DIGEST_LOOKUP)));

const assignment = (extra: Record<string, unknown> = {}) => ({
  tenantId: TENANT, notificationId: NOTIFICATION, courseId: COURSE, courseName: 'Khóa học A', assignmentTitle: 'Bài tập 1',
  assignmentQuestion: 'Câu hỏi <b>1</b>?', deadlineEnabled: true, deadlineAt: '2026-11-01T10:00:00.000Z',
  deadlineMode: 'absolute' as const, assignmentCreatedAt: '2026-10-12T00:00:00.000Z', submissionUnlockMode: 'after_content_complete' as const,
  ...extra,
});
const twoLearners = rowsWhen(/FROM notification_recipients nr\s+JOIN users u ON u.id = nr.user_id\s+LEFT JOIN enrollments/, [
  { user_id: 'u-1', email: 'learner1@example.test', name: 'Học viên 1', enrolled_at: '2026-10-01T00:00:00.000Z' },
  { user_id: 'u-2', email: ' learner2@example.test ', name: '', enrolled_at: null },
]);
add('assignment created absolute deadline', c => outbox.enqueueAssignmentCreatedEmails(c, assignment()), twoLearners);
add('assignment created relative deadline', c =>
  outbox.enqueueAssignmentCreatedEmails(c, assignment({ deadlineMode: 'relative_to_enrollment', deadlineAfterDays: 3, deadlineAt: null })),
  twoLearners,
);
add('assignment created no deadline anytime', c =>
  outbox.enqueueAssignmentCreatedEmails(c, assignment({ deadlineEnabled: false, deadlineMode: 'none', submissionUnlockMode: 'anytime' })),
);
add('assignment created no recipients', c => outbox.enqueueAssignmentCreatedEmails(c, assignment()), noRowsWhen(/FROM notification_recipients/));
add('assignment created no owner copy', c => outbox.enqueueAssignmentCreatedEmails(c, assignment()), rowsWhen(SMTP_LOOKUP, [{ ...ROW, copy_to_sender: false }]));
add('assignment created without SMTP', c => outbox.enqueueAssignmentCreatedEmails(c, assignment()), noRowsWhen(SMTP_LOOKUP));

const team = (extra: Record<string, unknown> = {}) => ({
  tenantId: TENANT, notificationId: NOTIFICATION, orgGroupName: 'Khối A', subGroupName: 'Phòng B', teamName: 'Nhóm <C>',
  courseCategories: [{ name: 'An toàn', courseCount: 2 }, { name: 'Kỹ năng', courseCount: 1 }], ...extra,
});
add('team member added', c => outbox.enqueueTeamMemberAddedEmails(c, team()));
add('team member added custom labels no courses', c =>
  outbox.enqueueTeamMemberAddedEmails(c, team({ courseCategories: [], groupLabels: { team: 'Tổ', org_group: 'Ban', sub_group: 'Bộ phận' } })),
);
add('team member added no recipients', c => outbox.enqueueTeamMemberAddedEmails(c, team()), noRowsWhen(/FROM notification_recipients/));
add('team member added without SMTP', c => outbox.enqueueTeamMemberAddedEmails(c, team()), noRowsWhen(SMTP_LOOKUP));
add('course notification job', c => outbox.enqueueCourseNotificationEmailJob(c, { tenantId: TENANT, notificationId: NOTIFICATION, courseId: COURSE }));
add('course notification job exists', c =>
  outbox.enqueueCourseNotificationEmailJob(c, { tenantId: TENANT, notificationId: NOTIFICATION, courseId: COURSE }),
  rowsWhen(/INSERT INTO notification_email_jobs/, []),
);

// Fan-out: a claimed job renders one batch of recipients.
const FANOUT_CLAIM = /UPDATE notification_email_jobs nej\s+SET status = 'running'/;
const STALE_FANOUT = /WHERE status = 'running'\s+AND updated_at </;
const fanoutJob = rowsWhen(FANOUT_CLAIM, [{ id: 'job-1' }]);
const noStale = noRowsWhen(STALE_FANOUT);
const recipients = rowsWhen(/SELECT nr\.id AS recipient_id/, [
  { recipient_id: 'r-1', user_id: 'u-1', email: 'learner1@example.test', name: 'Học viên 1', enrolled_at: '2026-10-01T00:00:00.000Z' },
  { recipient_id: 'r-2', user_id: 'u-2', email: 'learner2@example.test', name: 'Học viên 2', enrolled_at: null },
]);
add('fan-out none due', () => outbox.processCourseNotificationEmailFanoutBatch(), both(noRowsWhen(FANOUT_CLAIM), noStale));
add('fan-out assignment batch', () => outbox.processCourseNotificationEmailFanoutBatch(undefined, 2, 2), both(fanoutJob, noStale, recipients));
add('fan-out assignment batch done', () => outbox.processCourseNotificationEmailFanoutBatch(undefined, 2, 5), both(fanoutJob, noStale, recipients));
add('fan-out assignment second batch', () =>
  outbox.processCourseNotificationEmailFanoutBatch(undefined, 1, 2),
  both(fanoutJob, rowsWhen(/FROM notification_email_jobs\s+WHERE id = \$1::uuid\s+FOR UPDATE/, [{ ...ROW, last_recipient_id: 'r-0' }]), recipients),
);
add('fan-out course notice', () =>
  outbox.processCourseNotificationEmailFanoutBatch(TENANT),
  both(fanoutJob, noStale, recipients, rowsWhen(/FROM notifications n/, [{ ...ROW, type: 'course_notice', metadata: null }])),
);
add('fan-out stale job reclaimed', () => outbox.processCourseNotificationEmailFanoutBatch(TENANT, 2), both(noRowsWhen(FANOUT_CLAIM), rowsWhen(STALE_FANOUT, [{ id: 'job-2' }]), recipients));
add('fan-out job gone', () => outbox.processCourseNotificationEmailFanoutBatch(), both(fanoutJob, noStale, noRowsWhen(/FROM notification_email_jobs\s+WHERE id = \$1::uuid/)));
add('fan-out course deleted', () => outbox.processCourseNotificationEmailFanoutBatch(), both(fanoutJob, noStale, noRowsWhen(/FOR KEY SHARE/)));
add('fan-out notification gone', () => outbox.processCourseNotificationEmailFanoutBatch(), both(fanoutJob, noStale, noRowsWhen(/FROM notifications n/)));
add('fan-out no more recipients', () => outbox.processCourseNotificationEmailFanoutBatch(), both(fanoutJob, noStale, noRowsWhen(/SELECT nr\.id AS recipient_id/)));
add('fan-out insert fails', () => outbox.processCourseNotificationEmailFanoutBatch(), (text, index) => {
  if (/INSERT INTO email_outbox/.test(text)) throw new Error('insert failed');
  return both(fanoutJob, noStale, recipients)(text, index);
});

// ── Runner ──

function digest(outcome: unknown): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

const golden: Record<string, string> = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>)
  : {};
const written: Record<string, string> = {};
const full: Record<string, unknown> = {};

test('the case names are unique', () => {
  assert.equal(new Set(cases.map(item => item.name)).size, cases.length);
});

for (const item of cases) {
  test(`email outbox enqueue characterization: ${item.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const { statements, client } = installDb(t, item.answer);
    let result: unknown;
    try {
      result = plain(await item.run(client));
    } catch (error) {
      result = { thrown: (error as Error).name, message: (error as Error).message };
    }
    const outcome = {
      statements: statements.map(s => ({ sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      result,
    };
    const value = digest(outcome);
    if (FULL_OUT) full[item.name] = outcome;
    if (WRITE_GOLDEN) {
      written[item.name] = value;
      return;
    }
    assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
    assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
  });
}

test('every golden entry still has its case', () => {
  if (FULL_OUT) writeFileSync(FULL_OUT, `${JSON.stringify(full, null, 1)}\n`);
  if (WRITE_GOLDEN) {
    const sorted = Object.fromEntries(Object.keys(written).sort().map(name => [name, written[name]]));
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
});
