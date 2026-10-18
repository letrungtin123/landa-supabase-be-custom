import assert from 'node:assert/strict';
import test from 'node:test';
import type { RedisClientType } from '@redis/client';

// The report PDF export limit is shared by every API process through Redis,
// with commands and keys the production ACL allows (no MULTI, keys under
// landa-backend:*). Fake Redis client; no network.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('../../../config/redis.js');
const { consumeReportPdfExportAllowance } = await import('./report-pdf-rate-limit.service.js');

test('counters are plain INCR + EXPIRE under the backend prefix, shared by every process', async () => {
  const counts = new Map<string, number>();
  const commands: string[] = [];
  redis.installRedisClient({
    isOpen: true,
    isReady: true,
    async incr(key: string) { commands.push('INCR'); counts.set(key, (counts.get(key) ?? 0) + 1); return counts.get(key)!; },
    async expire() { commands.push('EXPIRE'); return 1; },
    multi() { throw new Error('MULTI is refused by the production ACL'); },
  } as unknown as RedisClientType);
  const actor = { tenantId: 'a0000000-0000-4000-8000-000000000001', userId: 'b0000000-0000-4000-8000-000000000001' };
  const options = { userLimit: 2, tenantLimit: 100, nowMs: 1_700_000_000_000 };
  assert.equal((await consumeReportPdfExportAllowance(actor, options)).allowed, true);
  assert.equal((await consumeReportPdfExportAllowance(actor, options)).allowed, true, 'e.g. a second API process');
  const third = await consumeReportPdfExportAllowance(actor, options);
  assert.deepEqual([third.allowed, third.scope], [false, 'user']);
  assert.ok([...counts.keys()].every((key) => key.startsWith('landa-backend:')), [...counts.keys()].join(', '));
  assert.ok(!commands.includes('MULTI'));
  redis.installRedisClient(null);
});
