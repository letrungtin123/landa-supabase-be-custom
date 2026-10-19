import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';

// Characterization of the library routes (/api/library): every SQL statement
// (text without whitespace differences, parameters, pool or transaction
// client) and the answer (status, body, headers, or the error passed to next)
// of every library handler, over a matrix of queries, bodies and empty
// results. The golden file was written by the code before the library
// repository existed; moving SQL into repositories must keep every entry
// equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, per case). Rewrite the golden file only for an intended
// change:
//   LIBRARY_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/library/library-sql.characterization.test.ts
// LIBRARY_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

// Storage requests (upload, delete) are recorded and answered by a fetch double.
const storageRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  storageRequests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', Key: 'k', path: 'p' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./library.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'library-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.LIBRARY_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.LIBRARY_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const DOC = 'd0000000-0000-4000-8000-000000000001';
const DOC_2 = 'd0000000-0000-4000-8000-000000000002';
const CATEGORY = 'f0000000-0000-4000-8000-000000000001';
const CATEGORY_2 = 'f0000000-0000-4000-8000-000000000002';
const TEAM = 'e0000000-0000-4000-8000-000000000003';

/** One row with every column a library statement reads. */
const ROW = {
  id: DOC, tenant_id: TENANT, name: 'Danh mục 1', slug: 'danh-muc-1', sort_order: 1, is_public: false, count: '3',
  doc_count: '2', is_assigned_to_team: true, title: 'Tài liệu A', file_url: `${TENANT}/library/a.pdf`, file_size: 2048,
  extension: 'pdf', category_id: CATEGORY, is_visible: true, created_at: '2026-02-01T00:00:00.000Z',
  category_name: 'Danh mục 1', uploaded_by_name: 'admin01', group_id: 'g-1', group_name: 'Nhóm A', subgroup_id: 'sg-1',
  subgroup_name: 'Phân nhóm A', team_id: TEAM, team_name: 'Team A', assigned_at: '2026-03-01T00:00:00.000Z',
  storage_path: `${TENANT}/library/a.pdf`, size_bytes: '2048',
};

type Answer = (text: string, index: number) => { rows: unknown[] } | undefined;

