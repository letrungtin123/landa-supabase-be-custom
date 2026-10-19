import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';

// Characterization of course authoring: every SQL statement (text without
// whitespace differences, parameters), every Storage request and the answer
// (status, body, or the error thrown) of every course-authoring handler, and
// of the service entry points other modules call (AI ID apply, publish with a
// review candidate, discard, course creation), over a matrix of bodies, block
// types and empty results. The golden file was written by the code before the
// course-authoring repositories existed; moving SQL into repositories and
// splitting the service and controller must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with
// one fixed row (or none, per case) and a recording fetch stands in for
// Supabase Storage. Rewrite the golden file only for an intended change:
//   COURSE_AUTHORING_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/course-authoring/course-authoring-sql.characterization.test.ts
// COURSE_AUTHORING_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { env } = await import('../../config/env.js');
Object.assign(env as Record<string, unknown>, {
  // Unreachable on purpose: every Storage request goes to the recording fetch below.
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_KEY: 'test-service-key',
  COURSE_PUBLISH_GOVERNANCE_ENABLED: false,
});
const { pool } = await import('../../config/database.js');
const ctrl = await import('./course-authoring.controller.js');
const svc = await import('./course-authoring.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'course-authoring-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.COURSE_AUTHORING_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.COURSE_AUTHORING_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+A1+2026';
const BLOCK = 'b0000000-0000-4000-8000-000000000001';
const BLOCK_2 = 'b0000000-0000-4000-8000-000000000002';
const PARENT = 'b0000000-0000-4000-8000-0000000000aa';
const ASSET = 'd0000000-0000-4000-8000-000000000001';
const CANDIDATE = 'e0000000-0000-4000-8000-000000000001';
const ASSET_PATH = `${TENANT}/courses/${COURSE}/1760756645000_anh.png`;
const OTHER_PATH = `${TENANT}/courses/${COURSE}/old-video.mp4`;
const KNOWN_UUIDS = new Set([TENANT, USER, BLOCK, BLOCK_2, PARENT, ASSET, CANDIDATE]);

/** One row with every column a course-authoring statement reads. */
const ROW = {
  id: BLOCK, course_id: COURSE, tenant_id: TENANT, parent_id: PARENT, block_type: 'vertical', display_name: 'Unit A',
  course_name: 'Khóa học A', parent_name: 'Bài 1', data: { html: '<p>x</p>' }, metadata: { kept: true },
  published_data: { video_url: OTHER_PATH }, published_metadata: {}, sort_order: 0, is_published: true,
  has_draft_changes: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
  max_order: 3, next_order: 2, has_pub: true, has_dirty_children: false, self_is_dirty: false,
  storage_path: ASSET_PATH, content_type: 'image/png', file_size: '2048', url: ASSET_PATH, thumbnail_url: null,
  is_locked: false, is_reference: false, date_added: '2026-10-01T00:00:00.000Z',
  cursor_created_at: '2026-10-01T00:00:00.000000Z', count: '3', reference_count: '2', description: 'Mô tả',
  notes: { version: 9 }, acquired: true, settings: null, sibling_index: 1, course_id_text: COURSE,
  policy: 'standard', already_published: false, receipt_id: 'receipt-1',
};

type Answer = (text: string, index: number, params: unknown[]) => { rows: unknown[] } | undefined;

interface Statement {
  text: string;
  params: unknown[];
}

/** Random ids (Storage reservations, ledger rows) read as one placeholder; every fixture id stays. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    typeof item === 'string'
      ? item.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => (KNOWN_UUIDS.has(id) ? id : '<random-uuid>'))
      : item,
  );
}

function installDb(t: TestContext, answer?: Answer): { statements: Statement[]; storage: string[] } {
  const statements: Statement[] = [];
  const storage: string[] = [];
  const reply = (text: string, params: unknown[]) => {
    const custom = answer?.(text, statements.length - 1, params);
    const rows = custom?.rows ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(text) ? [] : [ROW]);
    return { rows, rowCount: rows.length };
  };
  const handle = async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    // A copy, as sent: the service may push onto the same array for its next statement.
    const params = [...(typeof config === 'string' ? values : (config.values ?? []))];
    statements.push({ text, params });
    return reply(text, params);
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const request = input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
    const pathname = new URL(request.url).pathname;
    // The bucket check runs once per process; only the object requests are pinned.
    if (!pathname.startsWith('/storage/v1/bucket')) storage.push(`${request.method} ${pathname}`);
    const body = request.method === 'GET'
      ? { id: 'landa-storage', name: 'landa-storage', public: true }
      : pathname.includes('/object/') && request.method === 'DELETE'
        ? ((await request.json().catch(() => ({}))) as { prefixes?: string[] }).prefixes?.map((name) => ({ name })) ?? []
        : { Key: pathname };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  return { statements, storage };
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: unknown): FakeResponse;
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

interface CallOptions {
  role?: string;
  tenantId?: string | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
  locale?: string;
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
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
  };
  const headers: Record<string, string> = options.locale ? { 'x-ui-locale': options.locale } : {};
  const req = {
    user: {
      id: USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'staff',
      username: 'staff01',
    },
    query: options.query ?? {},
    params: { courseId: COURSE, blockId: BLOCK, unitId: BLOCK, assetId: ASSET, jobId: 'job-1', ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    ip: '203.0.113.5',
    socket: { remoteAddress: '203.0.113.5' },
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  await handler(req, res as unknown as Response);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

interface Case {
  name: string;
  run: () => Promise<unknown>;
  answer?: Answer;
  governance?: boolean;
}

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer, governance = false) =>
  cases.push({ name, run, answer, governance });
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
const both =
  (...answers: Answer[]): Answer =>
  (text, index, params) => {
    for (const answer of answers) {
      const result = answer(text, index, params);
      if (result) return result;
    }
    return undefined;
  };
/** The block lookup (getBlockInfo) answers a block of this type. */
const blockOfType = (blockType: string, extra: Record<string, unknown> = {}): Answer =>
  rowsWhen(/WITH RECURSIVE ancestors AS/, [{ ...ROW, block_type: blockType, ...extra }]);
const BLOCK_LOOKUP = /WITH RECURSIVE ancestors AS/;
/** Publish checks: no media quiz, image choice or scenario rows unless the case gives them. */
const QUIZ_ROWS = /block_type = 'la_media_quiz'|block_type::text = 'la_image_choice_quiz'|block_type::text = 'la_scenario_chat'/;
const quizFree: Answer = noRowsWhen(QUIZ_ROWS);
const publishWith = (...answers: Answer[]): Answer => both(...answers, quizFree);
/** AI ID apply: structural lookups find nothing, inserted components are listed back as written. */
function generatedStore(): Answer {
  const inserted: Array<Record<string, unknown>> = [];
  return (text, _index, params) => {
    if (/SELECT id, display_name, data, metadata\s+FROM course_blocks/.test(text)) return { rows: [] };
    if (/^\s*INSERT INTO course_blocks \(\s*course_id, parent_id, block_type, display_name,\s*data, metadata/.test(text)) {
      const row = { id: `gen-${inserted.length + 1}`, parent_id: params[1], block_type: params[2], display_name: params[3],
        data: JSON.parse(String(params[4])), metadata: params[5] };
      inserted.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/FROM course_blocks cb JOIN courses c ON c.id = cb.course_id/.test(text)) {
      return { rows: inserted.filter(row => row.parent_id === params[1]) };
    }
    return undefined;
  };
}
const H = ctrl;

// ── Outline, author notes, block reads, component permissions ──
add('outline', () => call(H.getOutline));
add('outline missing course', () => call(H.getOutline), noRowsAt(0));
add('outline tree', () => call(H.getOutline), (text) =>
  /WITH RECURSIVE active_tree/.test(text)
    ? {
        rows: [
          { ...ROW, id: 'root', parent_id: null, block_type: 'course', display_name: 'Root' },
          { ...ROW, id: 'ch-1', parent_id: 'root', block_type: 'chapter', sort_order: 1 },
          { ...ROW, id: 'seq-1', parent_id: 'ch-1', block_type: 'sequential' },
          { ...ROW, id: 'orphan', parent_id: 'gone', block_type: 'vertical' },
        ],
      }
    : undefined,
);
add('outline no course root', () => call(H.getOutline), (text) =>
  /WITH RECURSIVE active_tree/.test(text)
    ? { rows: [{ ...ROW, id: 'ch-1', parent_id: null, block_type: 'chapter' }, { ...ROW, id: 'u-1', parent_id: 'ch-1' }] }
    : undefined,
);
add('author notes', () => call(H.getAuthorNotes));
add('author notes en', () => call(H.getAuthorNotes, { locale: 'en' }), noRowsAt(0));
add('author notes no tenant', () => call(H.getAuthorNotes, { tenantId: null }));
add('author notes bad course id', () => call(H.getAuthorNotes, { params: { courseId: 'a\u0001b' } }));
add('author notes long course id', () => call(H.getAuthorNotes, { params: { courseId: 'x'.repeat(256) } }));
add('author notes missing course', () => call(H.getAuthorNotes), noRowsAt(0));
add('author notes no root', () => call(H.getAuthorNotes), noRowsAt(2));
add('block', () => call(H.getBlock));
add('block with author notes', () => call(H.getBlock), blockOfType('html', { metadata: { kept: 1, ai_author_notes: { version: 1 } } }));
add('block missing', () => call(H.getBlock), noRowsAt(0));
add('component permissions', () => call(H.getComponentPermissions));
add('component permissions no tenant', () => call(H.getComponentPermissions, { tenantId: null }));
add('component permissions no tenant row', () => call(H.getComponentPermissions), noRowsAt(0));
add('unit children', () => call(H.getUnitChildren));
add('unit children missing unit', () => call(H.getUnitChildren), noRowsAt(0));

// ── Transfers (refusals before the transfer service) ──
add('transfer targets refused for staff', () => call(H.getTransferTargets));
add('transfer targets no source', () => call(H.getTransferTargets, { role: 'superadmin' }));
add('transfer options missing ids', () => call(H.getTransferDestinationOptions, { role: 'superadmin' }));
add('transfer parents missing ids', () => call(H.getTransferDestinationParents, { role: 'superuser' }));
add('transfer create no tenant', () => call(H.createOutlineTransfer, { role: 'superadmin', tenantId: null }));
add('transfer job no tenant', () => call(H.getOutlineTransfer, { role: 'superadmin', tenantId: null }));

// ── Block creation ──
const createBody = (extra: Record<string, unknown>) => ({ course_id: COURSE, parent_id: PARENT, ...extra });
add('create vertical', () => call(H.createBlock, { body: createBody({ block_type: 'vertical' }) }));
add('create vertical en', () => call(H.createBlock, { locale: 'en', body: createBody({ block_type: 'vertical' }) }));
add('create chapter at root', () => call(H.createBlock, { body: { course_id: COURSE, block_type: 'chapter', display_name: 'Chương 1' } }));
add('create html data', () =>
  call(H.createBlock, { body: createBody({ block_type: 'html', data: '<p onclick="x()">Hi</p><script>1</script>', metadata: { a: '<b>x</b>' } }) }),
);
add('create problem boilerplate', () => call(H.createBlock, { body: createBody({ type: 'problem', boilerplate: 'multiple_choice' }) }));
add('create problem en boilerplate', () =>
  call(H.createBlock, { locale: 'en', body: createBody({ category: 'problem', boilerplate: 'checkboxes' }) }),
);
add('create problem data', () => call(H.createBlock, { body: createBody({ block_type: 'problem', data: '<problem><script>x</script></problem>' }) }));
add('create media quiz default', () => call(H.createBlock, { body: createBody({ block_type: 'la_media_quiz', boilerplate: 'media_quiz_multiple_select' }) }));
add('create media quiz data', () =>
  call(H.createBlock, {
    body: createBody({
      block_type: 'la_media_quiz',
      data: { mode: 'multiple_select', questions: [{ id: 'q1', prompt_html: '<p>Q</p>', media: { storage_path: ASSET_PATH, type: 'image' }, choices: [{ id: 'c1', html: 'A', correct: true }, { id: 'c2', html: 'B', correct: false }] }] },
      metadata: { media_quiz_mode: 'x' },
    }),
  }),
);
add('create image choice default', () => call(H.createBlock, { body: createBody({ block_type: 'la_image_choice_quiz' }) }));
add('create image choice data', () =>
  call(H.createBlock, {
    body: createBody({
      block_type: 'la_image_choice_quiz',
      data: { prompt_html: '<p>Chọn</p>', choices: [{ id: 'c1', html: 'A', correct: true, image: { storage_path: ASSET_PATH, alt: 'a' } }, { id: 'c2', html: 'B', correct: false, image: { storage_path: ASSET_PATH } }] },
    }),
  }),
);
add('create image choice foreign asset', () =>
  call(H.createBlock, {
    body: createBody({ block_type: 'la_image_choice_quiz', data: { prompt_html: 'Q', choices: [{ id: 'c1', html: 'A', correct: true, image: { storage_path: OTHER_PATH } }, { id: 'c2', html: 'B', image: { storage_path: ASSET_PATH } }] } }),
  }),
  noRowsWhen(/FROM course_assets/),
);
add('create image choice not an image', () =>
  call(H.createBlock, {
    body: createBody({ block_type: 'la_image_choice_quiz', data: { prompt_html: 'Q', choices: [{ id: 'c1', html: 'A', correct: true, image: { storage_path: ASSET_PATH } }, { id: 'c2', html: 'B', image: { storage_path: ASSET_PATH } }] } }),
  }),
  rowsWhen(/FROM course_assets/, [{ storage_path: ASSET_PATH, content_type: 'video/mp4' }]),
);
add('create image choice no tenant', () =>
  call(H.createBlock, { tenantId: null, body: createBody({ block_type: 'la_image_choice_quiz', data: { prompt_html: 'Q', choices: [{ html: 'A', correct: true }, { html: 'B' }] } }) }),
);
add('create image choice too few', () =>
  call(H.createBlock, { body: createBody({ block_type: 'la_image_choice_quiz', data: { prompt_html: 'Q', choices: [] } }) }),
);
add('create scenario chat default', () => call(H.createBlock, { locale: 'en', body: createBody({ block_type: 'la_scenario_chat' }) }));
add('create scenario chat data', () =>
  call(H.createBlock, {
    body: createBody({
      block_type: 'la_scenario_chat',
      data: { context_description: 'Bối cảnh', participant: { name: 'An' }, learner: { name: 'Bạn' }, rounds: [{ id: 'r1', scenario_message: { text: 'Chào' }, choices: [{ id: 'a', text: 'A', correct: true, response_message: 'R', explanation: 'E' }, { id: 'b', text: 'B', response_message: 'R', explanation: 'E' }, { id: 'c', text: 'C', response_message: 'R', explanation: 'E' }] }] },
    }),
  }),
);
add('create scenario chat bad round', () =>
  call(H.createBlock, { body: createBody({ block_type: 'la_scenario_chat', data: { rounds: [{ choices: [{ text: 'A' }] }] } }) }),
);
add('create crossword', () => call(H.createBlock, { body: createBody({ block_type: 'la_crossword', data: { words: [{ answer: 'ABC', clue: '<i>c</i>' }] } }) }));
add('create sortable en', () => call(H.createBlock, { locale: 'en', body: createBody({ block_type: 'la_sortable' }) }));
add('create diagram', () => call(H.createBlock, { body: createBody({ block_type: 'la_diagram' }) }));
add('create faq', () => call(H.createBlock, { body: createBody({ block_type: 'la_faq' }) }));
add('create pdf', () => call(H.createBlock, { body: createBody({ block_type: 'la_pdf' }) }));
add('create video', () => call(H.createBlock, { body: createBody({ block_type: 'video' }) }));
add('create unknown type', () => call(H.createBlock, { locale: 'en', body: createBody({ block_type: 'mystery' }) }));
add('create sequential', () => call(H.createBlock, { body: createBody({ block_type: 'sequential' }) }));
add('create with author notes', () =>
  call(H.createBlock, { body: createBody({ block_type: 'html', data: '<p>a</p>', metadata: { ai_author_notes: { version: 1 }, k: 1 } }) }),
);
add('create from parent locator', () => call(H.createBlock, { body: { parent_locator: PARENT, category: 'html' } }));
add('create parent locator missing', () => call(H.createBlock, { body: { parent_locator: PARENT, category: 'html' } }), noRowsAt(0));
add('create no course or parent', () => call(H.createBlock, { body: { block_type: 'html' } }));
add('create no type', () => call(H.createBlock, { body: { course_id: COURSE } }));
add('create course missing', () => call(H.createBlock, { body: createBody({ block_type: 'html' }) }), noRowsAt(1));
add('create parent of another course', () => call(H.createBlock, { body: createBody({ block_type: 'html' }) }), blockOfType('vertical', { course_id: 'other' }));
add('create parent missing', () => call(H.createBlock, { body: createBody({ block_type: 'html' }) }), noRowsWhen(BLOCK_LOOKUP));
add('create component not allowed', () =>
  call(H.createBlock, { body: createBody({ block_type: 'la_faq' }) }),
  rowsWhen(/SELECT settings FROM tenants/, [{ settings: { course_authoring: { allowed_component_types: ['html'] } } }]),
);
add('create audit block missing', () => call(H.createBlock, { body: createBody({ block_type: 'html' }) }), (text, index) =>
  BLOCK_LOOKUP.test(text) && index > 4 ? { rows: [] } : undefined,
);

// ── Block update: publish, discard, reorder, edit ──
add('publish', () => call(H.updateBlock, { body: { publish: 'make_public' } }), quizFree);
add('publish no draft', () => call(H.updateBlock, { body: { publish: 'make_public' } }), publishWith(blockOfType('vertical', { is_published: false })));
add('publish root block', () => call(H.updateBlock, { body: { publish: 'make_public' } }), publishWith(blockOfType('course', { parent_id: null })));
add('publish missing block', () => call(H.updateBlock, { body: { publish: 'make_public' } }), noRowsWhen(BLOCK_LOOKUP));
add('publish invalid media quiz', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type = 'la_media_quiz'/, [{ display_name: '', data: { questions: [] } }])),
);
add('publish media quiz', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type = 'la_media_quiz'/, [{ display_name: 'MQ', data: JSON.stringify({ mode: 'single_select', questions: [{ media: { storage_path: ASSET_PATH }, choices: [{ correct: true }, { correct: false }] }] }) }])),
);
add('publish media quiz two correct', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type = 'la_media_quiz'/, [{ display_name: 'MQ', data: { questions: [{ media: { storage_path: 'p' }, choices: [{ correct: true }, { correct: true }] }] } }])),
);
add('publish media quiz no media', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type = 'la_media_quiz'/, [{ display_name: 'MQ', data: { questions: [{ choices: [] }] } }])),
);
add('publish image choice', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(
    rowsWhen(/block_type::text = 'la_image_choice_quiz'/, [{ ...ROW, display_name: 'IC', data: { prompt_html: '<p>Q</p>', choices: [{ html: 'A', correct: true, image: { storage_path: ASSET_PATH } }, { html: 'B', image: { storage_path: ASSET_PATH } }] } }]),
  ),
);
add('publish image choice one choice', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type::text = 'la_image_choice_quiz'/, [{ ...ROW, display_name: '', data: { prompt_html: '<p>Q</p>', choices: [{ html: 'A', correct: true }] } }])),
);
add('publish image choice no prompt', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type::text = 'la_image_choice_quiz'/, [{ ...ROW, display_name: 'IC', data: { choices: [] } }])),
);
add('publish image choice no image', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type::text = 'la_image_choice_quiz'/, [{ ...ROW, display_name: 'IC', data: { prompt_html: 'Q', choices: [{ html: 'A', correct: true, image: {} }, { html: 'B' }] } }])),
);
add('publish scenario chat', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type::text = 'la_scenario_chat'/, [{ display_name: 'SC', data: { participant: { name: 'An' }, learner: { name: 'B' }, rounds: [{ scenario_message: { text: 'Hi' }, choices: [{ text: 'a', correct: true, response_message: 'r', explanation: 'e' }, { text: 'b', response_message: 'r', explanation: 'e' }, { text: 'c', response_message: 'r', explanation: 'e' }] }] } }])),
);
add('publish scenario chat bad round', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type::text = 'la_scenario_chat'/, [{ display_name: '', data: { participant: { name: 'An' }, learner: { name: 'B' }, rounds: [{ scenario_message: { text: 'Hi' }, choices: [{ text: 'a' }] }] } }])),
);
add('publish scenario chat no learner', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/block_type::text = 'la_scenario_chat'/, [{ display_name: 'SC', data: { participant: { name: 'An' }, rounds: [{}] } }])),
);
add('publish storage still referenced', () =>
  call(H.updateBlock, { body: { publish: 'make_public' } }),
  publishWith(rowsWhen(/WITH candidate\(storage_path\)/, [{ storage_path: OTHER_PATH }])),
);
add('publish governance off with candidate', () => call(H.updateBlock, { body: { publish: 'make_public', candidate_id: CANDIDATE } }), quizFree);
add('publish governance no policy', () => call(H.updateBlock, { body: { publish: 'make_public' } }), noRowsWhen(/course_publish_policies/), true);
add('publish governance candidate required', () => call(H.updateBlock, { body: { publish: 'make_public', candidate_id: 'nope' } }), undefined, true);
add('publish governance candidate', () => call(H.updateBlock, { body: { publish: 'make_public', candidate_id: CANDIDATE } }), undefined, true);
add('discard', () => call(H.updateBlock, { body: { publish: 'discard_changes' } }));
add('discard nothing to discard', () => call(H.updateBlock, { body: { publish: 'discard_changes' } }), blockOfType('vertical', { has_draft_changes: false }));
add('discard never published', () => call(H.updateBlock, { body: { publish: 'discard_changes' } }), rowsWhen(/AS has_pub/, [{ has_pub: false }]));
add('discard draft paths', () =>
  call(H.updateBlock, { body: { publish: 'discard_changes' } }),
  rowsWhen(/SELECT data, metadata\s+FROM course_blocks/, [{ data: { video_url: OTHER_PATH, list: [ASSET_PATH, 'x'] }, metadata: { src: ` ${ASSET_PATH} ` } }]),
);
add('patch reorder children', () => call(H.updateBlock, { body: { children: [BLOCK, BLOCK_2] } }));
add('patch reorder bad id', () => call(H.updateBlock, { body: { children: ['nope'] } }));
add('patch reorder empty', () => call(H.updateBlock, { body: { children: [] } }));
add('patch rename', () => call(H.updateBlock, { body: { display_name: 'Tên mới' } }));
add('patch rename via metadata', () => call(H.updateBlock, { body: { metadata: { display_name: 'Meta name', ai_author_notes: { x: 1 } } } }));
add('patch rename course root', () => call(H.updateBlock, { body: { display_name: 'Khóa mới' } }), blockOfType('course', { parent_id: null }));
add('patch rename course root no tenant row', () =>
  call(H.updateBlock, { body: { display_name: 'Khóa mới' } }),
  both(blockOfType('course', { parent_id: null }), rowsWhen(/UPDATE courses/, [])),
);
add('patch block vanished', () => call(H.updateBlock, { body: { display_name: 'x' } }), noRowsWhen(/^\s*UPDATE course_blocks SET updated_at/));
add('patch metadata null', () => call(H.updateBlock, { body: { metadata: null } }));
add('patch metadata media', () =>
  call(H.updateBlock, {
    body: { metadata: { problem_media: { type: 'youtube', url: 'https://youtu.be/abcdefghijk' }, html_media: { type: 'image', src: 'javascript:x' }, note: '<script>x</script>' } },
  }),
);
add('patch metadata media dropped', () => call(H.updateBlock, { body: { metadata: { problem_media: 'x', html_media: null } } }));
for (const blockType of ['html', 'problem', 'la_media_quiz', 'la_image_choice_quiz', 'la_scenario_chat', 'la_crossword', 'video']) {
  const data =
    blockType === 'html' ? '<p onclick="a()">T</p>'
    : blockType === 'problem' ? '<problem><script>x</script><p>Q</p></problem>'
    : blockType === 'la_media_quiz' ? { mode: 'single_select', questions: [{ id: 'q', media: { storage_path: ASSET_PATH, type: 'video' }, choices: [{ html: 'a', correct: true }, { html: 'b' }] }] }
    : blockType === 'la_image_choice_quiz' ? { prompt_html: 'Q', choices: [{ html: 'A', correct: true, image: { storage_path: ASSET_PATH } }, { html: 'B', image: { storage_path: ASSET_PATH } }] }
    : blockType === 'la_scenario_chat' ? { participant: { name: 'X' }, learner: { name: 'Y' }, rounds: [{ scenario_message: { text: 'Hi' }, choices: [{ text: 'a', correct: true }, { text: 'b' }, { text: 'c' }] }] }
    : { words: [{ answer: 'ab', clue: '<img src=x onerror=y>' }] };
  add(`patch data ${blockType}`, () => call(H.updateBlock, { body: { data, display_name: 'D' } }), blockOfType(blockType));
}
add('patch data image choice no tenant', () =>
  call(H.updateBlock, { tenantId: null, body: { data: { prompt_html: 'Q', choices: [{ html: 'A', correct: true }, { html: 'B' }] } } }),
  blockOfType('la_image_choice_quiz'),
);
add('patch data media quiz invalid', () => call(H.updateBlock, { body: { data: { questions: [] } } }), blockOfType('la_media_quiz'));
add('patch missing block', () => call(H.updateBlock, { body: { data: 'x' } }), noRowsWhen(BLOCK_LOOKUP));

