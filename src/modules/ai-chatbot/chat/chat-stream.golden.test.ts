import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, type TestContext } from 'node:test';

// Golden characterization of one chat turn (sendMessageStream) over SSE: the
// learner, admin, AI Report and AI ID entries, both AI engines, every refusal
// and the provider failure paths. Each scenario records, in order:
// - events: the SSE events the controller writes (chunk / done / error / side events);
// - db: every SQL statement (prefix + hash of the whole text) with its parameters;
// - quota: the token reservation, its settlement (finalize + ledger) or release;
// - messages / titles: the chat rows the turn persisted;
// - gemini / rag: the provider requests (no network: fetch is faked, the AI
//   service is a loopback double), and the flow logs.
// Fakes only: pg double, fetch double, loopback AI service double; the clock is
// frozen. Regenerate (only for an intended behavior change):
//   UPDATE_CHAT_STREAM_GOLDEN=1 npx tsx --test src/modules/ai-chatbot/chat/chat-stream.golden.test.ts

const GOLDEN_FILE = new URL('./chat-stream.golden.json', import.meta.url);
const UPDATE = process.env.UPDATE_CHAT_STREAM_GOLDEN === '1';
const NOW = Date.parse('2026-10-15T03:00:00.000Z');
const FAKE_KEY = 'AIzaGoldenTestKey00000000000000000000';
const FINGERPRINT = 'hmac-sha256:v1:golden';
const BOT = 'b0000000-0000-4000-8000-000000000001';
const PERSONA = 'b0000000-0000-4000-8000-000000000002';
const COURSE = 'course-v1:Golden+chat';
const CHAPTER = 'c1000000-0000-4000-8000-000000000001';
const LESSON = 'c1000000-0000-4000-8000-000000000002';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Engine = 'gemini_file_search' | 'self_built_rag';
type Target = 'learner' | 'admin' | 'lesson_author';

interface GeminiReply {
  /** generateContent JSON body. */
  json?: Record<string, unknown>;
  /** streamGenerateContent SSE chunks. */
  stream?: Record<string, unknown>[];
  /** HTTP error status with a Gemini error body. */
  status?: number;
  message?: string;
  /** Streams `stream`, then waits for the request to be aborted. */
  hangAfterStream?: boolean;
  /** Streams `stream`, then waits for this promise before closing. */
  holdUntil?: Promise<void>;
}

interface RagReply { status?: number; json: Record<string, unknown> }

interface World {
  tenantId: string;
  userId: string;
  conversationId: string;
  engine: Engine;
  hasKey: boolean;
  /** 'all' holds every request, 'none' refuses, 'minimum' refuses the first hold only. */
  credit: 'all' | 'none' | 'minimum';
  target: Target;
  courseId: string | null;
  botKbId: string | null;
  messageCount: number;
  botConfig: Record<string, unknown>;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  storeName: string | null;
  lessonAuthorKbId: string | null;
  convCount: number;
}

interface Record_ {
  events: Json[];
  db: Json[];
  quota: Json[];
  messages: Json[];
  titles: Json[];
  gemini: Json[];
  rag: Json[];
  logs: Json[];
}

function scenarioIds(index: number) {
  const n = index.toString(16).padStart(2, '0');
  return {
    tenantId: `a10000${n}-0000-4000-8000-000000000001`,
    userId: `a20000${n}-0000-4000-8000-000000000001`,
    conversationId: `a30000${n}-0000-4000-8000-000000000001`,
    kbId: `a40000${n}-0000-4000-8000-000000000001`,
  };
}

function baseWorld(index: number, overrides: Partial<World> = {}): World {
  const ids = scenarioIds(index);
  return {
    tenantId: ids.tenantId,
    userId: ids.userId,
    conversationId: ids.conversationId,
    engine: 'gemini_file_search',
    hasKey: true,
    credit: 'all',
    target: 'learner',
    courseId: null,
    botKbId: ids.kbId,
    messageCount: 2,
    botConfig: {},
    history: [
      { role: 'user', content: 'Xin chào' },
      { role: 'assistant', content: 'Chào bạn, mình có thể giúp gì?' },
    ],
    storeName: 'fileSearchStores/golden-store',
    lessonAuthorKbId: null,
    convCount: 0,
    ...overrides,
  };
}

