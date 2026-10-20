import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// The AI ID organization context knowledge base (tenant_kb_assignments target 'lesson_author_context') is
// hidden from knowledge base management: the list, every /kb/:kbId… route, the bot knowledge base choice and
// the lesson-author knowledge base assignment treat it as not found. A pg double plays a database where that
// knowledge base exists: a statement with the hiding condition finds nothing, one without it finds the row.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('../../../config/redis.js');
redis.installRedisClient(null);
const pg = await import('pg');
const { visibleKnowledgebaseSql } = await import('./kb.repository.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000c9';
const KB = 'c0000000-0000-4000-8000-000000000001';
const DOC = 'd0000000-0000-4000-8000-000000000001';
const HIDDEN = /hidden_kb\.target = 'lesson_author_context'/;

function database(t: TestContext) {
  const statements: string[] = [];
  const answer = async (text: unknown) => {
    const sql = String(typeof text === 'object' && text && 'text' in text ? (text as { text: string }).text : text)
      .replace(/\s+/g, ' ');
    statements.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM tenant_ai_settings s/.test(sql)) return { rows: [{ tenant_id: TENANT, active_engine: 'self_built_rag',
      provider: 'google_ai_studio', token_timezone: 'Asia/Saigon', chat_model: 'm', lesson_author_model: 'm',
      embedding_model: 'gemini-embedding-001', embedding_dimensions: 768, transition_state: 'idle',
      active_transition_job_id: null, encrypted_api_key: null, api_key_fingerprint: null }], rowCount: 1 };
    if (/FROM knowledgebases kb/.test(sql)) {
      return HIDDEN.test(sql) ? { rows: [], rowCount: 0 }
        : { rows: [{ id: KB, tenant_id: TENANT, name: 'AI ID – Ngữ cảnh doanh nghiệp', kb_id: KB }], rowCount: 1 };
    }
    if (/FROM kb_documents/.test(sql)) return { rows: [{ id: DOC, kb_id: KB, type: 'article', name: 'x', full_count: '1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', answer);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: answer, release: () => undefined, on: () => undefined }));
  return statements;
}

function call(params: Record<string, string>, body: unknown = {}) {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status(code: number) { out.status = code; return this; },
    json(value: Record<string, unknown>) { out.body = value; return this; }, setHeader: () => undefined } as unknown as Response;
  const req = { params, query: {}, body, headers: {}, get: () => undefined, ip: '127.0.0.1', socket: {},
    user: { id: USER, tenantId: TENANT, role: 'superuser', username: 'u', sessionMode: 'normal' } } as unknown as Request;
  return { req, res, out };
}

test('the hiding condition: a fixed SQL fragment on the given alias only', () => {
  assert.match(visibleKnowledgebaseSql('kb').replace(/\s+/g, ' '),
    /^NOT EXISTS \( SELECT 1 FROM tenant_kb_assignments hidden_kb WHERE hidden_kb\.tenant_id = kb\.tenant_id AND hidden_kb\.kb_id = kb\.id AND hidden_kb\.target = 'lesson_author_context' \)$/);
  assert.throws(() => visibleKnowledgebaseSql('kb; DROP TABLE x'), /Invalid knowledge base SQL alias/);
});

test('the knowledge base list and detail never return the context knowledge base', async t => {
  const statements = database(t);
  const kb = await import('./kb.service.js');
  assert.deepEqual((await kb.listKnowledgebases(TENANT)).data, []);
  assert.equal(await kb.getKnowledgebase(KB, TENANT), null);
  assert.equal(statements.filter(sql => /FROM knowledgebases kb/.test(sql)).every(sql => HIDDEN.test(sql)), true);
});

test('every /kb/:kbId route answers 404 for it and changes nothing', async t => {
  const statements = database(t);
  const controller = await import('./kb.controller.js');
  const cases: Array<[string, (req: Request, res: Response) => Promise<void>, Record<string, string>, unknown]> = [
    ['get', controller.getKb, { id: KB }, {}],
    ['update', controller.updateKb, { id: KB }, { name: 'Đổi tên' }],
    ['delete', controller.deleteKb, { id: KB }, {}],
    ['restore', controller.restoreKb, { kbId: KB }, {}],
    ['list documents', controller.listDocuments, { kbId: KB }, {}],
    ['delete document', controller.deleteDocument, { kbId: KB, docId: DOC }, {}],
    ['bulk delete', controller.bulkDeleteDocuments, { kbId: KB }, { doc_ids: [DOC] }],
    ['retry', controller.retryDocuments, { kbId: KB }, { doc_ids: [DOC] }],
    ['update article', controller.updateArticle, { kbId: KB, docId: DOC }, { title: 'Bài mới' }],
  ];
  for (const [name, handler, params, body] of cases) {
    const { req, res, out } = call(params, body);
    await handler(req, res);
    assert.equal(out.status, 404, name);
  }
  assert.equal(statements.some(sql => /^(UPDATE knowledgebases|INSERT INTO kb_operation_jobs|DELETE FROM kb_documents|UPDATE kb_documents)/
    .test(sql)), false, 'nothing was written');
  assert.equal(statements.some(sql => /SELECT .* FROM kb_documents WHERE kb_id = \$1 AND tenant_id = \$2/.test(sql)), false,
    'its documents were not listed');
});

test('a bot and the lesson-author assignment cannot use it', async t => {
  const statements = database(t);
  const bots = await import('../chat/bot.service.js');
  const chat = await import('../chat/chat.service.js');
  await assert.rejects(bots.createBot(TENANT, { name: 'Bot', kb_id: KB } as never, USER), { statusCode: 404 });
  await assert.rejects(bots.updateBot('b0000000-0000-4000-8000-000000000001', TENANT, { kb_id: KB } as never),
    { statusCode: 404 });
  await assert.rejects(chat.assignLessonAuthorKb(TENANT, KB), { statusCode: 404 });
  assert.equal(statements.some(sql => /INSERT INTO (chatbots|tenant_kb_assignments)|UPDATE chatbots/.test(sql)), false);
  assert.equal(statements.filter(sql => /SELECT kb\.id FROM knowledgebases kb/.test(sql)).length, 3);
});
