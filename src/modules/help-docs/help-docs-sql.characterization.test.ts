import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  installFetchRecorder,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
  type CallOptions,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the help docs routes (/api/help-docs): every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client, client releases), every Storage request (fetch double)
// and the answer of every handler. The golden file was written by the code
// before the help docs repository existed; moving SQL into repositories must
// keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, per case). Rewrite the golden file only for an intended
// change:
//   HELP_DOCS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/help-docs/help-docs-sql.characterization.test.ts
// HELP_DOCS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
installFetchRecorder(storageRequests, { Key: 'landa-storage/k', name: 'landa-storage', id: 'landa-storage' });

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./help-docs.controller.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const FOLDER = 'f0000000-0000-4000-8000-000000000001';
const FOLDER_2 = 'f0000000-0000-4000-8000-000000000002';
const PAGE = 'b0000000-0000-4000-8000-000000000001';
const PAGE_2 = 'b0000000-0000-4000-8000-000000000002';
const IMG_A = `${TENANT}/help-docs/a.png`;
const IMG_B = `${TENANT}/help-docs/b.png`;

/** One row with every column a help docs statement reads. */
const ROW = {
  id: FOLDER,
  tenant_id: TENANT,
  title: 'Hướng dẫn',
  slug: 'huong-dan',
  icon: 'BookOpen',
  sort_order: 0,
  page_count: '2',
  count: 1,
  folder_id: FOLDER,
  folder_title: 'Hướng dẫn',
  content: `<p>x</p><img src="/api/storage/${encodeURIComponent(IMG_A)}"><img src='${IMG_B}'><img src=https://cdn.example.test/x.png>`,
  is_published: true,
  created_by: 'admin01',
  updated_by: 'admin01',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
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

const ADMIN = { id: USER, tenantId: TENANT, role: 'superadmin', username: 'admin01', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/help-docs', params: { id: PAGE }, ...options }, ADMIN);
const H = ctrl;
const STILL_USED = rowsWhen(/SELECT hp.content\s+FROM help_pages hp/, [{ content: `<img src="${IMG_A}">` }]);
const NONE_USED = rowsWhen(/SELECT hp.content\s+FROM help_pages hp/, []);

// ── Folders ──
add('folders', () => call(H.listFoldersController));
add('folders empty', () => call(H.listFoldersController), noRowsWhen(/FROM help_folders hf/));
add('folders no tenant', () => call(H.listFoldersController, { user: { tenantId: null } }));
add('folder create', () => call(H.createFolderController, { method: 'POST', body: { title: 'Bắt đầu Nhanh 2026!', icon: 'Star' } }));
add('folder create default icon', () => call(H.createFolderController, { method: 'POST', body: { title: 'FAQ' } }));
add('folder create no title', () => call(H.createFolderController, { method: 'POST', body: {} }));
add('folder update title', () => call(H.updateFolderController, { method: 'PATCH', params: { id: FOLDER }, body: { title: 'Mới Nhất' } }));
add('folder update icon', () => call(H.updateFolderController, { method: 'PATCH', params: { id: FOLDER }, body: { icon: 'Star' } }));
add('folder update nothing', () => call(H.updateFolderController, { method: 'PATCH', params: { id: FOLDER }, body: {} }));
add('folder update missing', () => call(H.updateFolderController, { method: 'PATCH', params: { id: FOLDER }, body: { icon: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('folder update vanished', () => call(H.updateFolderController, { method: 'PATCH', params: { id: FOLDER }, body: { icon: 'x' } }), noRowsWhen(/^UPDATE help_folders/));
add('folder delete', () => call(H.deleteFolderController, { method: 'DELETE', params: { id: FOLDER } }), NONE_USED);
add('folder delete images still used', () => call(H.deleteFolderController, { method: 'DELETE', params: { id: FOLDER } }), STILL_USED);
add('folder delete no pages', () =>
  call(H.deleteFolderController, { method: 'DELETE', params: { id: FOLDER } }),
  noRowsWhen(/SELECT content FROM help_pages WHERE folder_id/),
);
add('folder delete missing', () => call(H.deleteFolderController, { method: 'DELETE', params: { id: FOLDER } }), noRowsWhen(/SELECT id, title FROM help_folders/));
add('folders reorder', () => call(H.reorderFoldersController, { method: 'PATCH', body: { ordered_ids: [FOLDER_2, FOLDER] } }), rowsWhen(/COUNT\(\*\)::int/, [{ count: 2 }]));
add('folders reorder foreign', () => call(H.reorderFoldersController, { method: 'PATCH', body: { ordered_ids: [FOLDER_2, FOLDER] } }));
add('folders reorder empty', () => call(H.reorderFoldersController, { method: 'PATCH', body: { ordered_ids: [] } }));
add('folders reorder not a list', () => call(H.reorderFoldersController, { method: 'PATCH', body: { ordered_ids: FOLDER } }));

// ── Pages ──
add('pages', () => call(H.listPagesController));
add('pages of folder', () => call(H.listPagesController, { query: { folder_id: FOLDER } }));
add('pages no tenant', () => call(H.listPagesController, { user: { tenantId: null } }));
add('page', () => call(H.getPageController));
add('page missing', () => call(H.getPageController), noRowsWhen(/FROM help_pages hp/));
add('page create', () => call(H.createPageController, { method: 'POST', body: { folder_id: FOLDER, title: 'Trang Một', content: '<p>a</p>' } }));
add('page create no content', () => call(H.createPageController, { method: 'POST', body: { folder_id: FOLDER_2, title: 'Two' } }));
add('page create missing folder', () =>
  call(H.createPageController, { method: 'POST', body: { folder_id: FOLDER, title: 'x' } }),
  noRowsWhen(/INSERT INTO help_pages/),
);
add('page update', () =>
  call(H.updatePageController, { method: 'PATCH', body: { title: 'Trang Mới', content: `<img src="${IMG_B}">`, is_published: false } }),
  NONE_USED,
);
add('page update image still used', () => call(H.updatePageController, { method: 'PATCH', body: { content: '' } }), STILL_USED);
add('page update publish only', () => call(H.updatePageController, { method: 'PATCH', body: { is_published: true } }));
add('page update nothing', () => call(H.updatePageController, { method: 'PATCH', body: {} }));
add('page update missing', () => call(H.updatePageController, { method: 'PATCH', body: { title: 'x' } }), noRowsWhen(/FROM help_pages hp/));
add('page update locked missing', () => call(H.updatePageController, { method: 'PATCH', body: { title: 'x' } }), noRowsWhen(/FOR UPDATE OF hp/));
add('page update vanished', () => call(H.updatePageController, { method: 'PATCH', body: { title: 'x' } }), noRowsWhen(/^UPDATE help_pages/));
add('page delete', () => call(H.deletePageController, { method: 'DELETE' }), NONE_USED);
add('page delete images used', () => call(H.deletePageController, { method: 'DELETE' }), STILL_USED);
add('page delete missing', () => call(H.deletePageController, { method: 'DELETE' }), noRowsWhen(/^DELETE FROM help_pages/));
add('pages reorder', () =>
  call(H.reorderPagesController, { method: 'PATCH', body: { folder_id: FOLDER, ordered_ids: [PAGE_2, PAGE] } }),
  rowsWhen(/COUNT\(\*\)::int/, [{ count: 2 }]),
);
add('pages reorder foreign', () => call(H.reorderPagesController, { method: 'PATCH', body: { folder_id: FOLDER, ordered_ids: [PAGE_2, PAGE] } }));
add('pages reorder empty', () => call(H.reorderPagesController, { method: 'PATCH', body: { folder_id: FOLDER, ordered_ids: [] } }));
add('pages reorder missing folder', () =>
  call(H.reorderPagesController, { method: 'PATCH', body: { folder_id: FOLDER, ordered_ids: [PAGE] } }),
  noRowsWhen(/SELECT id FROM help_folders WHERE id/),
);
add('pages reorder no folder', () => call(H.reorderPagesController, { method: 'PATCH', body: { ordered_ids: [PAGE] } }));

// ── Images ──
const image = (extra: Record<string, unknown> = {}) => ({
  originalname: Buffer.from('Ảnh chụp.png', 'utf8').toString('latin1'),
  mimetype: 'image/png',
  size: 3,
  buffer: Buffer.from('png'),
  ...extra,
});
add('image upload', () => call(H.uploadImageController, { method: 'POST', file: image() }));
add('image upload not an image', () => call(H.uploadImageController, { method: 'POST', file: image({ mimetype: 'text/plain' }) }));
add('image upload no file', () => call(H.uploadImageController, { method: 'POST' }));
add('image upload audit fails', () =>
  call(H.uploadImageController, { method: 'POST', file: image() }),
  answers(text => (/INSERT INTO audit_logs/.test(text) ? { error: { code: '23514', message: 'check' } } : undefined)),
);
add('image delete', () => call(H.deleteImageController, { method: 'POST', body: { storage_path: ` ${IMG_A} ` } }), NONE_USED);
add('image delete proxy url', () =>
  call(H.deleteImageController, { method: 'POST', body: { path: `https://lms.a.test/api/storage/${encodeURIComponent(IMG_B)}` } }),
  NONE_USED,
);
add('image delete still used', () => call(H.deleteImageController, { method: 'POST', body: { storage_path: IMG_A } }), STILL_USED);
add('image delete other tenant', () => call(H.deleteImageController, { method: 'POST', body: { storage_path: '22222222-2222-4222-8222-222222222222/help-docs/a.png' } }));
add('image delete unsafe', () => call(H.deleteImageController, { method: 'POST', body: { storage_path: `${TENANT}/help-docs/../a.png` } }));
add('image delete empty', () => call(H.deleteImageController, { method: 'POST', body: {} }));

registerCharacterization({
  title: 'help docs characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'help-docs-sql.characterization.golden.json'),
  writeEnv: 'HELP_DOCS_SQL_GOLDEN_WRITE',
  fullOutEnv: 'HELP_DOCS_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER, FOLDER, FOLDER_2, PAGE, PAGE_2],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: storageRequests,
});
