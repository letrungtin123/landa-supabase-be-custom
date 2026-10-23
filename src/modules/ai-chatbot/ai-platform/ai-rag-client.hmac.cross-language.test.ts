// HMAC v2 across the languages (security audit 2026-10-24, M1): the requests the AI RAG client really sends
// (captured by a local HTTP server, no AI service, no provider) are checked by the auth dependency of every
// /v1 route of the sibling landa-ai-rag (app/api/deps.py require_internal_token), with the same key pair.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { AI_RAG_DEV_PYTHON, AI_RAG_ROOT, aiRagSkip } from '../../../test-support/ai-rag-python.js';

const SKIP = aiRagSkip('app/api/deps.py', 'app/core/security.py');
const KEY_ID = 'kid-cross-language';
const SECRET = 'cross-language-secret-0123456789abcdef';

interface CapturedRequest { method: string; path: string; headers: Record<string, string>; body: Buffer }

const captured: CapturedRequest[] = [];
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const headers = Object.fromEntries(Object.entries(request.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    captured.push({ method: request.method ?? '', path: new URL(request.url ?? '/', 'http://x').pathname, headers,
      body: Buffer.concat(chunks) });
    response.setHeader('Content-Type', 'application/json');
    response.end('{"deleted":true}');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const { env } = await import('../../../config/env.js');
Object.assign(env as unknown as Record<string, unknown>, {
  AI_RAG_SERVICE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  AI_RAG_SERVICE_TOKEN: '',
  AI_RAG_SERVICE_HMAC_KEY_ID: KEY_ID,
  AI_RAG_SERVICE_HMAC_SECRET: SECRET,
});
const client = await import('./ai-rag-client.service.js');
const { postRagJson } = await import('./ai-rag-client.transport.js');

const VERIFY_SOURCE = `
import asyncio, base64, json, sys
from starlette.requests import Request
from app.api.deps import require_internal_token
from app.core.errors import AppError

def build(case):
    body = base64.b64decode(case["body"])
    sent = False

    async def receive():
        nonlocal sent
        chunk, sent = (b"" if sent else body), True
        return {"type": "http.request", "body": chunk, "more_body": False}

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": case["method"],
             "scheme": "http", "path": case["path"], "raw_path": case["path"].encode(), "query_string": b"",
             "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in case["headers"].items()],
             "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8010)}
    return Request(scope, receive)

async def verdict(case):
    try:
        await require_internal_token(build(case))
        return "accepted"
    except AppError as error:
        return "rejected %s %s" % (error.http_status, error.code)

async def main():
    cases = json.loads(sys.stdin.read())
    sys.stdout.write("\\n" + json.dumps([await verdict(case) for case in cases]))

asyncio.run(main())
`;

/**
 * The verdict of the AI service's auth for each request, in order, in one process (one replay cache), with v1
 * signatures accepted (the transition default) or not.
 */
function pythonVerdicts(requests: CapturedRequest[], acceptV1: boolean): string[] {
  // Only this test's auth settings reach the AI settings (env_file=None): AI_RAG_* of the shell are dropped.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_RAG_')));
  const out = spawnSync(AI_RAG_DEV_PYTHON, ['-X', 'utf8', '-B', '-c', VERIFY_SOURCE], {
    cwd: AI_RAG_ROOT,
    input: JSON.stringify(requests.map(request => ({ ...request, body: request.body.toString('base64') }))),
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000,
    env: { ...inherited, PYTHONIOENCODING: 'utf-8', AI_RAG_AUTH_MODE: 'hmac', AI_RAG_SERVICE_TOKEN: '',
      AI_RAG_SERVICE_HMAC_SECRETS: `${KEY_ID}:${SECRET}`, AI_RAG_HMAC_ACCEPT_V1_SIGNATURE: String(acceptV1) },
  });
  assert.equal(out.status, 0, out.error?.message ?? out.stderr);
  const lines = out.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as string[];
}

const withHeaders = (request: CapturedRequest, headers: Record<string, string | null>): CapturedRequest => ({
  ...request,
  headers: Object.fromEntries(Object.entries({ ...request.headers, ...headers })
    .filter((entry): entry is [string, string] => entry[1] !== null)),
});

test('the AI service accepts the v2 requests the client sends, and refuses replays and changed requests',
  { skip: SKIP, timeout: 180_000 }, async () => {
    const remove = (documentId: string) => client.deleteRagDocument({
      tenantId: '11111111-1111-4111-8111-111111111111', kbId: '22222222-2222-4222-8222-222222222222', documentId });
    await remove('33333333-3333-4333-8333-333333333331');
    await remove('33333333-3333-4333-8333-333333333332');
    await remove('33333333-3333-4333-8333-333333333333');
    await remove('33333333-3333-4333-8333-333333333334');
    await client.fetchRagServiceMeta();
    // Multi-byte text (Vietnamese, astral) is signed over the UTF-8 bytes on the wire.
    await postRagJson('/v1/chat', { tenant_id: 't-1', question: 'Xin chào, an toàn lao động 😀' });
    const [first, second, third, fourth, meta, vietnamese] = captured;
    assert.equal(captured.length, 6);
    for (const request of captured) {
      assert.equal(request.headers['x-landa-signature-version'], '2');
      assert.equal(request.headers['x-landa-key-id'], KEY_ID);
    }
    assert.equal(meta!.method, 'GET');
    assert.equal(meta!.body.length, 0);
    assert.ok(vietnamese!.body.length > vietnamese!.body.toString('utf8').length);

    const requests = [
      first!,
      first!, // the same request again: its request id is spent
      withHeaders(second!, { 'x-landa-request-id': randomUUID() }), // M1: a captured request under a fresh id
      second!,
      { ...third!, body: Buffer.from(third!.body.toString('utf8').replace('333333333333', '333333333339')) },
      withHeaders(third!, { 'x-landa-key-id': 'kid-other' }),
      withHeaders(fourth!, { 'x-landa-signature-version': null }), // read as v1: the v2 signature does not match
      withHeaders(fourth!, { 'x-landa-signature-version': null, 'x-landa-request-id': randomUUID() }),
      withHeaders(fourth!, { 'x-landa-signature-version': '3' }),
      fourth!, // accepted: the refusals above did not spend its request id
      meta!,
      vietnamese!,
    ];
    const refused = 'rejected 401 UNAUTHORIZED';
    // While v1 is still accepted, a captured v2 request cannot be replayed as v1 either.
    for (const acceptV1 of [false, true]) {
      assert.deepEqual(pythonVerdicts(requests, acceptV1), [
        'accepted', refused,
        refused, 'accepted',
        refused, refused,
        refused, refused, refused, 'accepted',
        'accepted',
        'accepted',
      ], `v1 accepted: ${acceptV1}`);
    }
  });