/** Measured with performance.now(): the only clock the frozen Date does not cover. */
const VOLATILE_KEYS = new Set(['processing_time_ms', 'processingTimeMs']);

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value, (key, item) => {
  if (VOLATILE_KEYS.has(key) && typeof item === 'number') return '<ms>';
  return item instanceof Error ? { error: item.name, message: item.message, code: (item as { code?: unknown }).code ?? null } : item;
}) ?? 'null') as Json;

/** Long texts (prompts, SQL-built JSON) as a prefix, their length and a hash: exact, but readable. */
function compact(value: Json): Json {
  if (typeof value === 'string') {
    return value.length <= 240 ? value
      : `${value.slice(0, 100)}…<${value.length} chars #${createHash('sha1').update(value).digest('hex').slice(0, 12)}>`;
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  return value;
}

function sqlLabel(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return `${flat.slice(0, 72)} #${createHash('sha1').update(flat).digest('hex').slice(0, 12)}`;
}

function maskRagBody(body: Record<string, unknown>): Json {
  return json({ ...body, ...(body.api_key ? { api_key: '<tenant key>' } : {}) });
}

const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });

let encryptedKey = '';

async function installDatabase(t: TestContext, world: World, record: Record_): Promise<void> {
  const reservations = new Map<string, { status: string; tokens: number; usd: number; params: unknown[] }>();
  let holds = 0;
  let generated = 0;
  const answer = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    record.db.push(json({ sql: sqlLabel(sql), params }));
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return rows([]);
    if (sql.includes('FROM tenant_ai_settings s')) {
      return rows([{
        tenant_id: world.tenantId, active_engine: world.engine, provider: 'google_ai_studio', token_timezone: 'Asia/Saigon',
        chat_model: 'gemini-chat-golden', lesson_author_model: 'gemini-author-golden', embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 768, transition_state: 'idle', active_transition_job_id: null,
        encrypted_api_key: world.hasKey ? encryptedKey : null, api_key_fingerprint: world.hasKey ? FINGERPRINT : null,
      }]);
    }
    if (sql.includes('FROM ai_pricing_rate_cards')) {
      return rows([{
        id: 'card', provider: params[0], model: params[1], billed_model: params[1],
        input_usd_per_1m: '0.30', cached_input_usd_per_1m: '0.03', output_usd_per_1m: '2.50', embedding_usd_per_1m: '0.15',
        input_vnd_per_1m: '0', output_vnd_per_1m: '0', embedding_vnd_per_1m: '0',
        effective_from: '2020-01-01T00:00:00.000Z', effective_to: null, source_url: null, source_note: null,
      }]);
    }
    if (/FROM ai_token_monthly_usage usage[\s\S]*FOR UPDATE OF usage/.test(sql)) return rows([{ period_start: params[1] }]);
    if (sql.includes('WITH held AS')) {
      holds += 1;
      const held = world.credit === 'all' || (world.credit === 'minimum' && holds > 1);
      record.quota.push(json({ op: 'hold', usd: params[2], held }));
      return rows([{ updated: held ? 1 : 0, present: true }]);
    }
    if (sql.includes('INSERT INTO ai_token_reservations')) {
      const id = `f0000000-0000-4000-8000-${String(reservations.size + 1).padStart(12, '0')}`;
      reservations.set(id, { status: 'reserved', tokens: Number(params[9]), usd: Number(params[16]), params });
      record.quota.push(json({
        op: 'reserve', id, target: params[3], engine: params[4], model: params[6], operation: params[7],
        tokens: params[9], input: params[10], output: params[11], embedding: params[12], max_output_tokens: params[13],
        metadata: params[14], usd: params[16],
      }));
      return rows([{ id }]);
    }
    if (/FROM ai_token_reservations\s+WHERE id = \$1 AND tenant_id = \$2 AND status = 'reserved'/.test(sql)) {
      const reservation = reservations.get(String(params[0]));
      if (!reservation || reservation.status !== 'reserved') return rows([]);
      const p = reservation.params;
      return rows([{
        id: params[0], period_start: p[8], estimated_tokens: String(reservation.tokens), user_id: p[1], conversation_id: p[2],
        target: p[3], engine: p[4], provider: p[5], model: p[6], operation: p[7], reserved_usd: String(reservation.usd),
      }]);
    }
    if (/UPDATE ai_token_reservations\s+SET status = 'finalized'/.test(sql)) {
      const reservation = reservations.get(String(params[0]));
      if (reservation) reservation.status = 'finalized';
      record.quota.push(json({ op: 'finalize', id: params[0], input: params[2], output: params[3], embedding: params[4], total: params[5] }));
      return rows([]);
    }
    if (/UPDATE ai_token_reservations\s+SET status = 'released'/.test(sql)) {
      const reservation = reservations.get(String(params[0]));
      if (reservation) reservation.status = 'released';
      record.quota.push(json({ op: 'release', id: params[0] }));
      return rows([]);
    }
    if (sql.includes('INSERT INTO ai_token_usage_ledger')) {
      record.quota.push(json({ op: 'ledger', id: params[0], cost_usd: params[19], source: params[15], metadata: params[16], feature: params[21] }));
      return rows([]);
    }
    if (/UPDATE ai_credit_monthly\s+SET used_usd/.test(sql)) {
      return rows([{ budget_usd: '100', used_usd: '0.01', warned_80: false, warned_100: false }]);
    }
    if (sql.includes('WITH conv AS')) {
      const match = params[0] === world.conversationId && params[1] === world.userId && params[2] === world.tenantId
        && (params[3] === null || params[3] === world.target);
      if (!match) return rows([]);
      return rows([{
        id: world.conversationId, tenant_id: world.tenantId, bot_id: BOT, target: world.target, course_id: world.courseId,
        bot_kb_id: world.botKbId, bot_config: world.botConfig, custom_prompt: null,
        template_prompt: 'Bạn là trợ lý học tập của doanh nghiệp.', msg_count: world.messageCount,
      }]);
    }
    if (sql.includes('FROM tenant_kb_assignments tka')) {
      return world.lessonAuthorKbId
        ? rows([{ id: 'kb-assignment', tenant_id: world.tenantId, target: 'lesson_author', kb_id: world.lessonAuthorKbId, kb_name: 'KB' }])
        : rows([]);
    }
    if (/SELECT c\.id\s+FROM courses c/.test(sql)) {
      return params[0] === world.courseId && params[1] === world.tenantId ? rows([{ id: params[0] }]) : rows([]);
    }
    if (/FROM course_blocks\s+WHERE course_id = \$1\s+AND block_type IN \('course', 'chapter', 'sequential'\)/.test(sql)) {
      return rows([
        { id: 'course-root', display_name: 'Kỹ năng giao tiếp', block_type: 'course', parent_id: null, sort_order: 0 },
        { id: CHAPTER, display_name: 'Lắng nghe', block_type: 'chapter', parent_id: 'course-root', sort_order: 1 },
        { id: LESSON, display_name: 'Lắng nghe chủ động', block_type: 'sequential', parent_id: CHAPTER, sort_order: 2 },
      ]);
    }
    if (sql.includes('WITH RECURSIVE descendants')) {
      return rows([{ display_name: 'Bài đọc', block_type: 'html', data: '<p>Lắng nghe chủ động là <b>tập trung</b> vào người nói.</p>' }]);
    }
    if (/SELECT role, content FROM chat_messages\s+WHERE conversation_id = \$1\s+ORDER BY created_at DESC LIMIT \$2/.test(sql)) {
      return rows([...world.history].reverse());
    }
    if (/FROM knowledgebases kb\s+LEFT JOIN kb_google_store kgs/.test(sql)) {
      return rows([{ restore_state: null, store_name: world.storeName, api_key_fingerprint: FINGERPRINT, remote_status: 'active', remote_error_reason: null }]);
    }
    if (/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2 AND deleted_at IS NULL/.test(sql)) {
      return params[0] === world.courseId ? rows([{ id: params[0], display_name: 'Kỹ năng giao tiếp', description: null }]) : rows([]);
    }
    if (/FROM course_blocks\s+WHERE course_id = \$1\s+AND block_type IN \('course', 'chapter', 'sequential', 'vertical'\)/.test(sql)
      || sql.includes('NULL::jsonb AS data, NULL::jsonb AS metadata')) {
      return rows([
        { id: 'course-root', display_name: 'Kỹ năng giao tiếp', block_type: 'course', parent_id: null, sort_order: 0, updated_at: '2026-10-01T00:00:00.000Z', data: null, metadata: null },
        { id: CHAPTER, display_name: 'Lắng nghe', block_type: 'chapter', parent_id: 'course-root', sort_order: 1, updated_at: '2026-10-01T00:00:00.000Z', data: null, metadata: null },
        { id: LESSON, display_name: 'Lắng nghe chủ động', block_type: 'sequential', parent_id: CHAPTER, sort_order: 2, updated_at: '2026-10-01T00:00:00.000Z', data: null, metadata: null },
      ]);
    }
    if (/AND cb\.parent_id IS NULL\s+AND cb\.block_type = 'course'/.test(sql)) {
      return rows([{ id: 'course-root', parent_id: null, block_type: 'course', display_name: 'Kỹ năng giao tiếp', sort_order: 0, updated_at: '2026-10-01T00:00:00.000Z', data: {}, metadata: {} }]);
    }
    if (/^\s*SELECT settings FROM tenants WHERE id = \$1/.test(sql)) return rows([{ settings: {} }]);
    if (sql.includes('WITH counts AS')) return rows([{ conv_count: world.convCount, persona_valid: true, assignment_valid: true }]);
    if (/^\s*INSERT INTO chat_conversations/.test(sql)) return rows([{ id: world.conversationId, course_id: params[5] }]);
    if (/^\s*INSERT INTO chat_messages/.test(sql)) {
      const role = /VALUES \(\$1, '(\w+)'/.exec(sql)?.[1] ?? 'unknown';
      record.messages.push(json({ role, content: params[1], metadata: params[2] }));
      generated += 1;
      return rows([{ id: `e1000000-0000-4000-8000-${String(generated).padStart(12, '0')}` }]);
    }
    if (/^\s*UPDATE chat_conversations/.test(sql) && /title/.test(sql)) {
      record.titles.push(json({ params }));
      return rows([]);
    }
    if (/RETURNING\s+id\b/.test(sql)) {
      generated += 1;
      return rows([{ id: `e0000000-0000-4000-8000-${String(generated).padStart(12, '0')}` }]);
    }
    if (process.env.DEBUG_CHAT_STREAM_GOLDEN) process.stderr.write(`[unmatched] ${sqlLabel(sql)}
`);
    return rows([]);
  };
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', answer);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: answer, release: () => undefined }));
}

