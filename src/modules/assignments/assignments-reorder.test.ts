import assert from 'node:assert/strict';
import test from 'node:test';
import { callHandler, installDb, noRowsWhen, answers, rowsWhen } from '../../test-support/staff-sql-characterization.js';

// POST /api/assignments/courses/:courseId/reorder answers the course's
// assignments in their new order as an array, like GET
// /api/assignments/courses/:courseId: the dashboard's reorderCourseAssignments
// reads `data` as CourseAssignment[]. It used to spread the array into an
// object ({ 0: ..., 1: ..., course_name }). pg double; no database, no Redis,
// no network.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./assignments.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT = 'b0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_2 = 'b0000000-0000-4000-8000-000000000002';
const COURSE = 'course-v1:Landa+C1+2026';

const ROW = {
  id: ASSIGNMENT,
  tenant_id: TENANT,
  course_id: COURSE,
  title: 'Bài tập 1',
  question: 'Câu hỏi',
  sort_order: 0,
  allow_resubmission: true,
  deadline_enabled: false,
  deadline_at: null,
  deadline_mode: 'relative_to_enrollment',
  deadline_after_days: 7,
  attachment_file: null,
  grading_enabled: true,
  submission_unlock_mode: 'anytime',
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-02T00:00:00.000Z',
  submitted_count: 0,
  feedback_count: 0,
  display_name: 'Khóa học A',
  is_published: true,
  exists: false,
};

test('reorder answers the reordered assignments as an array', async t => {
  t.mock.method(console, 'log', () => undefined);
  const statements = installDb(
    t,
    pool,
    ROW,
    answers(
      noRowsWhen(/tenant_demo_iframe_settings/),
      rowsWhen(/SELECT id\s+FROM course_assignments\s+WHERE tenant_id = \$1 AND course_id = \$2/, [
        { id: ASSIGNMENT },
        { id: ASSIGNMENT_2 },
      ]),
      rowsWhen(/ORDER BY ca\.sort_order/, [
        { ...ROW, id: ASSIGNMENT_2, sort_order: 0 },
        { ...ROW, id: ASSIGNMENT, sort_order: 1 },
      ]),
    ),
  );

  const outcome = (await callHandler(ctrl.reorderAssignments, {
    user: { id: USER, tenantId: TENANT, role: 'staff', username: 'staff01', sessionMode: 'normal' },
    params: { courseId: COURSE },
    query: {},
    body: { assignment_ids: [ASSIGNMENT_2, ASSIGNMENT] },
    originalUrl: `/api/assignments/courses/${COURSE}/reorder`,
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  })) as { status: number; body: { success: boolean; data: unknown } };

  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.success, true);
  assert.ok(Array.isArray(outcome.body.data), 'data is an array');
  const data = outcome.body.data as Array<{ id: string; sort_order: number }>;
  assert.deepEqual(
    data.map(item => [item.id, item.sort_order]),
    [
      [ASSIGNMENT_2, 0],
      [ASSIGNMENT, 1],
    ],
  );
  assert.ok(statements.some(statement => /UPDATE course_assignments/.test(statement.text)));
});
