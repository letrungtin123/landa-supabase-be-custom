import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

// H10: a tenant over its number of simultaneous chat answers gets a fast
// 429 AI_BUSY before any stream opens; a closed answer frees its slot.
// The database double never answers, so every admitted turn stays open.

const TENANT_A = 'c0000000-0000-4000-8000-00000000000a';
const TENANT_B = 'c0000000-0000-4000-8000-00000000000b';

test('chat answers over the per-tenant limit are refused at once with AI_BUSY', async (t) => {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => new Promise(() => {}));
  t.mock.method(pg.default.Pool.prototype, 'connect', () => new Promise(() => {}));
  const { env } = await import('../../../config/env.js');
  const { sendMessage } = await import('./chat.controller.js');

  const app = express();
  app.use(express.json());
  app.post('/conversations/:id/messages', (req, _res, next) => {
    const index = Number(req.get('X-Test-User'));
    req.user = {
      id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      tenantId: String(req.get('X-Test-Tenant')),
      role: 'learner',
      username: `learner-${index}`,
      sessionMode: 'normal',
    } as never;
    next();
  }, sendMessage);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  const open: http.ClientRequest[] = [];
  const send = (index: number, tenantId: string) => new Promise<{ status: number; body: string; request: http.ClientRequest }>((resolve, reject) => {
    const conversationId = `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/conversations/${conversationId}/messages`,
      headers: { 'Content-Type': 'application/json', 'X-Test-User': String(index), 'X-Test-Tenant': tenantId, 'X-UI-Locale': 'vi' },
    }, (res) => {
      if (res.statusCode === 200) { resolve({ status: 200, body: '', request }); return; }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, request }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ content: 'Xin chào', target: 'learner' }));
    open.push(request);
  });

  try {
    const limit = env.AI_CHAT_TENANT_CONCURRENCY;
    const admitted = await Promise.all(Array.from({ length: limit }, (_v, i) => send(i + 1, TENANT_A)));
    assert.ok(admitted.every((answer) => answer.status === 200), 'answers within the limit open their stream');

    const startedAt = performance.now();
    const refused = await send(100, TENANT_A);
    assert.equal(refused.status, 429);
    assert.ok(performance.now() - startedAt < 1_000, 'refused at once, never queued');
    const body = JSON.parse(refused.body) as { success: boolean; code: string; message: string };
    assert.deepEqual(body, { success: false, code: 'AI_BUSY', message: 'Trợ lý AI đang bận, vui lòng thử lại sau ít phút.' });

    assert.equal((await send(200, TENANT_B)).status, 200, 'another tenant is not affected');

    // One answer of tenant A ends (the client leaves): its slot is free again.
    admitted[0].request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await send(300, TENANT_A)).status, 200);
  } finally {
    for (const request of open) request.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
