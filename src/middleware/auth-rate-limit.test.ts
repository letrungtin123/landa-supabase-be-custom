import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type Request } from 'express';
import {
  API_RATE_LIMIT_MAX,
  RATE_LIMIT_ERRORS,
  apiLimiter,
  loginAccountLimiter,
  loginAccountRateLimitKey,
  refreshTokenLimiter,
  refreshTokenRateLimitKey,
} from './auth-rate-limit.js';
import { env } from '../config/env.js';

async function serve(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('account and refresh keys never contain the raw identifier or token', () => {
  const login = (username: unknown) => loginAccountRateLimitKey({ body: { username }, ip: '198.51.100.9' } as Request);
  assert.equal(login('Alice@Example.com '), login('alice@example.com'));
  assert.match(login('alice'), /^account:[0-9a-f]{40}$/);
  assert.doesNotMatch(login('alice'), /alice/);
  assert.equal(login(undefined), 'ip:198.51.100.9');

  const refresh = (refresh_token: unknown) => refreshTokenRateLimitKey({ body: { refresh_token }, ip: '198.51.100.9' } as Request);
  assert.match(refresh('11111111-2222-4333-8444-555555555555'), /^token:[0-9a-f]{40}$/);
  assert.notEqual(refresh('a'), refresh('b'));
  assert.equal(refresh(42), 'ip:198.51.100.9');
});

test('failed sign-ins are limited per account, successful ones do not count, refusal is localized', async () => {
  const app = express();
  app.use(express.json());
  app.post('/login', loginAccountLimiter, (req, res) => {
    if (req.body.password === 'right') res.json({ success: true });
    else res.status(401).json({ success: false });
  });
  const server = await serve(app);
  try {
    const limit = env.AUTH_LOGIN_ACCOUNT_MAX_FAILURES;
    for (let i = 0; i < limit * 2; i += 1) {
      assert.equal((await post(`${server.url}/login`, { username: 'success-user', password: 'right' })).status, 200);
    }
    for (let i = 0; i < limit; i += 1) {
      assert.equal((await post(`${server.url}/login`, { username: 'Victim', password: 'wrong' })).status, 401);
    }
    const blocked = await post(`${server.url}/login`, { username: 'victim', password: 'right' }, { 'X-UI-Locale': 'en' });
    assert.equal(blocked.status, 429);
    const body = await blocked.json() as { code: string; message: string };
    assert.equal(body.code, 'LOGIN_RATE_LIMITED');
    assert.equal(body.message, RATE_LIMIT_ERRORS.LOGIN_RATE_LIMITED[2]);
    // Another account from the same address is unaffected.
    assert.equal((await post(`${server.url}/login`, { username: 'someone-else', password: 'wrong' })).status, 401);
  } finally {
    await server.close();
  }
});

test('refresh has its own budget per refresh token', async () => {
  const app = express();
  app.use(express.json());
  app.post('/refresh', refreshTokenLimiter, (_req, res) => { res.status(401).json({ success: false }); });
  const server = await serve(app);
  try {
    const limit = env.AUTH_REFRESH_TOKEN_MAX_ATTEMPTS;
    for (let i = 0; i < limit; i += 1) {
      assert.equal((await post(`${server.url}/refresh`, { refresh_token: 'token-a' })).status, 401);
    }
    const blocked = await post(`${server.url}/refresh`, { refresh_token: 'token-a' });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json() as { message: string }).message, RATE_LIMIT_ERRORS.REFRESH_RATE_LIMITED[1]);
    assert.equal((await post(`${server.url}/refresh`, { refresh_token: 'token-b' })).status, 401);
  } finally {
    await server.close();
  }
});

test('the general limiter counts an auth request once even though it is mounted twice', async () => {
  const app = express();
  let counted = 0;
  app.use('/api/auth', apiLimiter, (_req, _res, next) => { counted += 1; next(); });
  app.use('/api/auth', (_req, res) => { res.json({ ok: true }); });
  app.use('/api', apiLimiter);
  app.use('/api', (_req, res) => { res.json({ ok: true }); });
  const server = await serve(app);
  try {
    const auth = await fetch(`${server.url}/api/auth/me`);
    assert.equal(counted, 1);
    const remainingAfterAuth = Number(auth.headers.get('ratelimit-remaining'));
    assert.equal(remainingAfterAuth, API_RATE_LIMIT_MAX - 1);
    const other = await fetch(`${server.url}/api/courses`);
    // Same client bucket, one hit per request.
    assert.equal(Number(other.headers.get('ratelimit-remaining')), remainingAfterAuth - 1);
  } finally {
    await server.close();
  }
});

test('with a loopback-only trust list the backend uses the address the local proxy appended', async () => {
  const app = express();
  app.set('trust proxy', ['loopback']);
  app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
  const server = await serve(app);
  try {
    const spoofed = await fetch(`${server.url}/ip`, { headers: { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' } });
    assert.equal((await spoofed.json() as { ip: string }).ip, '203.0.113.9');
  } finally {
    await server.close();
  }
});
