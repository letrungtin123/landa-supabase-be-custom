import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// C4: a knowledge base document that AI ID is still designing a course from (the source of a workspace
// whose V2 run is planning, executing or finalizing) is not deleted: 409 KB_DOCUMENT_IN_USE_BY_AI_ID,
// on the single and the bulk route (the bulk request is refused as a whole). The AI ID source list
// marks such documents and says whether the caller may delete at all.
//
// A pg double answers every statement with one row that has every column these paths read; the
// statements a case cares about are answered on purpose.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('../../../config/redis.js');
redis.installRedisClient(null);
const pg = await import('pg');
const { describeKbDocumentDeletionFailure, KbDocumentInUseByAiIdError } = await import('./kb-document-deletion.logic.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000c9';
const BOT = 'b0000000-0000-4000-8000-000000000001';
const KB = 'c0000000-0000-4000-8000-000000000001';
const DOC = 'd0000000-0000-4000-8000-000000000001';
const DOC_2 = 'd0000000-0000-4000-8000-000000000002';
const IN_USE = /FROM lesson_author_workspace_v2_runs r/;

const ROW = {
  id: DOC, tenant_id: TENANT, kb_id: KB, name: 'Tài liệu A.pdf', description: '', type: 'file', status: 'learned',
  error_reason: null, source_info: null, file_path: `${TENANT}/kb-files/20261022/a.pdf`, content: null, created_by: USER,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', restore_state: 'idle',
  active_restore_job_id: null, document_count: 2, restore_required: false, restore_reason: null, full_count: '1',
  api_key_fingerprint: 'fp-current', remote_status: 'active', remote_error_reason: null, remote_error_code: null,
  store_id: 'store-1', store_name: 'fileSearchStores/kb-1', gemini_path: 'g/1', exists: false, cnt: 0,
  active_engine: 'self_built_rag', provider: 'google_ai_studio', encrypted_api_key: null, transition_state: 'idle',
  token_timezone: 'Asia/Saigon', chat_model: 'm', lesson_author_model: 'm', embedding_model: 'gemini-embedding-001',
  embedding_dimensions: 768, active_transition_job_id: null, document_id: DOC, bot_id: BOT, target: 'lesson_author',
  bot_name: 'Bot', kb_name: 'KB', allowed: false,
};

type Answer = (sql: string, params: unknown[]) => unknown[] | undefined;

function database(t: TestContext, answer: Answer = () => undefined) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const handle = async (text: unknown, params: unknown[] = []) => {
    const sql = String(typeof text === 'object' && text && 'text' in text ? (text as { text: string }).text : text)
      .replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    const custom = answer(sql, params);
    if (custom) return { rows: custom, rowCount: custom.length };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (/AND transition_state IN/.test(sql) || IN_USE.test(sql) || /FROM modules m/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [ROW], rowCount: 1 };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined, on: () => undefined }));
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  return statements;
}

function call(params: Record<string, string>, body: unknown = {}, options: { locale?: 'en'; role?: string; query?: Record<string, string> } = {}) {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status(code: number) { out.status = code; return this; },
    json(value: Record<string, unknown>) { out.body = value; return this; }, setHeader: () => undefined } as unknown as Response;
  const headers: Record<string, string> = options.locale ? { 'x-ui-locale': options.locale } : {};
  const req = { params, query: options.query ?? {}, body, headers, get: (name: string) => headers[name.toLowerCase()],
    ip: '127.0.0.1', socket: {},
    user: { id: USER, tenantId: TENANT, role: options.role ?? 'superuser', username: 'u', sessionMode: 'normal' } } as unknown as Request;
  return { req, res, out };
}

const inUseRows = (...ids: string[]): Answer => sql => IN_USE.test(sql)
  ? ids.map(id => ({ document_id: id, name: id === DOC ? 'Tài liệu A.pdf' : 'Tài liệu B.pdf' })) : undefined;