const encoder = new TextEncoder();

function geminiStreamBody(reply: GeminiReply, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const chunks = [...(reply.stream ?? [])];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(next)}\n\n`)); return; }
      if (reply.hangAfterStream && signal) {
        await new Promise<void>((resolve) => {
          const stop = () => { controller.error(signal.reason); resolve(); };
          if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
        });
        return;
      }
      if (reply.holdUntil) await reply.holdUntil;
      controller.close();
    },
  });
}

function installFetch(t: TestContext, replies: GeminiReply[], record: Record_): void {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.hostname !== 'generativelanguage.googleapis.com') {
      record.gemini.push(json({ blocked: url.hostname }));
      throw new Error('no network in tests');
    }
    const call = url.pathname.split('/').pop() ?? '';
    record.gemini.push(json({ call, body: init.body ? JSON.parse(String(init.body)) : null }));
    const reply = replies.shift();
    if (!reply) throw new Error('unscripted Gemini call');
    if (reply.status) {
      return new Response(JSON.stringify({ error: { code: reply.status, message: reply.message ?? 'error', status: 'ERROR' } }), {
        status: reply.status, headers: { 'content-type': 'application/json' },
      });
    }
    if (reply.json) return new Response(JSON.stringify(reply.json), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(geminiStreamBody(reply, init.signal ?? undefined), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

// ── Loopback AI service double ──
let ragReplies: RagReply[] = [];
let ragRecord: Record_ | null = null;
const ragServer = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => { body += chunk; });
  request.on('end', () => {
    ragRecord?.rag.push(json({ path: request.url, body: maskRagBody(body ? JSON.parse(body) as Record<string, unknown> : {}) }));
    const reply = ragReplies.shift() ?? { status: 500, json: { detail: 'unscripted' } };
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply.json));
  });
});
await new Promise<void>((resolve) => ragServer.listen(0, '127.0.0.1', resolve));
after(() => new Promise<void>((resolve) => { ragServer.closeAllConnections(); ragServer.close(() => resolve()); }));

const { env } = await import('../../../config/env.js');
Object.assign(env as unknown as Record<string, unknown>, {
  AI_RAG_SERVICE_URL: `http://127.0.0.1:${(ragServer.address() as AddressInfo).port}`,
  AI_RAG_SERVICE_TOKEN: '',
  AI_RAG_SERVICE_HMAC_KEY_ID: 'kid-golden',
  AI_RAG_SERVICE_HMAC_SECRET: 'golden-secret-0123456789',
  GEMINI_CHAT_MODEL: 'gemini-chat-golden',
  GEMINI_LESSON_AUTHOR_MODEL: 'gemini-author-golden',
  REPORT_AI_MODEL: 'gemini-report-golden',
  LESSON_AUTHOR_GENERATION_ENABLED: false,
  LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED: false,
  AI_CHAT_ANSWER_DEADLINE_MS: 180_000,
  AI_TOKEN_RESERVATION_SECONDS: 600,
});
encryptedKey = (await import('../ai-platform/ai-secret.service.js')).encryptAiProviderKey(FAKE_KEY);
const chatService = await import('./chat.service.js');
const runtime = await import('./chat-turn-runtime.service.js');
const pricing = await import('../ai-platform/ai-pricing.service.js');

