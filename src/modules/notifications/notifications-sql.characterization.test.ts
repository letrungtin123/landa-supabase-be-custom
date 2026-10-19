import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  failWhen,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the course notification routes (/api/notifications):
// every SQL statement and the answer of every handler (src/test-support/
// sql-characterization.ts). The golden file was written by the code before
// the notifications repository existed; moving SQL into repositories must
// keep every entry equal. Rewrite it only for an intended change:
//   NOTIFICATIONS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/notifications/notifications-sql.characterization.test.ts
// NOTIFICATIONS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./notifications.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const NOTIFICATION = 'e0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+C1+2026';

/** One row with every column a notifications statement reads. */
const ROW = {
  id: NOTIFICATION, tenant_id: TENANT, course_id: COURSE, type: 'course_manual_notification', title: 'Thông báo',
  message: 'Nội dung', sent_by: USER, recipient_count: 2, created_at: '2026-10-01T00:00:00.000Z', metadata: {},
  course_name: 'Khóa A', sent_by_username: 'Admin', sent_by_display_name: 'Admin', email_status: 'queued',
  email_queued_count: 2, email_last_error: null, count: '1', display_name: 'Khóa A', visible_to_staff_only: false,
  is_public: false, is_enabled: true, host: 'smtp.gmail.com', username: 'mailer@example.test',
  from_email: 'mailer@example.test', password_ciphertext: 'c', password_iv: 'i', password_auth_tag: 't',
  job_count: 1, inserted: 1,
};

interface CallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: { id: USER, tenantId: TENANT, role: 'staff', username: 'staff01', sessionMode: 'normal' },
    query: options.query ?? {},
    params: {},
    body: 'body' in options ? options.body : {},
    originalUrl: '/api/notifications',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const H = ctrl;
const SMTP = /FROM tenant_smtp_configs/;
const SEND = { course_id: COURSE, title: 'Thông báo', message: 'Nội dung' };

// ── SMTP status ──
add('smtp ready', () => call(H.smtpStatus));
add('smtp not configured', () => call(H.smtpStatus), noRowsWhen(SMTP));
add('smtp disabled', () => call(H.smtpStatus), rowsWhen(SMTP, [{ ...ROW, is_enabled: false }]));
add('smtp no password', () => call(H.smtpStatus), rowsWhen(SMTP, [{ ...ROW, password_iv: null }]));
add('smtp no sender', () => call(H.smtpStatus), rowsWhen(SMTP, [{ ...ROW, from_email: ' ', host: null }]));

// ── Send ──
add('send with email', () => call(H.send, { body: SEND }));
add('send without email', () => call(H.send, { body: { course_id: COURSE, title: 'T' } }), noRowsWhen(SMTP));
add('send public course', () =>
  call(H.send, { body: SEND }),
  rowsWhen(/SELECT display_name, visible_to_staff_only/, [{ display_name: 'Khóa A', visible_to_staff_only: false, is_public: true }]),
);
add('send no recipients', () => call(H.send, { body: SEND }), text => (/INSERT INTO notification_recipients/.test(text) ? { rows: [], rowCount: 0 } : undefined));
add('send hidden course', () =>
  call(H.send, { body: SEND }),
  rowsWhen(/SELECT display_name, visible_to_staff_only/, [{ display_name: 'Khóa A', visible_to_staff_only: true, is_public: false }]),
);
add('send missing course', () => call(H.send, { body: SEND }), noRowsWhen(/SELECT display_name, visible_to_staff_only/));
add('send write fails', () => call(H.send, { body: SEND }), answers(noRowsWhen(SMTP), failWhen(/INSERT INTO notification_recipients/, '40P01')));
add('send missing title', () => call(H.send, { body: { course_id: COURSE } }));
add('send no body', () => call(H.send, { body: undefined }));

// ── List ──
add('list', () => call(H.list));
add('list filtered', () => call(H.list, { query: { course_id: ` ${COURSE} `, search: 'Thông', page: '2', page_size: '5' } }));
add('list odd query', () => call(H.list, { query: { course_id: ['x'], search: ['a'], page: 'x', page_size: '1000' } }));
add('list blank course', () => call(H.list, { query: { course_id: '  ' } }));
add('list empty', () => call(H.list), text => (/COUNT\(\*\)/.test(text) ? { rows: [{ count: '0' }] } : { rows: [] }));

runCharacterization({
  label: 'notifications characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'notifications-sql.characterization.golden.json'),
  writeGolden: process.env.NOTIFICATIONS_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.NOTIFICATIONS_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER, NOTIFICATION],
});
