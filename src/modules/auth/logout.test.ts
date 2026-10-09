import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// S1 C7: POST /api/auth/logout revokes the refresh token from the body even
// when the access token is missing or already expired.

test('logout route no longer requires a valid access token', async () => {
  const { default: router } = await import('./auth.routes.js');
  const { optionalAuth, authenticate } = await import('../../middleware/authenticate.js');
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> })
    .stack.find((entry) => entry.route?.path === '/logout' && entry.route.methods.post);
  assert.ok(layer?.route);
  const handlers = layer.route.stack.map((entry) => entry.handle);
  assert.ok(handlers.includes(optionalAuth));
  assert.equal(handlers.includes(authenticate), false);
});

test('an expired bearer plus a refresh token in the body still revokes that token', async (t) => {
  const pg = await import('pg');
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: [], rowCount: 1 };
  });
  const jwt = (await import('jsonwebtoken')).default;
  const { createHash } = await import('node:crypto');
  const { env } = await import('../../config/env.js');
  const { optionalAuth } = await import('../../middleware/authenticate.js');
  const { logoutController } = await import('./auth.controller.js');

  const expired = jwt.sign(
    { sub: 'a0000000-0000-4000-8000-000000000001', tid: null, role: 'learner', username: 'l', iat: Math.floor(Date.now() / 1000) - 3_600 },
    env.JWT_SECRET,
    { expiresIn: 60 },
  );
  const req = { headers: { authorization: `Bearer ${expired}` }, body: { refresh_token: 'device-refresh-token' } } as unknown as Request;
  let body: { success?: boolean } | undefined;
  const res = { status() { return this; }, json(value: typeof body) { body = value; return this; } } as unknown as Response;

  await optionalAuth(req, res, (() => undefined) as NextFunction);
  assert.equal(req.user, undefined);
  let forwarded: unknown;
  await logoutController(req, res, ((err: unknown) => { forwarded = err; }) as NextFunction);

  assert.equal(forwarded, undefined);
  assert.equal(body?.success, true);
  const revoke = calls.find((call) => /UPDATE refresh_tokens SET revoked = true/.test(call.sql));
  assert.deepEqual(revoke?.params, [createHash('sha256').update('device-refresh-token').digest('hex')]);
});
