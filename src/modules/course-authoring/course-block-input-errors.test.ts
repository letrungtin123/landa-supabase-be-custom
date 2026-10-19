import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { Request, RequestHandler, Response } from 'express';

// Invalid component data is a client error: creating or editing a media quiz,
// image-choice question or scenario conversation, and saving a diagram from the
// studio, answer 400 with the sanitizer's own message and the code
// COURSE_BLOCK_DATA_INVALID (docs/error-codes.md), never a 500. Served over
// HTTP: the course-authoring handlers behind a stand-in for authentication
// and the real global error handler. A pg double answers the block reads; no
// statement after the refusal writes anything.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const express = (await import('express')).default;
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./course-authoring.controller.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+A1+2026';
const BLOCK = 'b0000000-0000-4000-8000-000000000001';
const PARENT = 'b0000000-0000-4000-8000-0000000000aa';
const ASSET_PATH = `${TENANT}/courses/${COURSE}/a.png`;
const CODE = 'COURSE_BLOCK_DATA_INVALID';

interface Statement {
  sql: string;
}

/** Block reads answer a block of the given type; writes are recorded. */
function installDb(t: TestContext, blockType: string): Statement[] {
  const statements: Statement[] = [];
  const handle = async (config: string | { text: string }) => {
    const sql = typeof config === 'string' ? config : config.text;
    statements.push({ sql });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET)/i.test(sql)) return { rows: [], rowCount: 0 };
    const row = {
      id: BLOCK, course_id: COURSE, course_name: 'Khóa học', parent_id: PARENT, parent_name: 'Unit', block_type: blockType,
      display_name: 'Block', data: {}, metadata: {}, sort_order: 0, is_published: false, has_draft_changes: true,
      created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    };
    return { rows: [row], rowCount: 1 };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  return statements;
}

/** Express 5 forwards a rejected handler to the error handler; this does the same explicitly. */
function route(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

async function serve(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: USER, tenantId: TENANT, role: 'staff', username: 'staff01' } as never;
    next();
  });
  app.post('/api/course-authoring/blocks', route(ctrl.createBlock));
  app.patch('/api/course-authoring/blocks/:blockId', route(ctrl.updateBlock));
  app.post('/api/course-authoring/blocks/:blockId/handler/studio_submit', route(ctrl.studioSubmit));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/course-authoring`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function send(url: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function refused(message: string) {
  return { status: 400, body: { success: false, message, code: CODE } };
}

/** Nothing was written: only block reads (and a rolled-back transaction) ran. */
function assertNoWrite(statements: Statement[]): void {
  const writes = statements.filter(s => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql) || /^\s*COMMIT/i.test(s.sql));
  assert.deepEqual(writes, [], 'no write and no commit');
}

const create = (blockType: string, data: unknown) => ({ course_id: COURSE, parent_id: PARENT, block_type: blockType, data });

test('media quiz data a sanitizer refuses answers 400 on create and edit', async t => {
  const statements = installDb(t, 'la_media_quiz');
  const server = await serve();
  try {
    assert.deepEqual(
      await send(`${server.origin}/blocks`, 'POST', create('la_media_quiz', { questions: [] })),
      refused('Câu hỏi kèm media cần ít nhất một câu hỏi'),
    );
    assert.deepEqual(
      await send(`${server.origin}/blocks/${BLOCK}`, 'PATCH', {
        data: { questions: [{ media: { storage_path: ASSET_PATH, type: 'image' }, choices: [{ html: 'A', correct: true }] }] },
      }),
      refused('Câu hỏi 1 cần ít nhất hai lựa chọn'),
    );
    // A string that is not JSON is not an object either.
    assert.deepEqual(
      await send(`${server.origin}/blocks`, 'POST', create('la_media_quiz', '{not json')),
      refused('Dữ liệu câu hỏi kèm media phải là object'),
    );
    assertNoWrite(statements);
  } finally {
    await server.close();
  }
});

test('image-choice data a sanitizer refuses answers 400 on create and edit', async t => {
  const statements = installDb(t, 'la_image_choice_quiz');
  const server = await serve();
  try {
    const oneChoice = { prompt_html: '<p>Chọn</p>', choices: [{ html: 'A', correct: true, image: { storage_path: ASSET_PATH } }] };
    assert.deepEqual(
      await send(`${server.origin}/blocks`, 'POST', create('la_image_choice_quiz', oneChoice)),
      refused('Câu hỏi đáp án hình ảnh phải có từ 2 đến 4 đáp án'),
    );
    assert.deepEqual(
      await send(`${server.origin}/blocks/${BLOCK}`, 'PATCH', { data: { choices: [] } }),
      refused('Câu hỏi đáp án hình ảnh cần nội dung câu hỏi'),
    );
    assertNoWrite(statements);
  } finally {
    await server.close();
  }
});

test('scenario conversation data a sanitizer refuses answers 400 on create and edit', async t => {
  const statements = installDb(t, 'la_scenario_chat');
  const server = await serve();
  try {
    assert.deepEqual(
      await send(`${server.origin}/blocks`, 'POST', create('la_scenario_chat', { rounds: [{ choices: [{ text: 'A' }] }] })),
      refused('Lượt 1 phải có đúng 3 câu trả lời'),
    );
    assert.deepEqual(
      await send(`${server.origin}/blocks/${BLOCK}`, 'PATCH', { data: { rounds: [] } }),
      refused('Giao tiếp tình huống cần ít nhất một lượt hội thoại'),
    );
    assertNoWrite(statements);
  } finally {
    await server.close();
  }
});

test('diagram data the normalizer refuses answers 400 on studio submit', async t => {
  const statements = installDb(t, 'la_diagram');
  const server = await serve();
  try {
    assert.deepEqual(
      await send(`${server.origin}/blocks/${BLOCK}/handler/studio_submit`, 'POST', { diagram_data: { nodes: [] } }),
      refused('Dữ liệu biểu đồ phải có danh sách diagrams.'),
    );
    assert.deepEqual(
      await send(`${server.origin}/blocks/${BLOCK}/handler/studio_submit`, 'POST', { diagram_data: '{not json' }),
      refused('Dữ liệu biểu đồ không phải JSON hợp lệ.'),
    );
    assertNoWrite(statements);
  } finally {
    await server.close();
  }
});
