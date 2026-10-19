import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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

// Characterization of the branding routes (/api/branding) and the dashboard
// content routes (/api/dashboard-content): every SQL statement (text without
// whitespace differences, parameters, pool or transaction client, client
// releases), every Storage request (fetch double) and the answer of every
// handler. The golden file was written by the code before the branding
// repository existed; moving SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, or an error, per case). Rewrite the golden file only for
// an intended change:
//   BRANDING_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/branding/branding-sql.characterization.test.ts
// BRANDING_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
installFetchRecorder(storageRequests, { Key: 'landa-storage/k', name: 'landa-storage', id: 'landa-storage' });

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const branding = await import('./branding.controller.js');
const dashboard = await import('./dashboard-content.controller.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';

/** One row with every column a branding or dashboard statement reads. */
const ROW = {
  id: TENANT,
  name: 'Doanh nghiệp A',
  domain_admin: 'https://admin.a.test',
  domain_learner: 'https://learn.a.test:8443',
  settings: {
    branding: {
      white_logo: `${TENANT}/branding/white_logo_1.png`,
      header_logo: '',
      carousels: [`${TENANT}/branding/carousel_1_1.png`, `${TENANT}/branding/carousel_2_1.png`],
    },
    dashboard_content: {
      hero_badge: 'Mới',
      hero_title: 'Chào mừng',
      tips: [{ title: 'Học mỗi ngày', desc: 'Ẩn danh' }],
      explore_hero_badge: null,
      explore_hero_title: 'Khám phá',
    },
  },
  full_name: 'Quản Trị',
  email: 'admin@a.test',
  data_limit_bytes: null,
  database_used_bytes: '0',
  storage_used_bytes: '0',
  storage_reserved_bytes: '0',
  state: 'observing',
  size_bytes: '0',
  ready: false,
};

const ADMIN = { id: USER, tenantId: TENANT, role: 'staff', username: 'admin01', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/branding', ...options }, ADMIN);
const image = (extra: Record<string, unknown> = {}) => ({
  originalname: 'logo.png',
  mimetype: 'image/png',
  size: 4,
  buffer: Buffer.from('logo'),
  ...extra,
});
const NO_BRANDING = rowsWhen(/FROM tenants/, [{ ...ROW, settings: {} }]);

// ── Branding ──
add('by domain', () => call(branding.getByDomainController, { params: { domain: 'learn.a.test:8443' } }));
add('by domain with scheme', () => call(branding.getByDomainController, { params: { domain: 'https://Admin.A.test/' } }));
add('by domain unknown', () => call(branding.getByDomainController, { params: { domain: 'x.test' } }), noRowsWhen(/FROM tenants/));
add('by domain no branding', () => call(branding.getByDomainController, { params: { domain: 'a.test' } }), NO_BRANDING);
add('by domain empty', () => call(branding.getByDomainController, { params: { domain: '' } }));
add('by tenant', () => call(branding.getByTenantController));
add('by tenant no branding', () => call(branding.getByTenantController), rowsWhen(/FROM tenants/, [{ ...ROW, settings: null }]));
add('by tenant missing', () => call(branding.getByTenantController), noRowsWhen(/FROM tenants/));
add('by tenant no tenant', () => call(branding.getByTenantController, { user: { tenantId: null } }));
add('upload single', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' }, file: image() }));
add('upload single first', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'person_1' }, file: image({ originalname: 'noext' }) }));
add('upload carousel replace', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'carousel_2' }, file: image({ mimetype: 'image/webp', originalname: 'a.webp' }) }));
add('upload carousel new', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'carousel_5' }, file: image() }), NO_BRANDING);
add('upload bad key', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'favicon' }, file: image() }));
add('upload no file', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' } }));
add('upload too big', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' }, file: image({ size: 6 * 1024 * 1024 }) }));
add('upload wrong type', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' }, file: image({ mimetype: 'application/pdf' }) }));
add('upload tenant missing', () =>
  call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' }, file: image() }),
  noRowsWhen(/SELECT settings FROM tenants WHERE id = \$1 FOR UPDATE/),
);
add('upload write fails', () =>
  call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' }, file: image() }),
  failWhen(/^UPDATE tenants/, { code: '57014', message: 'canceled' }),
);
add('upload no tenant', () => call(branding.uploadController, { method: 'POST', body: { image_key: 'white_logo' }, file: image(), user: { tenantId: null } }));
add('delete single', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'white_logo' } }));
add('delete single empty', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'header_logo' } }));
add('delete carousel', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'carousel_1' } }));
add('delete carousel absent', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'carousel_9' } }));
add('delete any key', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'settings' } }));
add('delete missing tenant', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'white_logo' } }), noRowsWhen(/FOR UPDATE/));
add('delete no key', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: '' } }));
add('delete no tenant', () => call(branding.deleteController, { method: 'DELETE', params: { imageKey: 'white_logo' }, user: { tenantId: null } }));

// ── Dashboard content ──
add('dashboard by domain', () => call(dashboard.getByDomainController, { params: { domain: 'learn.a.test' } }));
add('dashboard by domain unknown', () => call(dashboard.getByDomainController, { params: { domain: 'x.test' } }), noRowsWhen(/FROM tenants/));
add('dashboard by domain no content', () => call(dashboard.getByDomainController, { params: { domain: 'a.test' } }), NO_BRANDING);
add('dashboard by domain empty', () => call(dashboard.getByDomainController, { params: { domain: '' } }));
add('dashboard by tenant', () => call(dashboard.getByTenantController));
add('dashboard by tenant no content', () => call(dashboard.getByTenantController), NO_BRANDING);
add('dashboard by tenant missing', () => call(dashboard.getByTenantController), noRowsWhen(/FROM tenants/));
add('dashboard by tenant no tenant', () => call(dashboard.getByTenantController, { user: { tenantId: null } }));
add('dashboard upsert', () =>
  call(dashboard.upsertController, {
    method: 'PUT',
    body: { hero_badge: ' Mới ', hero_title: 'Tiêu đề', tips: [{ title: 'A', desc: 'B' }], explore_hero_title: '  ' },
  }),
);
add('dashboard upsert empty', () => call(dashboard.upsertController, { method: 'PUT', body: {} }));
add('dashboard upsert invalid', () => call(dashboard.upsertController, { method: 'PUT', body: { tips: [{}, {}, {}] } }));
add('dashboard upsert missing tenant', () => call(dashboard.upsertController, { method: 'PUT', body: {} }), noRowsWhen(/SELECT id FROM tenants/));
add('dashboard upsert no tenant', () => call(dashboard.upsertController, { method: 'PUT', body: {}, user: { tenantId: null } }));

registerCharacterization({
  title: 'branding characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'branding-sql.characterization.golden.json'),
  writeEnv: 'BRANDING_SQL_GOLDEN_WRITE',
  fullOutEnv: 'BRANDING_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: storageRequests,
});
