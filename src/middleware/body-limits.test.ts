import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { useJsonBodyParsers } from './body-limits.js';
import { errorHandler } from './error-handler.js';

// T11: small JSON limits before authentication on sign-in and learner routes;
// every other route keeps 10 MB. Too large is a plain 413, not a 500.

async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  useJsonBodyParsers(app);
  app.use((req, res) => { res.json({ size: JSON.stringify(req.body ?? null).length }); });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const body = (bytes: number) => JSON.stringify({ padding: 'x'.repeat(bytes) });
const send = (url: string, method: string, bytes: number) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body(bytes) });

test('sign-in routes accept their usual bodies and refuse more than 100 KB with 413', async () => {
  const server = await serve();
  try {
    const ok = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'staff@example.com', password: 'secret', client_app: 'learner', origin: 'https://learn.example.com' }),
    });
    assert.equal(ok.status, 200);
    for (const path of ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/ott/exchange', '/api/sso/exchange/google', '/API/AUTH/LOGIN']) {
      const refused = await send(`${server.url}${path}`, 'POST', 150_000);
      assert.equal(refused.status, 413, path);
      assert.deepEqual(await refused.json(), {
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Dữ liệu gửi lên quá lớn. Vui lòng gửi ít nội dung hơn.',
      });
    }
  } finally {
    await server.close();
  }
});

test('learner routes take up to 1 MB; other routes keep the 10 MB limit', async () => {
  const server = await serve();
  try {
    assert.equal((await send(`${server.url}/api/learner/complete-blocks`, 'POST', 600_000)).status, 200);
    assert.equal((await send(`${server.url}/api/learner/complete-blocks`, 'POST', 1_500_000)).status, 413);
    assert.equal((await send(`${server.url}/api/enrollments/study-session`, 'POST', 1_500_000)).status, 413);
    // Not proven small: the profile (free-text bio) and authoring routes keep 10 MB.
    assert.equal((await send(`${server.url}/api/auth/profile`, 'PATCH', 500_000)).status, 200);
    assert.equal((await send(`${server.url}/api/course-authoring/blocks`, 'POST', 3_000_000)).status, 200);
    assert.equal((await send(`${server.url}/api/course-authoring/blocks`, 'POST', 11_000_000)).status, 413);
  } finally {
    await server.close();
  }
});
