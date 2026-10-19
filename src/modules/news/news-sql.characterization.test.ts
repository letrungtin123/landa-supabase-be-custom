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

// Characterization of the news routes (/api/news, except the remote image
// import, which fetches a third-party URL) and of the news asset cleanup
// worker functions: every SQL statement (text without whitespace
// differences, parameters, pool or transaction client, client releases),
// every Storage request (fetch double) and the answer of every handler. The
// golden file was written by the code before the news repository existed;
// moving SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, or an error, per case). Rewrite the golden file only for
// an intended change:
//   NEWS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/news/news-sql.characterization.test.ts
// NEWS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
// News cursors are signed with JWT_SECRET: the CI value, whatever .env says.
process.env.JWT_SECRET = 'ci-placeholder-not-a-secret';

const storageRequests: string[] = [];
installFetchRecorder(storageRequests, { Key: 'landa-storage/k', name: 'landa-storage', id: 'landa-storage' });

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./news.controller.js');
const service = await import('./news.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const POST = 'b0000000-0000-4000-8000-000000000001';
const POST_2 = 'b0000000-0000-4000-8000-000000000002';
const SESSION = 'c0000000-0000-4000-8000-000000000001';
const ASSET = 'd0000000-0000-4000-8000-000000000001';
const IMG_A = `${TENANT}/news/a.png`;
const IMG_B = `${TENANT}/news/b.png`;

/** One row with every column a news statement reads. */
const ROW = {
  id: POST,
  title: 'Bản tin',
  excerpt: 'Tóm tắt',
  content_html: `<p>Nội dung</p><img src="${IMG_A}">`,
  preview_image_path: IMG_B,
  created_by: USER,
  updated_by: USER,
  archived_by: null,
  created_at: '2026-05-01T00:00:00.000Z',
  updated_at: '2026-05-02T00:00:00.000Z',
  archived_at: null,
  version: '3',
  storage_path: IMG_A,
  status: 'pending',
  post_id: null,
  upload_session_id: SESSION,
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
  callHandler(handler, { originalUrl: '/api/news', params: { id: POST }, ...options }, ADMIN);
const H = ctrl;
const ASSETS = (rows: unknown[]): Answer => rowsWhen(/FROM news_post_assets\s+WHERE tenant_id = \$1::uuid AND storage_path = ANY/, rows);
const PENDING_BOTH = ASSETS([
  { ...ROW, storage_path: IMG_A },
  { ...ROW, storage_path: IMG_B },
]);
const LIST = /FROM news_posts np/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

// ── Lists and details ──
add('published', () => call(H.listPublished));
add('published search', () => call(H.listPublished, { query: { search: ' Tin  Mới ', limit: '5' } }));
add('published more pages', () => call(H.listPublished, { query: { limit: '1' } }), rowsWhen(LIST, [ROW, { ...ROW, id: POST_2 }]));
add('published bad limit', () => call(H.listPublished, { query: { limit: '0' } }));
add('published bad cursor', () => call(H.listPublished, { query: { cursor: 'abc' } }));
add('published no tenant', () => call(H.listPublished, { user: { tenantId: null } }));
add('managed archived', () => call(H.listManaged, { query: { status: 'archived', limit: '1' } }), rowsWhen(LIST, [{ ...ROW, archived_at: '2026-06-01T00:00:00.000Z' }, ROW]));
add('managed active search', () => call(H.listManaged, { query: { search: 'đề', limit: '20' } }));
add('managed bad status', () => call(H.listManaged, { query: { status: 'deleted' } }));
add('published detail', () => call(H.getPublished));
add('published detail missing', () => call(H.getPublished), noRowsWhen(/FROM news_posts/));
add('managed detail', () => call(H.getManaged));

// ── Create, update, archive ──
add('create', () =>
  call(H.create, {
    method: 'POST',
    body: { title: 'Tin', content_html: `<p>a</p><img src="${IMG_A}">`, preview_image_path: IMG_B, upload_session_id: SESSION },
  }),
  answers(PENDING_BOTH, rowsWhen(/RETURNING storage_path/, [{ storage_path: `${TENANT}/news/old.png` }])),
);
add('create no images', () => call(H.create, { method: 'POST', body: { title: 'Tin', content_html: '<p>a</p>', upload_session_id: SESSION } }));
add('create asset not pending', () =>
  call(H.create, { method: 'POST', body: { title: 'Tin', content_html: `<img src="${IMG_A}">`, upload_session_id: SESSION } }),
  ASSETS([{ ...ROW, status: 'attached' }]),
);
add('create bad preview', () =>
  call(H.create, { method: 'POST', body: { title: 'Tin', content_html: '<p>a</p>', preview_image_path: 'https://x.test/a.png', upload_session_id: SESSION } }),
);
add('create invalid', () => call(H.create, { method: 'POST', body: { title: '', content_html: 1 } }));
add('update', () =>
  call(H.update, {
    method: 'PATCH',
    body: { title: 'Mới', content_html: `<img src="${IMG_A}">`, preview_image_path: null, upload_session_id: SESSION, expected_version: 3 },
  }),
  ASSETS([{ ...ROW, status: 'attached', post_id: POST }]),
);
add('update title only', () => call(H.update, { method: 'PATCH', body: { title: 'Mới', expected_version: '3' } }), PENDING_BOTH);
add('update version conflict', () => call(H.update, { method: 'PATCH', body: { title: 'Mới', expected_version: 2 } }));
add('update missing', () => call(H.update, { method: 'PATCH', body: { title: 'x', expected_version: 3 } }), noRowsWhen(/FOR UPDATE/));
add('update nothing', () => call(H.update, { method: 'PATCH', body: { expected_version: 3 } }));
add('update bad preview', () => call(H.update, { method: 'PATCH', body: { preview_image_path: '../x', expected_version: 3 } }));
add('archive', () => call(H.archive, { method: 'POST' }));
add('archive unchanged', () => call(H.archive, { method: 'POST' }), noRowsWhen(/^UPDATE news_posts/));
add('restore', () => call(H.restore, { method: 'POST' }));

// ── Images ──
add('image upload', () => call(H.uploadImage, { method: 'POST', body: { upload_session_id: SESSION, kind: 'inline' }, file: { originalname: 'Ảnh.png', size: 10, buffer: PNG } }));
add('image upload not an image', () =>
  call(H.uploadImage, { method: 'POST', body: { upload_session_id: SESSION, kind: 'preview' }, file: { originalname: 'a.png', size: 3, buffer: Buffer.from('abc') } }),
);
add('image upload no file', () => call(H.uploadImage, { method: 'POST', body: { upload_session_id: SESSION, kind: 'preview' } }));
add('image upload invalid', () => call(H.uploadImage, { method: 'POST', body: { kind: 'cover' } }));
add('image upload register fails', () =>
  call(H.uploadImage, { method: 'POST', body: { upload_session_id: SESSION, kind: 'inline' }, file: { originalname: 'a.png', size: 10, buffer: PNG } }),
  failWhen(/INSERT INTO news_post_assets/, { code: '23505', message: 'duplicate' }),
);
add('image delete', () => call(H.deleteImage, { method: 'DELETE', body: { storage_path: IMG_A, upload_session_id: SESSION } }));
add('image delete not pending', () =>
  call(H.deleteImage, { method: 'DELETE', body: { storage_path: IMG_A, upload_session_id: SESSION } }),
  noRowsWhen(/RETURNING id, storage_path/),
);
add('image delete no session', () => call(H.deleteImage, { method: 'DELETE', body: { storage_path: IMG_A } }));
add('image delete other tenant', () =>
  call(H.deleteImage, { method: 'DELETE', body: { storage_path: '22222222-2222-4222-8222-222222222222/news/a.png', upload_session_id: SESSION } }),
);

// ── Cleanup worker functions ──
add('cleanup claim', () => service.claimNewsAssetCleanupBatch());
add('cleanup claim bounded', async () => [await service.claimNewsAssetCleanupBatch(500), await service.claimNewsAssetCleanupBatch(0)]);
add('cleanup complete claimed', () => service.completeClaimedNewsAsset(ASSET));
add('cleanup release claimed', () => service.releaseClaimedNewsAsset(ASSET));
add('cleanup complete deletes', () => service.completeNewsAssetDeletes([IMG_A, IMG_B]));
add('cleanup complete deletes none', () => service.completeNewsAssetDeletes([]));

registerCharacterization({
  title: 'news characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'news-sql.characterization.golden.json'),
  writeEnv: 'NEWS_SQL_GOLDEN_WRITE',
  fullOutEnv: 'NEWS_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER, POST, POST_2, SESSION, ASSET],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: storageRequests,
  embeddedUuids: true,
});
