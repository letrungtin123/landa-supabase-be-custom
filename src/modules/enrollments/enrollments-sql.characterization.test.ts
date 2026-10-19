import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/staff-sql-characterization.js';

// Characterization of the enrollment routes (/api/enrollments): every SQL
// statement and the answer of every enrollments handler, over a matrix of
// bodies, queries and empty results (src/test-support/staff-sql-characterization.ts).
// The golden file was written by the code before the enrollments repository
// existed; moving SQL into repositories must keep every entry equal. Rewrite
// it only for an intended change:
//   ENROLLMENTS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/enrollments/enrollments-sql.characterization.test.ts
// ENROLLMENTS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./enrollments.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const LEARNER = 'a0000000-0000-4000-8000-000000000002';
const LEARNER_2 = 'a0000000-0000-4000-8000-000000000003';
const ENROLLMENT = 'e0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+C1+2026';

/** One row with every column an enrollments statement reads. */
const ROW = {
  id: ENROLLMENT, user_id: LEARNER, course_id: COURSE, tenant_id: TENANT, enrolled_at: '2026-02-01T00:00:00.000Z',
  is_active: true, progress: 40, is_completed: false, completed_at: null, last_activity_at: '2026-03-01T00:00:00.000Z',
  course_name: 'Khóa học A', course_image: 'img.png', username: 'learner01', email: 'l@example.test',
  full_name: 'Học viên', avatar_url: null, display_name: 'Khóa học A', count: '2', inserted_count: 1,
  reactivated_count: 1, synced: '2', date: '2026-10-13', minutes: '15', exists: false, deleted_at: null,
};

/** Every case: the learner is not the tenant's demo iframe learner unless the case says so. */
const NOT_DEMO = noRowsWhen(/tenant_demo_iframe_settings/);
const DEMO = rowsWhen(/tenant_demo_iframe_settings/, [{ exists: true, demo_user_id: LEARNER }]);

interface CallOptions {
  role?: string;
  sessionMode?: string;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: { id: USER, tenantId: TENANT, role: options.role ?? 'staff', username: 'staff01', sessionMode: options.sessionMode ?? 'normal' },
    query: options.query ?? {},
    params: { userId: LEARNER, courseId: COURSE, ...options.params },
    body: 'body' in options ? options.body : {},
    originalUrl: '/api/enrollments',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) =>
  cases.push({ name, run, answer: answer ? answers(answer, NOT_DEMO) : NOT_DEMO });

const H = ctrl;

// ── Enroll ──
const notEnrolled = noRowsWhen(/SELECT id, is_active FROM enrollments/);
add('enroll', () => call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }), notEnrolled);
add('enroll already active', () => call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }));
add('enroll reactivates', () =>
  call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }),
  rowsWhen(/SELECT id, is_active FROM enrollments/, [{ id: ENROLLMENT, is_active: false }]),
);
add('enroll not a learner', () =>
  call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }),
  noRowsWhen(/AND u.role IN \('learner', 'learner_plus'\)/),
);
add('enroll demo learner', () => call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }), DEMO);
add('enroll missing course', () =>
  call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }),
  answers(notEnrolled, noRowsWhen(/FROM courses/)),
);
add('enroll no audit context', () =>
  call(H.enroll, { body: { user_id: LEARNER, course_id: COURSE } }),
  answers(notEnrolled, noRowsWhen(/JOIN courses c ON c.id = \$2/)),
);
add('enroll bad user id', () => call(H.enroll, { body: { user_id: 'x', course_id: COURSE } }));
add('enroll no user', () => call(H.enroll, { body: { course_id: COURSE } }));
add('enroll no course', () => call(H.enroll, { body: { user_id: LEARNER } }));
add('enroll no body', () => call(H.enroll, { body: undefined }));
add('bulk enroll', () => call(H.enroll, { body: { user_ids: [LEARNER, LEARNER_2, LEARNER], course_id: COURSE } }));
add('bulk enroll nothing new', () =>
  call(H.enroll, { body: { user_ids: [LEARNER], course_id: COURSE } }),
  rowsWhen(/AS inserted_count/, [{ inserted_count: 0, reactivated_count: 0 }]),
);
add('bulk enroll no row', () => call(H.enroll, { body: { user_ids: [LEARNER], course_id: COURSE } }), noRowsWhen(/AS inserted_count/));
add('bulk enroll demo learner', () =>
  call(H.enroll, { body: { user_ids: [LEARNER], course_id: COURSE } }),
  rowsWhen(/tenant_demo_iframe_settings/, [{ demo_user_id: LEARNER }]),
);
add('bulk enroll missing course', () =>
  call(H.enroll, { body: { user_ids: [LEARNER], course_id: COURSE } }),
  noRowsWhen(/FROM courses/),
);
add('bulk enroll invalid', () => call(H.enroll, { body: { user_ids: ['x'], course_id: COURSE } }));
add('bulk enroll empty list', () => call(H.enroll, { body: { user_ids: [], user_id: LEARNER, course_id: COURSE } }), notEnrolled);

