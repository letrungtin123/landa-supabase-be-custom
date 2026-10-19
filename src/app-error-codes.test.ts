import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

// The answers app.ts writes itself carry a code like every other error body
// (docs/error-codes.md): the 404 of an unknown endpoint and the demo-login and
// study-session rate limits. Status and message are unchanged.

const app = (await import('./app.js')).default;

async function serve(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Sends `count` requests one after another; the last answer. */
async function repeat(count: number, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let last: Response | undefined;
  for (let i = 0; i < count; i += 1) {
    last = await fetch(url, init);
    if (i < count - 1) await last.arrayBuffer();
  }
  return { status: last!.status, body: await last!.json() };
}

test('the 404, demo-login and study-session refusals of app.ts carry a code', async t => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const server = await serve();
  try {
    const missing = await fetch(`${server.origin}/no-such-endpoint`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      success: false,
      message: 'Endpoint không tồn tại',
      code: 'ROUTE_NOT_FOUND',
    });

    // 120 demo-login requests a minute (the 121st is refused before authentication).
    const demo = await repeat(121, `${server.origin}/api/demo-login/admin/t1/config`, {});
    assert.equal(demo.status, 429);
    assert.deepEqual(demo.body, {
      success: false,
      message: 'Quá nhiều request demo login, vui lòng thử lại sau',
      code: 'DEMO_LOGIN_RATE_LIMITED',
    });

    // 30 study-session requests a minute.
    const study = await repeat(31, `${server.origin}/api/enrollments/study-session`, { method: 'POST' });
    assert.equal(study.status, 429);
    assert.deepEqual(study.body, {
      success: false,
      message: 'Quá nhiều request study session',
      code: 'STUDY_SESSION_RATE_LIMITED',
    });
  } finally {
    await server.close();
  }
});