const golden: Record<string, Json> = !UPDATE && existsSync(GOLDEN_FILE)
  ? JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as Record<string, Json>
  : {};
const produced: Record<string, Json> = {};
after(() => {
  if (UPDATE) writeFileSync(GOLDEN_FILE, `${JSON.stringify(produced, null, 1)}\n`);
});

function emptyRecord(): Record_ {
  return { events: [], db: [], quota: [], messages: [], titles: [], gemini: [], rag: [], logs: [] };
}

function captureLogs(t: TestContext, record: Record_): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      // Logged once per process and minute (throttled), so it depends on the scenario order.
      if (typeof args[0] === 'string' && args[0].startsWith('[ChatStreamLock]')) return;
      record.logs.push(json([level, ...args]));
    });
  }
}

interface Turn {
  message: string;
  options: Record<string, unknown>;
  /** Aborts the client signal once the first chunk arrived. */
  abortAfterFirstChunk?: boolean;
  conversationId?: string;
  userId?: string;
}

async function runTurn(world: World, turn: Turn, record: Record_): Promise<void> {
  const client = new AbortController();
  await chatService.sendMessageStream(
    turn.conversationId ?? world.conversationId,
    turn.userId ?? world.userId,
    world.tenantId,
    turn.message,
    { correlationId: 'd0000000-0000-4000-8000-00000000c0de', ...turn.options, abortSignal: client.signal } as never,
    (text) => {
      record.events.push(json({ type: 'chunk', text }));
      if (turn.abortAfterFirstChunk && !client.signal.aborted) client.abort(new Error('chat_client_disconnected'));
    },
    () => { record.events.push(json({ type: 'done' })); },
    (err) => {
      const code = (err as { code?: string }).code;
      record.events.push(json({ type: 'error', message: err.message, ...(code ? { code } : {}) }));
    },
    (event) => { record.events.push(json(event)); },
  );
}