// ── Unenroll, progress ──
add('unenroll', () => call(H.unenroll, { body: { user_id: LEARNER, course_id: COURSE } }));
add('unenroll not enrolled', () =>
  call(H.unenroll, { body: { user_id: LEARNER, course_id: COURSE } }),
  noRowsWhen(/UPDATE enrollments\s+SET is_active = false/),
);
add('unenroll demo learner', () => call(H.unenroll, { body: { user_id: LEARNER, course_id: COURSE } }), DEMO);
add('unenroll missing fields', () => call(H.unenroll, { body: { user_id: LEARNER } }));
add('progress', () => call(H.updateProgress, { body: { user_id: LEARNER, course_id: COURSE, progress: 60 } }));
add('progress complete', () => call(H.updateProgress, { body: { user_id: LEARNER, course_id: COURSE, progress: 140 } }));
add('progress negative', () => call(H.updateProgress, { body: { user_id: LEARNER, course_id: COURSE, progress: -5 } }));
add('progress not enrolled', () =>
  call(H.updateProgress, { body: { user_id: LEARNER, course_id: COURSE, progress: 60 } }),
  noRowsWhen(/course_progress cp/),
);
add('progress demo learner', () => call(H.updateProgress, { body: { user_id: LEARNER, course_id: COURSE, progress: 60 } }), DEMO);
add('progress missing fields', () => call(H.updateProgress, { body: { user_id: LEARNER, course_id: COURSE } }));

// ── Study time ──
add('study session', () =>
  call(H.recordStudySession, { body: { course_id: COURSE, duration_minutes: 25, started_at: '2026-10-18T20:00:00.000Z' } }),
);
add('study session now no course', () => call(H.recordStudySession, { body: { duration_minutes: 5 } }));
add('study session no duration', () => call(H.recordStudySession, { body: { course_id: COURSE } }));
add('study session demo session', () => call(H.recordStudySession, { sessionMode: 'demo_iframe', body: { entries: [] } }));
add('study session demo session single', () => call(H.recordStudySession, { sessionMode: 'demo_iframe', body: { duration_minutes: 5 } }));
add('study session demo learner', () => call(H.recordStudySession, { body: { duration_minutes: 5 } }), DEMO);
add('study entries', () =>
  call(H.recordStudySession, {
    body: {
      entries: [
        { date: '2026-10-17', minutes: 30.6, course_id: COURSE },
        { date: '2026-10-18', minutes: 2000 },
        { date: '2026-10-16', minutes: 0 },
      ],
    },
  }),
);
add('study entries none positive', () => call(H.recordStudySession, { body: { entries: [{ date: '2026-10-17', minutes: 0 }] } }));
add('study entries bad date', () => call(H.recordStudySession, { body: { entries: [{ date: '17/10/2026', minutes: 5 }] } }));
add('study entries too many', () => call(H.recordStudySession, { body: { entries: Array.from({ length: 371 }, () => ({})) } }));
add('study entries no row', () => call(H.recordStudySession, { body: { entries: [{ date: '2026-10-17', minutes: 5 }] } }), noRowsWhen(/AS synced/));
add('weekly study time', () => call(H.getWeeklyStudyTime));
add('study time days', () => call(H.getWeeklyStudyTime, { query: { from: '2026-10-01', to: '2026-10-07' } }));
add('study time one day', () => call(H.getWeeklyStudyTime, { query: { from: '2026-10-01' } }));
add('study time months', () => call(H.getWeeklyStudyTime, { query: { from: '2026-01-01', to: '2026-10-31', granularity: 'month' } }));
add('study time years', () => call(H.getWeeklyStudyTime, { query: { from: '2020-01-01', to: '2026-10-31', granularity: 'year' } }));
add('study time long range', () => call(H.getWeeklyStudyTime, { query: { from: '2010-01-01', to: '2026-10-31' } }));
add('study time very long range', () => call(H.getWeeklyStudyTime, { query: { from: '1990-01-01', to: '2026-10-31', granularity: 'month' } }));
add('study time bad granularity', () => call(H.getWeeklyStudyTime, { query: { granularity: 'week' } }));
add('study time bad date', () => call(H.getWeeklyStudyTime, { query: { from: '2026-02-30' } }));
add('study time reversed', () => call(H.getWeeklyStudyTime, { query: { from: '2026-10-07', to: '2026-10-01' } }));
add('study time no rows', () => call(H.getWeeklyStudyTime), text => (/study_sessions/.test(text) ? { rows: [] } : undefined));

// ── Lists ──
add('user enrollments', () => call(H.getUserEnrollments));
add('user enrollments search', () => call(H.getUserEnrollments, { query: { search: 'Excel', page: '2', page_size: '500' } }));
add('user enrollments odd query', () => call(H.getUserEnrollments, { query: { page: 'x', page_size: '0', search: ['a'] } }));
add('user enrollments empty', () => call(H.getUserEnrollments), text => (/COUNT\(\*\)/.test(text) ? { rows: [] } : { rows: [] }));
add('course enrollments', () => call(H.getCourseEnrollments));
add('course enrollments search completed', () =>
  call(H.getCourseEnrollments, { query: { search: 'an', status: 'completed', page: '3', page_size: '7' } }),
);
add('course enrollments learning', () => call(H.getCourseEnrollments, { query: { status: 'learning' } }));
add('course enrollments not started', () => call(H.getCourseEnrollments, { query: { status: 'not_started', search: '' } }));
add('course enrollments odd status', () => call(H.getCourseEnrollments, { query: { status: 'other', page_size: '1000' } }));
add('course enrollments empty', () => call(H.getCourseEnrollments), () => ({ rows: [] }));

runCharacterization({
  label: 'enrollments characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'enrollments-sql.characterization.golden.json'),
  writeGolden: process.env.ENROLLMENTS_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.ENROLLMENTS_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER, LEARNER, LEARNER_2, ENROLLMENT],
});
