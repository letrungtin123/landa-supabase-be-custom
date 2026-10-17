import assert from 'node:assert/strict';
import test from 'node:test';

// The learner detail modal shows a tenant's own badge names (badge management
// overrides) instead of the built-in ones, and never another tenant's.

const TENANT = '11111111-1111-4111-8111-111111111111';

test('user badges carry the tenant name override, scoped to the learner tenant', async (t) => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return {
      rows: [
        { badge_id: 'la_expert', earned_at: '2026-10-14', name_override: 'Chuyên Gia' },
        { badge_id: 'perfect_profile', earned_at: '2026-01-05', name_override: null },
      ],
      rowCount: 2,
    };
  });
  const svc = await import('./reports.service.js');

  const result = await svc.getUserBadges('learner.one', TENANT);

  assert.deepEqual(result.badges.map((b) => [b.badge_id, b.name_override]), [['la_expert', 'Chuyên Gia'], ['perfect_profile', null]]);
  assert.equal(calls.length, 1);
  const sql = calls[0].text.replace(/\s+/g, ' ');
  assert.match(sql, /LEFT JOIN tenant_badge_settings tbs ON tbs\.tenant_id = u\.tenant_id AND tbs\.badge_id = ub\.badge_id/);
  assert.match(sql, /NULLIF\(BTRIM\(tbs\.name_override\), ''\) AS name_override/);
  assert.deepEqual(calls[0].params, ['learner.one', TENANT]);
});
