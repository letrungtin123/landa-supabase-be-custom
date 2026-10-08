// Transport-level tests for the AI RAG client against a local HTTP server (no AI service, no provider).
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

// Read once when the client module creates its agents; 1 s is the smallest allowed idle timeout.
process.env.AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS = '1000';

type Handler = (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void;
let handler: Handler = (_request, _body, response) => response.end('{"deleted":true}');
let connections = 0;
let closedConnections = 0;
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => { body += chunk; });
  request.on('end', () => handler(request, body, response));
});
server.keepAliveTimeout = 75_000; // like uvicorn's AI_RAG_KEEP_ALIVE_TIMEOUT_SECONDS
server.on('connection', (socket) => {
  connections += 1;
  socket.on('close', () => { closedConnections += 1; });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const { env } = await import('../../config/env.js');
// .env.development.local may point the service elsewhere; the client reads these at call time.
Object.assign(env as unknown as Record<string, unknown>, {
  AI_RAG_SERVICE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  AI_RAG_SERVICE_TOKEN: '',
  AI_RAG_SERVICE_HMAC_KEY_ID: 'kid-test',
  AI_RAG_SERVICE_HMAC_SECRET: 'test-secret-0123456789',
});
const client = await import('./ai-rag-client.service.js');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deleteDocument = () => client.deleteRagDocument({
  tenantId: '11111111-1111-4111-8111-111111111111',
  kbId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
});

test('agents keep sockets alive and idle them out below the server keep-alive', () => {
  const agents = client.createRagHttpAgents(30_000);
  for (const agent of [agents.http, agents.https]) {
    const options = (agent as unknown as { keepAlive: boolean; options: { timeout: number } });
    assert.equal(options.keepAlive, true);
    assert.equal(options.options.timeout, 30_000);
  }
  // Defaults: client 30 s < uvicorn/nginx 75 s.
  assert.ok(env.AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS < 75_000);
});

test('a socket is reused, then closed by the client after the idle timeout', async () => {
  handler = (_request, _body, response) => response.end('{"deleted":true}');
  const before = connections;
  await deleteDocument();
  await deleteDocument();
  assert.equal(connections - before, 1, 'the second request reuses the first socket');
  const closedBefore = closedConnections;
  await sleep(1_400);
  assert.ok(closedConnections > closedBefore, 'the idle socket was closed by the client');
  await deleteDocument();
  assert.equal(connections - before, 2);
});

test('a request that outlasts the idle timeout is not cut by it', async () => {
  handler = (_request, _body, response) => {
    setTimeout(() => response.end('{"deleted":true}'), 1_500);
  };
  await deleteDocument();
});

test('a transient AI failure (503 + provider code) rejects with a retryable RagServiceError', async () => {
  handler = (_request, _body, response) => {
    response.statusCode = 503;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ detail: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'AI provider tạm thời lỗi.' } }));
  };
  await assert.rejects(deleteDocument(), (error: unknown) => error instanceof client.RagServiceError
    && error.code === 'AI_PROVIDER_UNAVAILABLE' && error.statusCode === 503
    && error.message === 'AI provider tạm thời lỗi.');
});

test('deterministic index rejections keep their code and get a user-facing message', async () => {
  handler = (_request, _body, response) => {
    response.statusCode = 422;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ detail: { code: 'DOCUMENT_TYPE_UNSUPPORTED', message: 'not supported' } }));
  };
  await assert.rejects(deleteDocument(), (error: unknown) => error instanceof client.RagServiceError
    && error.code === 'DOCUMENT_TYPE_UNSUPPORTED' && error.statusCode === 422
    && error.message.startsWith('Định dạng tài liệu chưa được hỗ trợ'));
});