test('the refusal names the documents (five at most, the rest counted), in Vietnamese and English', () => {
  const one = new KbDocumentInUseByAiIdError([{ document_id: DOC, name: 'Sổ tay.pdf' }]);
  assert.equal(one.statusCode, 409);
  assert.equal(one.code, 'KB_DOCUMENT_IN_USE_BY_AI_ID');
  assert.equal(one.message, 'AI ID đang dùng tài liệu này để soạn khoá học nên chưa xoá được: “Sổ tay.pdf”. Vui lòng thử lại khi AI ID soạn xong.');
  assert.equal(one.localized('en'), 'AI ID is designing a course from this document, so it cannot be deleted yet: “Sổ tay.pdf”. '
    + 'Please try again when AI ID has finished.');
  const seven = new KbDocumentInUseByAiIdError(Array.from({ length: 7 }, (_, index) => ({ document_id: `id-${index}`, name: `T${index}` })));
  assert.match(seven.message, /^AI ID đang dùng các tài liệu này .*“T0”, “T1”, “T2”, “T3”, “T4” và 2 tài liệu khác\. /);
  assert.match(seven.localized('en'), /these documents, so they .*“T4” and 2 more\. /);
  assert.deepEqual(describeKbDocumentDeletionFailure(seven, 'en'), { statusCode: 409, code: 'KB_DOCUMENT_IN_USE_BY_AI_ID',
    message: seven.localized('en'), documentIds: ['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6'] });
});

test('single delete: a document an active AI ID run uses is refused after its row is locked, nothing deleted', async t => {
  const controller = await import('./kb.controller.js');
  const statements = database(t, inUseRows(DOC));
  const { req, res, out } = call({ kbId: KB, docId: DOC });
  await controller.deleteDocument(req, res);
  assert.equal(out.status, 409);
  assert.deepEqual(out.body, { success: false, code: 'KB_DOCUMENT_IN_USE_BY_AI_ID', document_ids: [DOC],
    message: 'AI ID đang dùng tài liệu này để soạn khoá học nên chưa xoá được: “Tài liệu A.pdf”. Vui lòng thử lại khi AI ID soạn xong.' });
  const sqls = statements.map(({ sql }) => sql);
  const lock = sqls.findIndex(sql => /^SELECT \* FROM kb_documents WHERE id = \$1 AND kb_id = \$2 AND tenant_id = \$3 FOR UPDATE$/.test(sql));
  const check = sqls.findIndex(sql => IN_USE.test(sql));
  assert.ok(lock > 0 && check > lock, 'the in-use check runs after the document row lock');
  assert.deepEqual(statements[check].params, [TENANT, ['planning', 'executing', 'finalizing'], KB, [DOC]]);
  assert.equal(sqls.some(sql => /^DELETE FROM kb_documents|INSERT INTO kb_operation_jobs|UPDATE kb_operation_jobs/.test(sql)), false);
  assert.equal(sqls.at(-1), 'ROLLBACK');
});

test('bulk delete: one document in use refuses the whole request and names only that one', async t => {
  const controller = await import('./kb.controller.js');
  const statements = database(t, (sql, params) => {
    if (/AND status <> 'learning' AND status <> 'deleting' FOR UPDATE/.test(sql)) return [ROW, { ...ROW, id: DOC_2, name: 'Tài liệu B.pdf' }];
    return inUseRows(DOC_2)(sql, params);
  });
  const { req, res, out } = call({ kbId: KB }, { doc_ids: [DOC, DOC_2] }, { locale: 'en' });
  await controller.bulkDeleteDocuments(req, res);
  assert.equal(out.status, 409);
  assert.equal(out.body?.code, 'KB_DOCUMENT_IN_USE_BY_AI_ID');
  assert.deepEqual(out.body?.document_ids, [DOC_2]);
  assert.equal(out.body?.message, 'AI ID is designing a course from this document, so it cannot be deleted yet: “Tài liệu B.pdf”. '
    + 'Please try again when AI ID has finished.');
  const check = statements.find(({ sql }) => IN_USE.test(sql));
  assert.deepEqual(check?.params, [TENANT, ['planning', 'executing', 'finalizing'], KB, [DOC, DOC_2]]);
  assert.equal(statements.some(({ sql }) => /^DELETE FROM kb_documents|INSERT INTO kb_operation_jobs|UPDATE kb_operation_jobs/.test(sql)), false);
});

