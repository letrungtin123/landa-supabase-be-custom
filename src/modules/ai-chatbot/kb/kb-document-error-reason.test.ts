import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// GET /kb/:kbId/documents gives a document's error_reason in the request language (X-UI-Locale), for the
// texts the KB worker stores when the AI service would not learn a document (security review 2026-10-24,
// L-6). A pg double plays the knowledge base and its documents.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('../../../config/redis.js');
redis.installRedisClient(null);
const pg = await import('pg');
const { RAG_DOCUMENT_ERROR_TEXT } = await import('../ai-platform/ai-rag-document-error.logic.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000c9';
const KB = 'c0000000-0000-4000-8000-000000000001';
const [LIMIT_VI, LIMIT_EN] = RAG_DOCUMENT_ERROR_TEXT.DOCUMENT_LIMIT_EXCEEDED;
const EARLIER_LIMIT_VI = 'Tài liệu vượt giới hạn xử lý an toàn. Vui lòng giảm dung lượng hoặc độ dài tài liệu.';
const OTHER = 'Không tìm thấy tệp nguồn của tài liệu trong kho lưu trữ.';
const STORED = [LIMIT_VI, EARLIER_LIMIT_VI, OTHER, null];

function database(t: TestContext): void {
  const answer = async (text: unknown) => {
    const sql = String(typeof text === 'object' && text && 'text' in text ? (text as { text: string }).text : text)
      .replace(/\s+/g, ' ');
    if (/FROM tenant_ai_settings s/.test(sql)) return { rows: [{ tenant_id: TENANT, active_engine: 'self_built_rag',
      provider: 'google_ai_studio', token_timezone: 'Asia/Saigon', chat_model: 'm', lesson_author_model: 'm',
      embedding_model: 'gemini-embedding-001', embedding_dimensions: 768, transition_state: 'idle',
      active_transition_job_id: null, encrypted_api_key: null, api_key_fingerprint: null }], rowCount: 1 };
    if (/FROM knowledgebases kb/.test(sql)) {
      return { rows: [{ id: KB, tenant_id: TENANT, name: 'Quy trình', kb_id: KB }], rowCount: 1 };
    }
    if (/FROM kb_documents/.test(sql)) {
      const rows = STORED.map((errorReason, index) => ({ id: `d0000000-0000-4000-8000-00000000000${index}`, kb_id: KB,
        tenant_id: TENANT, type: 'file', name: `tai-lieu-${index}.pdf`, status: errorReason ? 'error' : 'learned',
        error_reason: errorReason, full_count: String(STORED.length) }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', answer);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: answer, release: () => undefined,
    on: () => undefined }));
}

async function listReasons(uiLocale: string | undefined): Promise<Array<string | null>> {
  const controller = await import('./kb.controller.js');
  const out: { status?: number; body?: { success: boolean; data: { data: Array<{ error_reason: string | null }> } } } = {};
  const res = { status(code: number) { out.status = code; return this; },
    json(value: typeof out.body) { out.body = value; return this; }, setHeader: () => undefined } as unknown as Response;
  const req = { params: { kbId: KB }, query: {}, body: {}, headers: {}, ip: '127.0.0.1', socket: {},
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? uiLocale : undefined),
    user: { id: USER, tenantId: TENANT, role: 'superuser', username: 'u', sessionMode: 'normal' } } as unknown as Request;
  await controller.listDocuments(req, res);
  assert.equal(out.status, 200);
  return out.body!.data.data.map(document => document.error_reason);
}

test('English UI: the AI limit text is English (also for documents refused before this release)', async t => {
  database(t);
  assert.deepEqual(await listReasons('en'), [LIMIT_EN, LIMIT_EN, OTHER, null]);
});

test('Vietnamese UI (and no header): the current Vietnamese wording, which says to split the document', async t => {
  database(t);
  assert.deepEqual(await listReasons('vi'), [LIMIT_VI, LIMIT_VI, OTHER, null]);
  assert.deepEqual(await listReasons(undefined), [LIMIT_VI, LIMIT_VI, OTHER, null]);
});
