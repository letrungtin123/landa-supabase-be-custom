import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  failWhen,
  installFetchRecorder,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
  type CallOptions,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the prompt template (mascot) routes
// (/api/prompt-templates) and of getActiveLessonAuthorTemplate: every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client, client releases), every Storage request (fetch double)
// and the answer of every handler. The golden file was written by the code
// before the prompt template repository existed; moving SQL into
// repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, or an error, per case). Rewrite the golden file only for
// an intended change:
//   PROMPT_TEMPLATES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/prompt-templates/prompt-templates-sql.characterization.test.ts
// PROMPT_TEMPLATES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
installFetchRecorder(storageRequests, { Key: 'landa-storage/k', name: 'landa-storage', id: 'landa-storage' });

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./prompt-templates.controller.js');
const service = await import('./prompt-templates.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const USER = 'a0000000-0000-4000-8000-000000000001';
const TEMPLATE = 'c0000000-0000-4000-8000-000000000001';

/** One row with every column a prompt template statement reads. */
const ROW = {
  id: TEMPLATE,
  name: 'Mascot A',
  description: 'Vui vẻ',
  prompt: 'Bạn là trợ lý.',
  voice_prompt: null,
  avatar_url: 'system/prompt-mascots/avatars/old.png',
  fullbody_url: 'system/prompt-mascots/fullbody/old.png',
  is_active: false,
  is_lesson_author: false,
  sort_order: 2,
  created_by: USER,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  cnt: '3',
  full_name: 'Quản Trị',
  email: 'root@a.test',
};

const ROOT = { id: USER, tenantId: null, role: 'superadmin', username: 'root', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/prompt-templates', params: { id: TEMPLATE }, ...options }, ROOT);
const H = ctrl;
const FULL = rowsWhen(/AS cnt/, [{ cnt: '6' }]);
const ACTIVE = rowsWhen(/SELECT \* FROM system_prompt_templates WHERE id = \$1$/, [{ ...ROW, is_active: true }]);
const LESSON_AUTHOR = rowsWhen(/SELECT \* FROM system_prompt_templates WHERE id = \$1$/, [{ ...ROW, is_lesson_author: true }]);
const image = (extra: Record<string, unknown> = {}) => ({
  originalname: 'Mascot.png',
  mimetype: 'image/png',
  size: 3,
  buffer: Buffer.from('png'),
  ...extra,
});

// ── Reads ──
add('list', () => call(H.listTemplates));
add('list empty', () => call(H.listTemplates), text => (/AS cnt/.test(text) ? { rows: [] } : { rows: [] }));
add('active', () => call(H.listActiveTemplates));
add('get', () => call(H.getTemplate));
add('get missing', () => call(H.getTemplate), noRowsWhen(/FROM system_prompt_templates/));
add('lesson author template', () => service.getActiveLessonAuthorTemplate());
add('lesson author template none', () => service.getActiveLessonAuthorTemplate(), noRowsWhen(/is_lesson_author = true/));
add('default images', async () => [service.getDefaultAvatar('mascot', 7), service.getDefaultFullbody('', 2)]);

// ── Create ──
add('create', () => call(H.createTemplate, { method: 'POST', body: { name: 'Mascot B', prompt: 'P', voice_prompt: '  giọng  ', sort_order: 4 } }));
add('create active', () => call(H.createTemplate, { method: 'POST', body: { name: 'Mascot B', prompt: 'P', is_active: true } }));
add('create active full', () => call(H.createTemplate, { method: 'POST', body: { name: 'B', prompt: 'P', is_active: true } }), FULL);
add('create lesson author', () =>
  call(H.createTemplate, { method: 'POST', body: { name: 'Chuyên gia', prompt: 'P', is_active: true, is_lesson_author: true } }),
);
add('create lesson author vanished', () =>
  call(H.createTemplate, { method: 'POST', body: { name: 'Chuyên gia', prompt: 'P', is_lesson_author: true } }),
  noRowsWhen(/FOR UPDATE/),
);
add('create invalid', () => call(H.createTemplate, { method: 'POST', body: { name: '', prompt: '' } }));
add('create fails', () =>
  call(H.createTemplate, { method: 'POST', body: { name: 'B', prompt: 'P' } }),
  failWhen(/INSERT INTO system_prompt_templates/, { code: '23505', message: 'duplicate' }),
);

// ── Update ──
add('update fields', () =>
  call(H.updateTemplate, { method: 'PUT', body: { name: 'Mới', description: 'D', prompt: 'P2', voice_prompt: ' ', sort_order: 1 } }),
);
add('update voice cleared', () => call(H.updateTemplate, { method: 'PUT', body: { voice_prompt: null } }));
add('update nothing', () => call(H.updateTemplate, { method: 'PUT', body: {} }));
add('update activate', () => call(H.updateTemplate, { method: 'PUT', body: { is_active: true } }));
add('update activate full', () => call(H.updateTemplate, { method: 'PUT', body: { is_active: true } }), FULL);
add('update activate already active', () => call(H.updateTemplate, { method: 'PUT', body: { is_active: true } }), answers(ACTIVE, FULL));
add('update activate lesson author', () => call(H.updateTemplate, { method: 'PUT', body: { is_active: true } }), LESSON_AUTHOR);
add('update activate and make lesson author', () => call(H.updateTemplate, { method: 'PUT', body: { is_active: true, is_lesson_author: true } }));
add('update deactivate', () => call(H.updateTemplate, { method: 'PUT', body: { is_active: false } }), ACTIVE);
add('update make lesson author', () => call(H.updateTemplate, { method: 'PUT', body: { is_lesson_author: true } }));
add('update unset lesson author', () => call(H.updateTemplate, { method: 'PUT', body: { is_lesson_author: false, name: 'x' } }), LESSON_AUTHOR);
add('update missing', () => call(H.updateTemplate, { method: 'PUT', body: { name: 'x' } }), noRowsWhen(/FROM system_prompt_templates/));
add('update invalid', () => call(H.updateTemplate, { method: 'PUT', body: { sort_order: -1 } }));

// ── Delete ──
add('delete', () => call(H.deleteTemplate, { method: 'DELETE' }));
add('delete no images', () =>
  call(H.deleteTemplate, { method: 'DELETE' }),
  rowsWhen(/SELECT avatar_url, fullbody_url/, [{ avatar_url: null, fullbody_url: null }]),
);
add('delete missing', () => call(H.deleteTemplate, { method: 'DELETE' }), noRowsWhen(/FROM system_prompt_templates WHERE id = \$1$/));
add('delete vanished', () => call(H.deleteTemplate, { method: 'DELETE' }), noRowsWhen(/FOR UPDATE/));

// ── Images ──
for (const kind of ['avatar', 'fullbody'] as const) {
  const handler = kind === 'avatar' ? H.uploadAvatar : H.uploadFullbody;
  add(`${kind} upload`, () => call(handler, { method: 'POST', file: image() }));
  add(`${kind} upload first`, () =>
    call(handler, { method: 'POST', file: image() }),
    rowsWhen(/FOR UPDATE/, [{ avatar_url: null, fullbody_url: null }]),
  );
  add(`${kind} upload missing`, () => call(handler, { method: 'POST', file: image() }), noRowsWhen(/FOR UPDATE/));
  add(`${kind} upload not saved`, () => call(handler, { method: 'POST', file: image() }), noRowsWhen(/^UPDATE system_prompt_templates/));
  add(`${kind} upload wrong type`, () => call(handler, { method: 'POST', file: image({ mimetype: 'image/svg+xml' }) }));
  add(`${kind} upload too big`, () => call(handler, { method: 'POST', file: image({ size: 6 * 1024 * 1024 }) }));
  add(`${kind} upload no file`, () => call(handler, { method: 'POST' }));
}

registerCharacterization({
  title: 'prompt templates characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt-templates-sql.characterization.golden.json'),
  writeEnv: 'PROMPT_TEMPLATES_SQL_GOLDEN_WRITE',
  fullOutEnv: 'PROMPT_TEMPLATES_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [USER, TEMPLATE],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: storageRequests,
});