// ── Delete, reorder, studio submit ──
add('delete block', () => call(H.deleteBlock));
add('delete block no tenant', () => call(H.deleteBlock, { tenantId: null }));
add('delete block missing', () => call(H.deleteBlock), noRowsWhen(BLOCK_LOOKUP));
add('reorder', () => call(H.reorderChildren, { body: { children: [BLOCK, BLOCK_2] } }));
add('reorder invalid body', () => call(H.reorderChildren, { body: { children: 'x' } }));
add('reorder missing parent', () => call(H.reorderChildren, { body: { children: [BLOCK] } }), noRowsWhen(BLOCK_LOOKUP));
const studio: Array<[string, Record<string, unknown>]> = [
  ['la_crossword', { display_name: 'Ô chữ', crossword_data: JSON.stringify({ words: [{ answer: 'HELLO', length: 2 }, 'x'] }), problem_media: { type: 'image', src: ASSET_PATH } }],
  ['la_crossword', { crossword_data: { words: [{ answer: '' }] }, problem_media: null }],
  ['la_crossword', { crossword_data: '{bad json' }],
  ['la_sortable', { sortable_data: JSON.stringify({ items: ['a', 'b'] }), question_text: 'Sắp xếp', problem_media: '' }],
  ['la_sortable', { sortable_data: 'not json' }],
  ['la_diagram', { diagram_data: { nodes: [{ id: 'n1', label: 'A' }], edges: [] } }],
  ['la_faq', { faq_data: JSON.stringify([{ q: 'Q', a: '<script>x</script>A' }]) }],
  ['la_pdf', { pdf_url: ASSET_PATH, display_name: 'PDF' }],
  ['html', { data: '<p>x</p>' }],
];
studio.forEach(([blockType, body], index) => {
  add(`studio submit ${blockType} ${index}`, () => call(H.studioSubmit, { body: structuredClone(body) }), blockOfType(blockType));
});
add('studio submit missing block', () => call(H.studioSubmit, { body: { a: 1 } }), noRowsWhen(BLOCK_LOOKUP));