interface Statement {
  via: string;
  text: string;
  params: unknown[];
}

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function installDb(t: TestContext, answer?: Answer): Statement[] {
  const statements: Statement[] = [];
  const reply = (text: string) => {
    const custom = answer?.(text, statements.length - 1);
    const rows = custom?.rows ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(text) ? [] : [ROW]);
    return { rows, rowCount: rows.length };
  };
  const handler = (via: string) => async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    statements.push({ via, text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
    return reply(text);
  };
  t.mock.method(pg.default.Pool.prototype, 'query', async function (this: unknown, config: string, values?: unknown[]) {
    return handler(this === pool ? 'pool' : 'other-pool')(config, values);
  });
  t.mock.method(pg.default.Pool.prototype, 'connect', async function (this: unknown) {
    return { query: handler(this === pool ? 'client' : 'other-client'), release() {} };
  });
  return statements;
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  send(body: unknown): FakeResponse;
  setHeader(name: string, value: unknown): FakeResponse;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

interface CallOptions {
  files?: unknown;
  role?: string;
  tenantId?: string | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
  originalUrl?: string;
}

async function call(handler: Handler, options: CallOptions = {}) {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
  let passed: unknown;
  const req = {
    user: {
      id: USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'staff',
      username: 'admin01',
      sessionMode: 'normal',
    },
    query: options.query ?? {},
    params: { id: DOC, ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    files: options.files,
    originalUrl: options.originalUrl ?? '/api/library',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  } as unknown as Request;
  await handler(req, res as unknown as Response, (error?: unknown) => {
    passed = error;
  });
  if (passed !== undefined) {
    const error = passed as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
    return {
      next: {
        name: error?.name ?? null,
        message: error?.message ?? String(passed),
        statusCode: error?.statusCode ?? null,
        code: error?.code ?? null,
      },
    };
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

interface Case {
  name: string;
  run: () => Promise<unknown>;
  answer?: Answer;
}

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const noRowsAt =
  (...indexes: number[]): Answer =>
  (_text, index) =>
    indexes.includes(index) ? { rows: [] } : undefined;
const noRowsWhen =
  (pattern: RegExp): Answer =>
  text =>
    pattern.test(text) ? { rows: [] } : undefined;
const rowsWhen =
  (pattern: RegExp, rows: unknown[]): Answer =>
  text =>
    pattern.test(text) ? { rows } : undefined;

const H = ctrl;

// ── Document categories ──
add('categories', () => call(H.listCategoriesController));
add('categories filtered', () =>
  call(H.listCategoriesController, { query: { search: 'Hợp đồng', page: '2', page_size: '5', assigned_team_id: ` ${TEAM} ` } }),
);
add('categories blank team', () => call(H.listCategoriesController, { query: { assigned_team_id: '  ' } }));
add('categories odd query', () => call(H.listCategoriesController, { query: { search: ['a'], page: 'x', assigned_team_id: [TEAM] } }));
add('categories no tenant', () => call(H.listCategoriesController, { tenantId: null, query: { assigned_team_id: TEAM } }));
add('categories empty', () => call(H.listCategoriesController), text => (/COUNT\(\*\) AS count/.test(text) ? { rows: [{ count: '0' }] } : { rows: [] }));
add('category create', () => call(H.createCategoryController, { body: { name: 'Hợp đồng Mẫu 2026!', is_public: true } }));
add('category create no name', () => call(H.createCategoryController, { body: { name: '' } }));
add('category create no body', () => call(H.createCategoryController, { body: undefined }));
add('category create no tenant', () => call(H.createCategoryController, { tenantId: null, body: { name: 'x' } }));
add('category rename', () => call(H.updateCategoryController, { body: { name: 'Tên Mới' } }));
add('category make public', () => call(H.updateCategoryController, { body: { is_public: true } }));
add('category make public already', () =>
  call(H.updateCategoryController, { body: { is_public: true, name: 'Danh mục 1' } }),
  rowsWhen(/FOR UPDATE/, [{ ...ROW, is_public: true }]),
);
add('category make private', () => call(H.updateCategoryController, { body: { is_public: false } }));
add('category update nothing', () => call(H.updateCategoryController, { body: {} }));
add('category update missing', () => call(H.updateCategoryController, { body: { name: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('category update vanished', () =>
  call(H.updateCategoryController, { body: { name: 'x' } }),
  noRowsWhen(/^UPDATE document_categories/),
);
add('category update no tenant', () => call(H.updateCategoryController, { tenantId: null, body: { name: 'x' } }));
add('category public impact', () => call(H.publicImpactCategoryController));
add('category public impact limit', () => call(H.publicImpactCategoryController, { query: { limit: '5' } }));
add('category public impact odd limit', () => call(H.publicImpactCategoryController, { query: { limit: 'abc' } }));
add('category public impact big limit', () => call(H.publicImpactCategoryController, { query: { limit: '500' } }));
add('category public impact none', () => call(H.publicImpactCategoryController), (_text, index) => (index > 0 ? { rows: [] } : undefined));
add('category public impact missing', () => call(H.publicImpactCategoryController), noRowsAt(0));
add('category public impact no tenant', () => call(H.publicImpactCategoryController, { tenantId: null }));
add('category delete', () => call(H.deleteCategoryController));
add('category delete missing', () => call(H.deleteCategoryController), noRowsWhen(/^DELETE FROM document_categories/));
add('category delete no tenant', () => call(H.deleteCategoryController, { tenantId: null }));
add('categories bulk delete', () => call(H.bulkDeleteCategoriesController, { body: { ids: [CATEGORY, ` ${CATEGORY_2} `, CATEGORY, 3] } }));
add('categories bulk delete none', () =>
  call(H.bulkDeleteCategoriesController, { body: { ids: [CATEGORY] } }),
  noRowsWhen(/^DELETE FROM document_categories/),
);
add('categories bulk delete empty', () => call(H.bulkDeleteCategoriesController, { body: { ids: [' ', 1] } }));
add('categories bulk delete not a list', () => call(H.bulkDeleteCategoriesController, { body: { ids: CATEGORY } }));
add('categories bulk delete no tenant', () => call(H.bulkDeleteCategoriesController, { tenantId: null, body: { ids: [] } }));

// ── Documents ──
add('documents', () => call(H.listDocumentsController));
add('documents filtered', () =>
  call(H.listDocumentsController, { query: { search: 'hợp đồng', category_id: CATEGORY, extension: 'pdf', page: '3', page_size: '10' } }),
);
add('documents odd query', () => call(H.listDocumentsController, { query: { search: ['a'], category_id: [CATEGORY], page: '0', page_size: '-1' } }));
add('documents no tenant', () => call(H.listDocumentsController, { tenantId: null }));
add('documents empty', () => call(H.listDocumentsController), text => (/COUNT\(\*\) AS count/.test(text) ? { rows: [{ count: '0' }] } : { rows: [] }));
const FILE_URL = `${TENANT}/library/hop-dong.pdf`;
add('document create', () =>
  call(H.createDocumentController, { body: { title: 'Hợp đồng', file_url: FILE_URL, file_size: 10, extension: 'pdf', category_id: CATEGORY } }),
);
add('document create plain', () => call(H.createDocumentController, { body: { title: 'Hợp đồng', file_url: ` ${FILE_URL} `, is_visible: false } }));
add('document create other tenant file', () =>
  call(H.createDocumentController, { body: { title: 'x', file_url: '22222222-2222-4222-8222-222222222222/library/a.pdf' } }),
);
add('document create no file', () => call(H.createDocumentController, { body: { title: 'x' } }));
add('document create public', () => call(H.createDocumentController, { body: { title: 'x', file_url: FILE_URL, is_public: false } }));
add('document create category missing', () =>
  call(H.createDocumentController, { body: { title: 'x', file_url: FILE_URL, category_id: CATEGORY } }),
  noRowsWhen(/SELECT id FROM document_categories/),
);
add('document create nothing returned', () =>
  call(H.createDocumentController, { body: { title: 'x', file_url: FILE_URL } }),
  noRowsWhen(/INSERT INTO documents/),
);
add('document create no tenant', () => call(H.createDocumentController, { tenantId: null, body: { title: 'x', file_url: FILE_URL } }));
add('document update', () => call(H.updateDocumentController, { body: { title: 'Tên mới', is_visible: false } }));
add('document update category', () => call(H.updateDocumentController, { body: { category_id: CATEGORY_2 } }));
add('document update clear category', () => call(H.updateDocumentController, { body: { category_id: null } }));
add('document update keep no category', () =>
  call(H.updateDocumentController, { body: { title: 'x' } }),
  rowsWhen(/FOR UPDATE/, [{ ...ROW, category_id: null }]),
);
add('document update category missing', () =>
  call(H.updateDocumentController, { body: { category_id: CATEGORY_2 } }),
  noRowsWhen(/SELECT id FROM document_categories/),
);
add('document update unnamed category', () =>
  call(H.updateDocumentController, { body: { category_id: CATEGORY_2 } }),
  noRowsWhen(/SELECT name FROM document_categories/),
);
add('document update missing', () => call(H.updateDocumentController, { body: { title: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('document update vanished', () => call(H.updateDocumentController, { body: { title: 'x' } }), noRowsWhen(/^UPDATE documents/));
add('document update public', () => call(H.updateDocumentController, { body: { is_public: true } }));
add('document update nothing', () => call(H.updateDocumentController, { body: { other: 1 } }));
add('document update no tenant', () => call(H.updateDocumentController, { tenantId: null, body: { title: 'x' } }));
add('document delete', () => call(H.deleteDocumentController));
add('document delete other tenant file', () =>
  call(H.deleteDocumentController),
  rowsWhen(/^DELETE FROM documents/, [{ ...ROW, file_url: 'https://cdn.example.test/a.pdf' }]),
);
add('document delete missing', () => call(H.deleteDocumentController), noRowsWhen(/^DELETE FROM documents/));
add('document delete no tenant', () => call(H.deleteDocumentController, { tenantId: null }));
add('documents bulk delete', () =>
  call(H.bulkDocumentActionController, { body: { ids: [DOC, DOC_2, DOC], action: 'delete' } }),
  rowsWhen(/^DELETE FROM documents/, [ROW, { ...ROW, id: DOC_2, file_url: null }]),
);
add('documents bulk delete none', () =>
  call(H.bulkDocumentActionController, { body: { ids: [DOC], action: 'delete' } }),
  noRowsWhen(/^DELETE FROM documents/),
);
add('documents bulk delete empty', () => call(H.bulkDocumentActionController, { body: { ids: [''], action: 'delete' } }));
for (const action of ['show', 'hide']) {
  add(`documents bulk ${action}`, () => call(H.bulkDocumentActionController, { body: { ids: [DOC, ` ${DOC_2}`], action } }));
  add(`documents bulk ${action} none`, () =>
    call(H.bulkDocumentActionController, { body: { ids: [DOC], action } }),
    noRowsWhen(/^UPDATE documents/),
  );
}
add('documents bulk set category', () =>
  call(H.bulkDocumentActionController, { body: { ids: [DOC], action: 'set_category', category_id: CATEGORY } }),
);
add('documents bulk set category missing', () =>
  call(H.bulkDocumentActionController, { body: { ids: [DOC], action: 'set_category', category_id: CATEGORY } }),
  noRowsWhen(/SELECT name FROM document_categories/),
);
add('documents bulk clear category', () =>
  call(H.bulkDocumentActionController, { body: { ids: [DOC], action: 'set_category', category_id: '' } }),
);
add('documents bulk bad action', () => call(H.bulkDocumentActionController, { body: { ids: [DOC], action: 'archive' } }));
add('documents bulk bad action empty ids', () => call(H.bulkDocumentActionController, { body: { ids: [], action: 'archive' } }));
add('documents bulk no action', () => call(H.bulkDocumentActionController, { body: { ids: [DOC] } }));
add('documents bulk not a list', () => call(H.bulkDocumentActionController, { body: { ids: DOC, action: 'show' } }));
add('documents bulk no tenant', () => call(H.bulkDocumentActionController, { tenantId: null, body: { ids: [DOC], action: 'show' } }));

// ── Upload (temporary files on disk, Storage through the fetch double) ──
const os = await import('node:os');
const fsSync = await import('node:fs');
const uploadDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'library-characterization-'));
test.after(() => fsSync.rmSync(uploadDir, { recursive: true, force: true }));
let uploadCount = 0;
function tempUpload(originalname: string, content = 'pdf-bytes', extra: Record<string, unknown> = {}) {
  const filePath = path.join(uploadDir, `upload-${++uploadCount}.tmp`);
  fsSync.writeFileSync(filePath, content);
  return { originalname, mimetype: 'application/pdf', size: Buffer.byteLength(content), path: filePath, ...extra };
}
add('upload one', () => call(H.uploadDocumentController, { files: [tempUpload('Hợp đồng.pdf')], body: {} }));
add('upload with fields', () =>
  call(H.uploadDocumentController, {
    files: [tempUpload('a.docx'), tempUpload('B.PDF')],
    body: { title: 'Tiêu đề', category_id: CATEGORY, is_visible: 'false' },
  }),
);
add('upload too big and no path', () =>
  call(H.uploadDocumentController, {
    files: [tempUpload('big.pdf', 'x', { size: 400 * 1024 * 1024 }), { originalname: 'lost.pdf', mimetype: 'application/pdf', size: 3 }],
    body: {},
  }),
);
add('upload category missing', () =>
  call(H.uploadDocumentController, { files: [tempUpload('a.pdf')], body: { category_id: CATEGORY } }),
  noRowsWhen(/SELECT id FROM document_categories/),
);
add('upload empty file', () => call(H.uploadDocumentController, { files: [tempUpload('empty.pdf', '')], body: {} }));
add('upload no files', () => call(H.uploadDocumentController, { files: [], body: {} }));
add('upload no file list', () => call(H.uploadDocumentController, { body: {} }));
add('upload no tenant', () => call(H.uploadDocumentController, { tenantId: null, files: [], body: {} }));

// ── Runner ──

// Storage quota reservations get a random id per call; any UUID that is not
// one of this file's fixed ids is recorded as "<random-uuid>".
const FIXED_IDS = new Set([TENANT, USER, DOC, DOC_2, CATEGORY, CATEGORY_2, TEAM]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' && UUID.test(item) && !FIXED_IDS.has(item) ? '<random-uuid>' : item,
    ),
  );
}

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
  test(`library characterization: ${item.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    t.mock.method(console, 'warn', () => undefined);
    t.mock.method(console, 'error', () => undefined);
    storageRequests.length = 0;
    const statements = installDb(t, item.answer);
    let result: unknown;
    try {
      result = plain(await item.run());
    } catch (error) {
      result = { thrown: (error as Error).name, message: (error as Error).message };
    }
    const outcome = stable({
      statements: statements.map(s => ({ via: s.via, sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      storage: [...storageRequests],
      result,
    });
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
    const sorted = Object.fromEntries(
      Object.keys(written)
        .sort()
        .map(name => [name, written[name]]),
    );
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
});