interface Scenario {
  world: World;
  turns: Turn[];
  gemini?: GeminiReply[];
  rag?: RagReply[];
}

async function runScenario(t: TestContext, name: string, scenario: Scenario): Promise<void> {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  runtime.rateLimitMap.clear();
  pricing.clearAiRateCardCache();
  const record = emptyRecord();
  await installDatabase(t, scenario.world, record);
  installFetch(t, [...(scenario.gemini ?? [])], record);
  ragReplies = [...(scenario.rag ?? [])];
  ragRecord = record;
  captureLogs(t, record);
  try {
    for (const turn of scenario.turns) await runTurn(scenario.world, turn, record);
  } finally {
    t.mock.restoreAll();
    ragRecord = null;
  }
  assert.equal(runtime.streamLocks.size, 0, 'every stream lock is released');
  const actual = compact(json(record));
  produced[name] = actual;
  if (!UPDATE) assert.deepStrictEqual(actual, golden[name], `golden ${name}`);
}

// ── Provider reply builders ──
const usage = (prompt: number, output: number) => ({ promptTokenCount: prompt, candidatesTokenCount: output, totalTokenCount: prompt + output });
const textChunk = (text: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }], ...extra });
const answerStream = (...texts: string[]): GeminiReply => ({
  stream: texts.map((text, index) => textChunk(text, index === texts.length - 1 ? { usageMetadata: usage(120, 30) } : {})),
});
const routerReply = (name: string, args: Record<string, unknown> = {}): GeminiReply => ({
  json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }], usageMetadata: usage(90, 5) },
});
const ragAnswer = (text: string): RagReply => ({
  json: {
    text,
    usage: { inputTokens: 200, outputTokens: 40, embeddingTokens: 8, totalTokens: 248 },
    sources: [{ document_id: 'doc-1', name: 'Tài liệu giao tiếp.pdf' }],
    retrieval: { retrieved_count: 3, returned_source_count: 1, top_score: 0.82, methods: ['dense'], reason: null },
  },
});
const blockingFilter = {
  input_filter: {
    enabled: true, enable_length: true, enable_normalize: false, enable_language: false,
    enable_gibberish: false, enable_repeat: false, enable_profanity: false,
    filter_params: { length: { min: 20, max: 2000 } },
  },
};

