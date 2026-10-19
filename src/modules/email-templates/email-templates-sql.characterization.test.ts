import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callHandler,
  failWhen,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
  type CallOptions,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the email template routes (/api/email-templates) and
// of the render and SMTP status reads other modules call: every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client) and the answer of every handler. The golden file was
// written by the code before the email template repository existed; moving
// SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, or an error, per case). Rewrite the golden file only for
// an intended change:
//   EMAIL_TEMPLATES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/email-templates/email-templates-sql.characterization.test.ts
// EMAIL_TEMPLATES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./email-templates.controller.js');
const service = await import('./email-templates.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';

/** One row with every column an email template statement reads. */
const ROW = {
  tenant_id: TENANT,
  template_key: 'course_notification',
  subject_template: 'Thông báo: {{course_name}}',
  preheader_template: 'Xin chào {{learner_name}}',
  body_template: 'Nội dung {{notification_message}}',
  is_enabled: true,
  updated_at: '2026-09-01T00:00:00.000Z',
  updated_by: USER,
  host: 'smtp.gmail.com',
  username: 'mailer@a.test',
  from_email: 'noreply@a.test',
  password_ciphertext: 'c',
  password_iv: 'i',
  password_auth_tag: 't',
  full_name: 'Quản Trị',
  email: 'admin@a.test',
};

const ADMIN = { id: USER, tenantId: TENANT, role: 'staff', username: 'admin01', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/email-templates', params: { key: 'course_notification' }, ...options }, ADMIN);
const H = ctrl;
const SMTP = /FROM tenant_smtp_configs/;
const BODY = {
  subject_template: '  Khóa {{course_name}}  mới ',
  preheader_template: 'Chào {{learner_name}}',
  body_template: 'Xin chào\r\n{{learner_name}} <b>x</b>',
};

add('list', () => call(H.list));
add('list no custom', () => call(H.list), noRowsWhen(/FROM tenant_email_templates/));
add('list no table', () => call(H.list), failWhen(/FROM tenant_email_templates/, { code: '42P01', message: 'no table' }));
add('list other error', () => call(H.list), failWhen(/FROM tenant_email_templates/, { code: '57014', message: 'canceled' }));
for (const [name, row] of [
  ['no smtp', null],
  ['smtp off', { ...ROW, is_enabled: false }],
  ['smtp no password', { ...ROW, password_iv: null }],
  ['smtp no sender', { ...ROW, from_email: ' ' }],
] as const) {
  add(`list ${name}`, () => call(H.list), rowsWhen(SMTP, row ? [row] : []));
}
add('update', () => call(H.update, { method: 'PUT', params: { key: 'assignment_created' }, body: { ...BODY, subject_template: 'Bài tập mới' } }));
add('update unknown variable', () => call(H.update, { method: 'PUT', body: { ...BODY, body_template: '{{password}}' } }));
add('update html subject', () => call(H.update, { method: 'PUT', body: { ...BODY, subject_template: '<b>x</b>' } }));
add('update empty body', () => call(H.update, { method: 'PUT', body: { ...BODY, body_template: '  ' } }));
add('update no body', () => call(H.update, { method: 'PUT', body: undefined }));
add('update unknown key', () => call(H.update, { method: 'PUT', params: { key: 'welcome' }, body: BODY }));
add('update smtp not ready', () => call(H.update, { method: 'PUT', body: BODY }), rowsWhen(SMTP, []));
add('reset', () => call(H.reset, { method: 'POST' }));
add('reset unknown key', () => call(H.reset, { method: 'POST', params: { key: 'x' } }));
add('reset smtp off', () => call(H.reset, { method: 'POST' }), rowsWhen(SMTP, [{ ...ROW, is_enabled: false }]));
add('preview input', () => call(H.preview, { method: 'POST', body: BODY }));
add('preview stored', () => call(H.preview, { method: 'POST', body: undefined }));
add('preview stored default', () => call(H.preview, { method: 'POST', body: undefined }), noRowsWhen(/FROM tenant_email_templates/));
add('preview empty body', () => call(H.preview, { method: 'POST', body: {} }));
add('render', () => service.getEmailTemplateForRender(TENANT, 'team_member_added'));
add('render default', () => service.getEmailTemplateForRender(TENANT, 'assignment_feedback'), noRowsWhen(/FROM tenant_email_templates/));
add('render no table', () => service.getEmailTemplateForRender(TENANT, 'course_notification'), failWhen(/FROM tenant_email_templates/, { code: '42P01', message: 'no table' }));
add('render in transaction', async () => {
  const client = await pool.connect();
  try {
    return await service.getEmailTemplateForRender(TENANT, 'course_notification', client);
  } finally {
    client.release();
  }
});
add('smtp status', () => service.getEmailTemplateSmtpStatus(TENANT));

registerCharacterization({
  title: 'email templates characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'email-templates-sql.characterization.golden.json'),
  writeEnv: 'EMAIL_TEMPLATES_SQL_GOLDEN_WRITE',
  fullOutEnv: 'EMAIL_TEMPLATES_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
});