// ── Assets ──
add('assets', () => call(H.getAssets));
add('assets page', () => call(H.getAssets, { query: { page: '2', page_size: '500', text_search: ' ảnh ' } }));
add('assets odd page', () => call(H.getAssets, { query: { page: '-3', page_size: 'x', text_search: ['a'] } }));
add('assets empty', () => call(H.getAssets), (text) => (/COUNT\(\*\)/.test(text) ? { rows: [{ count: '0' }] } : /FROM course_assets ca/.test(text) ? { rows: [] } : undefined));
add('assets more pages', () => call(H.getAssets, { query: { page_size: '1' } }), rowsWhen(/COUNT\(\*\)/, [{ count: '9' }]));
add('assets cursor first page', () => call(H.getAssets, { query: { pagination: 'cursor', page_size: '1' } }), rowsWhen(/FROM course_assets ca/, [ROW, { ...ROW, id: ASSET }]));
add('assets cursor flag', () => call(H.getAssets, { query: { cursor_pagination: '1' } }));
const cursor = Buffer.from(JSON.stringify({ created_at: '2026-10-01T00:00:00.000000Z', id: ASSET })).toString('base64url');
add('assets cursor next page', () => call(H.getAssets, { query: { cursor, text_search: 'x' } }));
add('assets cursor bad', () => call(H.getAssets, { query: { cursor: 'not-a-cursor' } }));
add('assets cursor bad id', () =>
  call(H.getAssets, { query: { cursor: Buffer.from(JSON.stringify({ created_at: '2026-10-01T00:00:00Z', id: 'x' })).toString('base64url') } }),
);
add('assets cursor date row', () =>
  call(H.getAssets, { query: { pagination: 'cursor', page_size: '1' } }),
  rowsWhen(/FROM course_assets ca/, [{ ...ROW, cursor_created_at: undefined, created_at: new Date(NOW) }, ROW]),
);
add('assets not in tenant', () => call(H.getAssets), noRowsAt(0));
add('assets no storage paths', () => call(H.getAssets), rowsWhen(/FROM course_assets ca\s+WHERE/, [{ ...ROW, storage_path: 'elsewhere/a.png' }]));
const file = (extra: Record<string, unknown> = {}) => ({
  size: 4, originalname: 'Ảnh bìa.png', mimetype: 'image/png', buffer: Buffer.from('test'), ...extra,
});
add('upload asset', () => call(H.uploadAsset, { file: file() }));
add('upload no file', () => call(H.uploadAsset));
add('upload too big', () => call(H.uploadAsset, { file: file({ size: 6 * 1024 * 1024 * 1024 }) }));
add('upload not in tenant', () => call(H.uploadAsset, { file: file() }), noRowsAt(0));
add('upload unreadable', () => call(H.uploadAsset, { file: file({ buffer: undefined }) }));
add('upload record refused', () => call(H.uploadAsset, { file: file() }), noRowsWhen(/INSERT INTO course_assets/));
add('delete asset', () => call(H.deleteAsset), noRowsWhen(/position\(\$2 in/));
add('delete asset referenced', () => call(H.deleteAsset));
add('delete asset missing', () => call(H.deleteAsset), noRowsAt(1));
add('delete asset by path', () => call(H.deleteAssetByPath, { body: { storage_path: ` ${ASSET_PATH} ` } }), noRowsWhen(/position\(\$2 in/));
add('delete asset by path alias', () => call(H.deleteAssetByPath, { body: { storagePath: ASSET_PATH } }), noRowsWhen(/position\(\$2 in/));
add('delete asset by path referenced', () => call(H.deleteAssetByPath, { body: { storage_path: ASSET_PATH } }));
add('delete asset by path nothing deleted', () =>
  call(H.deleteAssetByPath, { body: { storage_path: ASSET_PATH } }),
  noRowsWhen(/position\(\$2 in|DELETE FROM course_assets/),
);
add('delete asset by path not in tenant', () => call(H.deleteAssetByPath, { body: { storage_path: ASSET_PATH } }), noRowsAt(1));
for (const bad of ['https://evil.test/courses/a.png', 'x/no-course-dir.png', `${ASSET_PATH}"`, '', 'data:courses/', 'x'.repeat(1001)]) {
  add(`delete asset by path refused ${bad.slice(0, 24)}`, () => call(H.deleteAssetByPath, { body: { storage_path: bad } }));
}
add('asset reference', () => call(H.updateAssetReference, { body: { assetIds: [ASSET], is_reference: 1 } }));
add('asset reference empty', () => call(H.updateAssetReference, { body: { assetIds: [] } }));
add('asset reference no tenant', () => call(H.updateAssetReference, { tenantId: null, body: { assetIds: [] } }));
add('asset reference not array', () => call(H.updateAssetReference, { body: { assetIds: 'x' } }));
add('asset reference bad id', () => call(H.updateAssetReference, { body: { assetIds: ['x'] } }));
add('asset reference course missing', () => call(H.updateAssetReference, { body: { assetIds: [ASSET], is_reference: false } }), noRowsWhen(/AS course_name/));

// ── Course creation ──
add('create course', () => call(H.createCourse, { body: { display_name: ' Khóa A ', description: ' Mô tả ', org: 'Org', number: 'N1', run: '2026', start: '2026-11-01' } }));
add('create course defaults', () => call(H.createCourse, { body: { display_name: 'Khóa A', description: 'Mô tả' } }));
add('create course no name', () => call(H.createCourse, { body: { description: 'x' } }));
add('create course no description', () => call(H.createCourse, { body: { display_name: 'x', description: 7 } }));
add('create course long name', () => call(H.createCourse, { body: { display_name: 'x'.repeat(501), description: 'x' } }));
add('create course long description', () => call(H.createCourse, { body: { display_name: 'x', description: 'x'.repeat(5001) } }));

// ── Service entry points other modules call ──
const htmlUnit = { title: 'Unit 1', html: '<p>Nội dung</p>', source_fact_ids: ['f1'] };
const proposal = (extra: Record<string, unknown> = {}) => ({
  summary: 'Đề xuất',
  chapters: [{ title: 'Chương 1 (trang 1-3)', lessons: [{ title: 'Bài 1', units: [htmlUnit, { title: '', components: [{ type: 'html', title: 'Giải thích', data: '<p>Giải thích</p>' }] }] }] }],
  ...extra,
});
const applyInput = (extra: Record<string, unknown> = {}) => ({
  courseId: COURSE, tenantId: TENANT, requestedBy: USER, proposal: proposal(extra) as never, jobId: 'job-1', kbId: null,
});
const noChildren = noRowsWhen(/FROM course_blocks cb JOIN courses c ON c.id = cb.course_id|AND lower\(|display_name = \$|SELECT id, display_name, data, metadata/);
add('apply proposal', () => svc.applyLessonAuthorProposalToCourse(applyInput()), generatedStore());
add('apply proposal parity failure', () => svc.applyLessonAuthorProposalToCourse(applyInput()), noChildren);
add('apply proposal existing blocks', () => svc.applyLessonAuthorProposalToCourse(applyInput()));
add('apply proposal busy', () => svc.applyLessonAuthorProposalToCourse(applyInput()), rowsWhen(/pg_try_advisory_xact_lock/, [{ acquired: false }]));
add('apply proposal course missing', () => svc.applyLessonAuthorProposalToCourse(applyInput()), noRowsWhen(/FOR UPDATE`?$|FROM courses\s+WHERE id = \$1 AND tenant_id = \$2 AND deleted_at IS NULL\s+FOR UPDATE/));
add('apply proposal new root', () =>
  svc.applyLessonAuthorProposalToCourse(applyInput()),
  both(generatedStore(), noRowsWhen(/AND block_type = 'course'\s+AND deleted_at IS NULL\s+ORDER BY created_at ASC\s+LIMIT 1\s+FOR UPDATE/)),
);
add('apply proposal bad operation', () =>
  svc.applyLessonAuthorProposalToCourse(applyInput({ operation_plan: { operation: 'delete', target_block_id: BLOCK } })),
);
const operationPlan = (operation: string, extra: Record<string, unknown> = {}) => ({
  operation, target_block_id: BLOCK, target_path: 'chapter_1.lesson_1', target_display_name: 'Unit A',
  target_updated_at: '2026-10-02T00:00:00.000Z', target_type: 'unit', target_resolution: 'existing', requested_title: 'Tên mới', ...extra,
});
add('apply operation rename', () => svc.applyLessonAuthorProposalToCourse(applyInput({ operation_plan: operationPlan('rename') })));
add('apply operation move', () =>
  svc.applyLessonAuthorProposalToCourse(applyInput({ operation_plan: operationPlan('move', { destination_block_id: BLOCK_2 }) })),
);
add('apply operation update content', () =>
  svc.applyLessonAuthorProposalToCourse(applyInput({ operation_plan: operationPlan('update_content', { target_type: 'component' }) })),
);
add('apply operation create', () =>
  svc.applyLessonAuthorProposalToCourse(applyInput({ operation_plan: operationPlan('create', { target_type: 'lesson', target_resolution: 'new' }) })),
  generatedStore(),
);
add('publish service governance', () => svc.publishBlock(BLOCK, TENANT, { candidateId: CANDIDATE, actorId: USER }), quizFree);
add('publish service governance already published', () =>
  svc.publishBlock(BLOCK, TENANT, { candidateId: CANDIDATE, actorId: USER }),
  rowsWhen(/begin_course_publish_candidate/, [{ already_published: true, policy: 'high_risk_hse' }]),
);
add('publish service governance bad candidate', () => svc.publishBlock(BLOCK, TENANT, { candidateId: 'x', actorId: USER }));
add('publish service governance no receipt', () =>
  svc.publishBlock(BLOCK, TENANT, { candidateId: CANDIDATE, actorId: USER }),
  publishWith(rowsWhen(/finish_course_publish_candidate/, [{}])),
);
add('publish service governance no tenant', () => svc.publishBlock(BLOCK, null, { candidateId: CANDIDATE, actorId: USER }));
add('publish service no tenant filter', () => svc.publishBlock(BLOCK), quizFree);
add('discard service', () => svc.discardDraftCascade(BLOCK, TENANT));
add('initialize course structure', () => svc.initializeCourseStructure(COURSE, 'Khóa A', TENANT));
add('initialize course structure no tenant', () => svc.initializeCourseStructure(COURSE, 'Khóa A'));
add('block info no tenant filter', () => svc.getBlockInfo(BLOCK));
add('delete block service', () => svc.deleteBlock(BLOCK));
add('reorder service empty', () => svc.reorderChildren(BLOCK, [], TENANT));
add('assert course in tenant no tenant', () => svc.assertCourseInTenant(COURSE, null));
add('course audit context missing', () => svc.getCourseAuditContext(COURSE), noRowsAt(0));
add('create asset record', () => svc.createAssetRecord(COURSE, TENANT, 'a.png', 'image/png', 4, ASSET_PATH, ASSET_PATH, USER));
add('delete asset by path service', () => svc.deleteAssetByStoragePath(COURSE, TENANT, ASSET_PATH), noRowsWhen(/position\(\$2 in/));
add('update asset reference service empty', () => svc.updateCourseAssetReference(COURSE, [], true, TENANT));
add('image choice assets none', () => svc.assertImageChoiceQuizImageAssets(COURSE, TENANT, JSON.stringify({ choices: [{ image: { storage_path: ' ' } }] })));
add('create block service no parent', () => svc.createBlock(COURSE, null, 'chapter', undefined, undefined, undefined, undefined, TENANT, 'en'));
add('update block service publish flag', () => svc.updateBlock(BLOCK, { is_published: true, display_name: 'x' }));
add('update block service unpublish', () => svc.updateBlock(BLOCK, { is_published: false }));

// ── Runner ──

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
  test(`course authoring characterization: ${item.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const { statements, storage } = installDb(t, item.answer);
    const flags = env as { COURSE_PUBLISH_GOVERNANCE_ENABLED: boolean };
    flags.COURSE_PUBLISH_GOVERNANCE_ENABLED = item.governance === true;
    let result: unknown;
    try {
      result = plain(await item.run());
    } catch (error) {
      const failure = error as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
      result = { thrown: failure?.name ?? null, message: failure?.message ?? String(error), statusCode: failure?.statusCode ?? null, code: failure?.code ?? null };
    } finally {
      flags.COURSE_PUBLISH_GOVERNANCE_ENABLED = false;
    }
    const outcome = {
      statements: statements.map(s => ({ sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      storage,
      result,
    };
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
