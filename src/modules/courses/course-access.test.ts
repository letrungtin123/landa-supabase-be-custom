import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseAccessRepository } from './course-access.repository.js';

// The shared "course belongs to tenant" check: a course of another tenant, a
// deleted course and a missing course all answer "no", and each endpoint keeps
// its own 404 message.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const COURSE_A = 'course-v1:A+1+2026';
const DELETED_A = 'course-v1:A+2+2026';
const courses = new Map([[COURSE_A, { tenant: TENANT_A, deleted: false }], [DELETED_A, { tenant: TENANT_A, deleted: true }]]);

function fakeDb() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const course = courses.get(String(values[0]));
      const live = /deleted_at IS NULL/.test(text);
      const ok = !!course && course.tenant === values[1] && (!live || !course.deleted);
      return { rows: ok ? [{ id: values[0] }] : [] };
    },
  };
}

test('only a live course of the caller tenant belongs to it', async () => {
  const db = fakeDb();
  const access = createCourseAccessRepository(db);
  assert.equal(await access.courseBelongsToTenant(COURSE_A, TENANT_A), true);
  assert.equal(await access.courseBelongsToTenant(COURSE_A, TENANT_B), false, 'another tenant');
  assert.equal(await access.courseBelongsToTenant(DELETED_A, TENANT_A), false, 'soft-deleted');
  assert.equal(await access.courseBelongsToTenant('course-v1:missing', TENANT_A), false, 'missing');
  for (const call of db.calls) {
    assert.equal(call.text, 'SELECT id FROM courses WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL');
  }
});

test('the transactional form locks the course row on the caller client', async () => {
  const db = fakeDb();
  const access = createCourseAccessRepository(db);
  assert.equal(await access.lockCourseOfTenant(COURSE_A, TENANT_A), true);
  assert.equal(await access.lockCourseOfTenant(COURSE_A, TENANT_B), false);
  assert.equal(await access.lockCourseOfTenant(DELETED_A, TENANT_A), false);
  assert.deepEqual(db.calls[0], {
    text: 'SELECT id FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
    values: [COURSE_A, TENANT_A],
  });
});

test('the guard answers 404 with the endpoint message, for another tenant as for a missing course', async (t) => {
  const pg = await import('pg');
  const db = fakeDb();
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, values: unknown[] = []) => {
    const result = await db.query(text, values);
    return { ...result, rowCount: result.rows.length };
  });
  const { assertCourseBelongsToTenant } = await import('./course-access.service.js');
  await assertCourseBelongsToTenant(COURSE_A, TENANT_A, 'Course not found');
  for (const [courseId, tenantId] of [[COURSE_A, TENANT_B], [DELETED_A, TENANT_A], ['course-v1:missing', TENANT_A]]) {
    await assert.rejects(assertCourseBelongsToTenant(courseId, tenantId, 'Course khong ton tai'),
      (error: { statusCode?: number; message?: string; code?: string }) =>
        error.statusCode === 404 && error.message === 'Course khong ton tai' && error.code === undefined);
  }
});