test('documents no active run uses are queued for deletion as before (202, background worker)', async t => {
  const controller = await import('./kb.controller.js');
  const single = database(t);
  const one = call({ kbId: KB, docId: DOC });
  await controller.deleteDocument(one.req, one.res);
  assert.equal(one.out.status, 202);
  assert.deepEqual(one.out.body?.data, { queued: true });
  assert.ok(single.some(({ sql }) => /^DELETE FROM kb_documents WHERE id = \$1/.test(sql)));
  assert.ok(single.some(({ sql }) => /kb_operation_jobs/.test(sql)), 'a durable document_delete operation');

  database(t, sql => /AND status <> 'learning' AND status <> 'deleting' FOR UPDATE/.test(sql)
    ? [ROW, { ...ROW, id: DOC_2 }] : undefined);
  const bulk = call({ kbId: KB }, { doc_ids: [DOC, DOC_2] });
  await controller.bulkDeleteDocuments(bulk.req, bulk.res);
  assert.equal(bulk.out.status, 202);
  assert.deepEqual(bulk.out.body?.data, { deleted: 2, queued: 2 });
});

test('the AI ID source list marks documents in use and says whether the caller may delete', async t => {
  const controller = await import('../chat/chat.controller.js');
  const rows = [
    { document_id: DOC, kb_id: KB, name: 'Tài liệu A.pdf', type: 'file', status: 'learned', source_info: null, gemini_path: null, content_excerpt: null },
    { document_id: DOC_2, kb_id: KB, name: 'Tài liệu B.pdf', type: 'file', status: 'learning', source_info: null, gemini_path: null, content_excerpt: null },
  ];
  const statements = database(t, (sql, params) => {
    if (/^SELECT d\.id::text AS document_id, d\.kb_id::text AS kb_id/.test(sql)) return rows;
    if (/FROM tenant_kb_assignments tka JOIN knowledgebases kb/.test(sql)) return [{ ...ROW, kb_id: KB }];
    if (/SELECT bool_or\(pgm\.can_delete\) AS allowed/.test(sql)) return [{ allowed: false }];
    return inUseRows(DOC)(sql, params);
  });
  const admin = call({}, {}, { query: { target: 'lesson_author' } });
  await controller.listLessonAuthorSourceDocuments(admin.req, admin.res);
  assert.equal(admin.out.status, 200);
  assert.deepEqual((admin.out.body?.data as Array<Record<string, unknown>>).map(row => [row.document_id, row.in_use_by_ai_id, row.can_delete]),
    [[DOC, true, true], [DOC_2, false, true]]);
  const check = statements.find(({ sql }) => IN_USE.test(sql));
  assert.deepEqual(check?.params, [TENANT, ['planning', 'executing', 'finalizing'], KB, [DOC, DOC_2]]);

  // Staff without the knowledge base delete permission: no delete controls.
  const staff = call({}, {}, { role: 'staff', query: { target: 'lesson_author' } });
  await controller.listLessonAuthorSourceDocuments(staff.req, staff.res);
  assert.deepEqual((staff.out.body?.data as Array<Record<string, unknown>>).map(row => row.can_delete), [false, false]);
});

test('an empty page asks nothing about AI ID runs', async () => {
  const { findSourceDocumentsInActiveRuns } = await import('../ai-id/sources/lesson-author-source-in-use.repository.js');
  let asked = 0;
  assert.deepEqual(await findSourceDocumentsInActiveRuns({ query: async () => { asked += 1; return { rows: [], rowCount: 0 }; } },
    { tenantId: TENANT, kbId: KB, documentIds: [] }), []);
  assert.equal(asked, 0);
});