test('GET /v1/meta is HMAC-signed over GET and an empty body', async () => {
  const meta = { service: 'landa-ai-rag', build_sha: 'abc123', contracts: { ...client.EXPECTED_RAG_SERVICE_CONTRACTS },
    schema_check: { status: 'ok' } };
  let seen: http.IncomingMessage | null = null;
  handler = (request, body, response) => {
    seen = request;
    assert.equal(body, '');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(meta));
  };
  assert.deepEqual(await client.fetchRagServiceMeta(), meta);
  const request = seen as unknown as http.IncomingMessage;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/v1/meta');
  assert.equal(request.headers['content-length'], undefined);
  const timestamp = String(request.headers['x-landa-timestamp']);
  const canonical = `${timestamp}\nGET\n/v1/meta\n${createHash('sha256').update('').digest('hex')}`;
  assert.equal(request.headers['x-landa-signature'],
    createHmac('sha256', 'test-secret-0123456789').update(canonical).digest('hex'));
});

test('the index request carries the signed source URL only when there is one', () => {
  const input = { tenantId: 't', kbId: 'k', documentId: 'd', embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: 768 };
  assert.equal('source_download_url' in client.buildRagIndexRequestBody(input, 'key'), false);
  assert.equal('source_download_url' in client.buildRagIndexRequestBody({ ...input, sourceDownloadUrl: null }, 'key'),
    false);
  assert.deepEqual(client.buildRagIndexRequestBody({ ...input, sourceDownloadUrl: 'https://s/x?token=t' }, 'key'), {
    api_key: 'key', tenant_id: 't', kb_id: 'k', document_id: 'd', embedding_model: 'gemini-embedding-001',
    embedding_dimensions: 768, source_download_url: 'https://s/x?token=t',
  });
});

test('meta comparison flags contract drift, an unready schema and a malformed sha', () => {
  const contracts = { ...client.EXPECTED_RAG_SERVICE_CONTRACTS };
  assert.deepEqual(client.compareRagServiceMeta({ build_sha: 'abc', contracts, schema_check: { status: 'ok' } }),
    { buildSha: 'abc', schemaStatus: 'ok', mismatches: [] });
  assert.deepEqual(client.compareRagServiceMeta({ build_sha: 'x y', contracts: { ...contracts, idm_contract_version: 2 },
    schema_check: { status: 'failed' } }), { buildSha: 'unknown', schemaStatus: 'failed',
    mismatches: ['idm_contract_version'] });
  assert.equal(client.compareRagServiceMeta(null).mismatches.length,
    Object.keys(client.EXPECTED_RAG_SERVICE_CONTRACTS).length);
});

test('the startup meta log warns but never throws', async () => {
  const lines: Array<[string, string]> = [];
  const log = { log: (...parts: unknown[]) => lines.push(['log', parts.join(' ')]),
    warn: (...parts: unknown[]) => lines.push(['warn', parts.join(' ')]) };
  const contracts = { ...client.EXPECTED_RAG_SERVICE_CONTRACTS };
  await client.logRagServiceMetaOnce(log, async () => ({ build_sha: 'abc', contracts, schema_check: { status: 'ok' } }));
  await client.logRagServiceMetaOnce(log, async () => ({ contracts: {}, schema_check: { status: 'ok' } }));
  await client.logRagServiceMetaOnce(log, async () => ({ contracts, schema_check: { status: 'pending' } }));
  await client.logRagServiceMetaOnce(log, async () => { throw new client.RagServiceError('x', 503, 'NOT_READY'); });
  await client.logRagServiceMetaOnce(log, async () => { throw new Error('boom'); });
  assert.deepEqual(lines.map(([level, text]) => [level, JSON.parse(text.replace('[AiRagMeta] ', '')).event]), [
    ['log', 'ai_rag_meta'], ['warn', 'ai_rag_meta_mismatch'], ['warn', 'ai_rag_meta_schema_not_ready'],
    ['warn', 'ai_rag_meta_unavailable'], ['warn', 'ai_rag_meta_unavailable'],
  ]);
  assert.equal(JSON.parse(lines[3][1].replace('[AiRagMeta] ', '')).code, 'NOT_READY');
});
