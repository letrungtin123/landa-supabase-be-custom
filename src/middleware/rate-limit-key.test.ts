import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { signAccessToken } from '../utils/jwt.js';
import { authenticatedUserOrIpRateLimitKey } from './rate-limit-key.js';

function requestFor(headers: Record<string, string>, ip = '198.51.100.41'): Request {
  return { headers, ip } as unknown as Request;
}

test('uses a verified access-token subject as the API limiter key', () => {
  const token = signAccessToken({
    sub: '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
    tid: 'f5a7f6de-bf74-4ea6-8e0e-bd7da7dd6c26',
    role: 'superuser',
    username: 'rate-limit-test',
  });

  assert.equal(
    authenticatedUserOrIpRateLimitKey(requestFor({ authorization: `Bearer ${token}` })),
    'user:2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
  );
});

test('falls back to the proxy-resolved IP when the token is absent or invalid', () => {
  assert.equal(authenticatedUserOrIpRateLimitKey(requestFor({})), 'ip:198.51.100.41');
  assert.equal(
    authenticatedUserOrIpRateLimitKey(requestFor({ authorization: 'Bearer invalid-token' })),
    'ip:198.51.100.41',
  );
});