const learner = { target: 'learner', mode: 'chat', locale: 'vi', inputMode: 'text' };
const admin = { target: 'admin', mode: 'chat', locale: 'vi', inputMode: 'text', canAccessReports: false, reportActorRole: 'admin' };
const lessonAuthor = { target: 'lesson_author', courseId: COURSE, locale: 'vi', inputMode: 'text' };

const scenarios: Record<string, () => Scenario> = {
  learner_gemini_no_course: () => ({
    world: baseWorld(1),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
    gemini: [answerStream('Bạn hãy ', 'tập trung vào người nói.\nĐặt câu hỏi mở.')],
  }),
  learner_gemini_course_lesson_tool: () => ({
    world: baseWorld(2, { courseId: COURSE, messageCount: 0, history: [] }),
    turns: [{ message: 'Bài lắng nghe chủ động nói gì?', options: { ...learner, courseId: COURSE } }],
    gemini: [routerReply('get_lesson_content', { lesson_id: LESSON }), answerStream('Bài học nói về ', 'việc tập trung vào người nói.')],
  }),
  learner_gemini_course_direct: () => ({
    world: baseWorld(3, { courseId: COURSE }),
    turns: [{ message: 'Hôm nay thời tiết thế nào?', options: { ...learner, courseId: COURSE } }],
    gemini: [routerReply('respond_directly'), answerStream('Phân loại: Giao diện\n', 'Mình chỉ hỗ trợ nội dung khóa học.')],
  }),
  learner_rag_course: () => ({
    world: baseWorld(4, { engine: 'self_built_rag', courseId: COURSE, storeName: null }),
    turns: [{ message: 'Lắng nghe chủ động là gì?', options: { ...learner, courseId: COURSE } }],
    rag: [ragAnswer('Phân loại: Nội dung học tập\nLắng nghe chủ động là tập trung vào người nói.')],
  }),
  admin_gemini_chat: () => ({
    world: baseWorld(5, { target: 'admin', botKbId: null, storeName: null }),
    turns: [{ message: 'Gợi ý cách tạo khóa học mới', options: admin }],
    gemini: [answerStream('Bạn vào mục Khóa học ', 'rồi bấm Tạo mới.')],
  }),
  admin_rag_without_kb: () => ({
    world: baseWorld(6, { target: 'admin', engine: 'self_built_rag', botKbId: null, storeName: null }),
    turns: [{ message: 'Gợi ý cách tạo khóa học mới', options: admin }],
  }),
  ai_report_entry: () => ({
    world: baseWorld(7, { target: 'admin', engine: 'self_built_rag', botKbId: null, storeName: null, messageCount: 0, history: [] }),
    turns: [{ message: 'Báo cáo tỷ lệ hoàn thành khóa học', options: { ...admin, canAccessReports: true } }],
  }),
  ai_report_not_a_report_question: () => ({
    world: baseWorld(8, { target: 'admin', botKbId: null, storeName: null }),
    turns: [{ message: 'Cảm ơn bạn nhiều nhé', options: { ...admin, canAccessReports: true } }],
    gemini: [{ json: { candidates: [{ content: { role: 'model', parts: [{ text: 'none' }] } }], usageMetadata: usage(60, 2) } }, answerStream('Không có gì, ', 'chúc bạn một ngày tốt lành!')],
  }),
  ai_id_chat_turn_gemini: () => ({
    world: baseWorld(9, { target: 'lesson_author', courseId: COURSE, lessonAuthorKbId: 'a4000009-0000-4000-8000-0000000000aa' }),
    turns: [{ message: 'Phương pháp học tập chủ động là gì?', options: { ...lessonAuthor, mode: 'chat' } }],
    gemini: [routerReply('respond_directly'), answerStream('Học tập chủ động là ', 'người học tự làm và tự nghĩ.')],
  }),
  ai_id_chat_turn_rag: () => ({
    world: baseWorld(10, { target: 'lesson_author', engine: 'self_built_rag', courseId: COURSE, lessonAuthorKbId: 'a400000a-0000-4000-8000-0000000000aa' }),
    turns: [{ message: 'Phương pháp học tập chủ động là gì?', options: { ...lessonAuthor, mode: 'chat' } }],
    rag: [ragAnswer('Học tập chủ động là người học tự làm và tự nghĩ.')],
  }),
  ai_id_blueprint_rag_failure: () => ({
    world: baseWorld(11, { target: 'lesson_author', engine: 'self_built_rag', courseId: COURSE, messageCount: 0, lessonAuthorKbId: 'a400000b-0000-4000-8000-0000000000aa' }),
    turns: [{ message: 'Tạo bản thiết kế khóa học về kỹ năng lắng nghe', options: { ...lessonAuthor, mode: 'course_blueprint' } }],
    rag: [{ status: 502, json: { detail: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'provider down' } } }],
  }),
  ai_id_draft_rag_failure: () => ({
    world: baseWorld(12, { target: 'lesson_author', engine: 'self_built_rag', courseId: COURSE, lessonAuthorKbId: 'a400000c-0000-4000-8000-0000000000aa' }),
    turns: [{ message: 'Soạn Chương 2: Phản hồi tích cực', options: { ...lessonAuthor, mode: 'draft_lesson' } }],
    rag: [{ status: 502, json: { detail: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'provider down' } } }],
  }),
  ai_id_clarify: () => ({
    world: baseWorld(28, { target: 'lesson_author', engine: 'self_built_rag', courseId: COURSE, lessonAuthorKbId: 'a400001c-0000-4000-8000-0000000000aa' }),
    turns: [{ message: 'Sửa lại nội dung bài này giúp tôi', options: { ...lessonAuthor, mode: 'auto' } }],
  }),
  ai_id_rename_action: () => ({
    world: baseWorld(29, { target: 'lesson_author', engine: 'self_built_rag', courseId: COURSE, lessonAuthorKbId: 'a400001d-0000-4000-8000-0000000000aa' }),
    turns: [{ message: 'Đổi tên chương 1 thành "Lắng nghe sâu"', options: { ...lessonAuthor, mode: 'auto' } }],
  }),
  input_filter_refusal: () => ({
    world: baseWorld(13, { botConfig: blockingFilter }),
    turns: [{ message: 'Chào', options: learner }],
  }),
  rate_limit: () => ({
    world: baseWorld(14),
    turns: [
      { message: 'Câu hỏi thứ nhất về lắng nghe', options: learner },
      { message: 'Câu hỏi thứ hai ngay sau đó', options: learner },
    ],
    gemini: [answerStream('Trả lời ', 'câu thứ nhất.')],
  }),
  credit_limit_reached: () => ({
    world: baseWorld(15, { credit: 'none' }),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
  }),
  shorter_answer_minimum_hold: () => ({
    world: baseWorld(16, { credit: 'minimum' }),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
    gemini: [answerStream('Câu trả lời ', 'ngắn hơn.')],
  }),
  provider_retry_then_success: () => ({
    world: baseWorld(17),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
    gemini: [
      { status: 503, message: 'The model is overloaded. Please retry in 0.01s.' },
      { status: 429, message: 'RESOURCE_EXHAUSTED. Please retry in 0.01s.' },
      answerStream('Sau khi thử lại, ', 'đây là câu trả lời.'),
    ],
  }),
  provider_retries_exhausted: () => ({
    world: baseWorld(18),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
    gemini: [1, 2, 3, 4].map(() => ({ status: 429, message: 'RESOURCE_EXHAUSTED. Please retry in 0.01s.' })),
  }),
  provider_error_not_retried: () => ({
    world: baseWorld(19),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
    gemini: [{ status: 400, message: 'INVALID_ARGUMENT: request is invalid' }],
  }),
  rag_provider_error: () => ({
    world: baseWorld(20, { engine: 'self_built_rag', storeName: null }),
    turns: [{ message: 'Lắng nghe chủ động là gì?', options: learner }],
    rag: [{
      status: 502,
      json: { detail: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'provider down' }, usage: { inputTokens: 50, outputTokens: 0, embeddingTokens: 8, totalTokens: 58 } },
    }],
  }),
  client_abort_mid_stream: () => ({
    world: baseWorld(21),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner, abortAfterFirstChunk: true }],
    gemini: [{ stream: [textChunk('Câu trả lời bị dừng ')], hangAfterStream: true }],
  }),
  invalid_target: () => ({
    world: baseWorld(22),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: { ...admin } }],
  }),
  invalid_input: () => ({
    world: baseWorld(23),
    turns: [
      { message: 'Xin chào', options: learner, conversationId: 'not-a-uuid' },
      { message: '   ', options: learner },
      { message: 'x'.repeat(5001), options: learner },
    ],
  }),
  provider_key_missing: () => ({
    world: baseWorld(24, { hasKey: false }),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: learner }],
  }),
  course_not_allowed: () => ({
    world: baseWorld(25),
    turns: [{ message: 'Làm sao để lắng nghe tốt hơn?', options: { ...learner, courseId: 'course-v1:Other+course' } }],
  }),
};

for (const [name, build] of Object.entries(scenarios)) {
  test(`chat stream golden: ${name}`, async (t) => { await runScenario(t, name, build()); });
}

test('chat stream golden: a second turn on a conversation that is still answering is refused', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  runtime.rateLimitMap.clear();
  pricing.clearAiRateCardCache();
  const world = baseWorld(26);
  const record = emptyRecord();
  await installDatabase(t, world, record);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  installFetch(t, [{ stream: [textChunk('Đang trả lời ')], holdUntil: held }], record);
  captureLogs(t, record);
  try {
    const first = runTurn(world, { message: 'Câu hỏi đang được trả lời', options: learner }, record);
    while (!record.events.length) await new Promise((resolve) => setImmediate(resolve));
    await runTurn(world, { message: 'Câu hỏi gửi chồng', options: learner, userId: 'a2000026-0000-4000-8000-000000000002' }, record);
    release();
    await first;
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(runtime.streamLocks.size, 0);
  const actual = compact(json(record));
  produced.conversation_busy = actual;
  if (!UPDATE) assert.deepStrictEqual(actual, golden.conversation_busy, 'golden conversation_busy');
});

test('chat stream golden: the conversation limit refuses an eleventh conversation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const world = baseWorld(27, { convCount: 10 });
  const record = emptyRecord();
  await installDatabase(t, world, record);
  captureLogs(t, record);
  let outcome: Json = null;
  try {
    await chatService.createConversation(world.userId, world.tenantId, BOT, PERSONA, 'learner');
  } catch (error) {
    const appError = error as { message: string; statusCode?: number; code?: string };
    outcome = json({ message: appError.message, status: appError.statusCode ?? null, code: appError.code ?? null });
  } finally {
    t.mock.restoreAll();
  }
  const actual = compact(json({ outcome, db: record.db, logs: record.logs }));
  produced.conversation_limit = actual;
  if (!UPDATE) assert.deepStrictEqual(actual, golden.conversation_limit, 'golden conversation_limit');
});
