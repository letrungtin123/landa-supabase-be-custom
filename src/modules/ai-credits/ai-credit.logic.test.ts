import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiCreditState, apportionPoints, availableMonths, buildUsageBreakdown, clampDayToMonth, monthBudgetUsd, monthKey, monthStart, nextMonthStart,
  pointsFromUsd, pointValueUsd, roundUsd,
} from './ai-credit.logic.js';

const PLAN_5M = { monthlyPriceVnd: 5_000_000, monthlyPoints: 5_000, providerCostRatio: 0.5, safetyBufferRatio: 0.1 };

test('one point is worth price x cost ratio x (1 - buffer) / FX / points of provider USD', () => {
  // 5,000,000 x 0.5 x 0.9 / 26,000 / 5,000
  assert.equal(pointValueUsd(PLAN_5M, 26_000), 0.0173076923);
  assert.equal(pointValueUsd(PLAN_5M, null), null, 'no FX rate: points cannot be valued');
  assert.equal(pointValueUsd({ ...PLAN_5M, monthlyPriceVnd: 0 }, 26_000), null, 'a free plan has no point value');
});

test('the month budget is (plan + top-up points) x point value; unlimited or unvalued plans enforce nothing', () => {
  const value = pointValueUsd(PLAN_5M, 26_000);
  assert.equal(monthBudgetUsd({ isUnlimited: false, pointValueUsd: value, planPoints: 5_000, topupPoints: 0 }), 86.538462);
  assert.equal(monthBudgetUsd({ isUnlimited: false, pointValueUsd: value, planPoints: 5_000, topupPoints: 1_000 }), 103.846154);
  assert.equal(monthBudgetUsd({ isUnlimited: true, pointValueUsd: value, planPoints: 5_000, topupPoints: 0 }), null);
  assert.equal(monthBudgetUsd({ isUnlimited: false, pointValueUsd: null, planPoints: 5_000, topupPoints: 0 }), null);
});

test('the same work costs twice the points when the provider doubles its price (owner: keep the points)', () => {
  const value = pointValueUsd(PLAN_5M, 26_000);
  assert.equal(pointsFromUsd(1.215, value), 70.2);
  assert.equal(pointsFromUsd(2.43, value), 140.4);
  assert.equal(pointsFromUsd(-1, value), 0);
  assert.equal(pointsFromUsd(1, null), null);
});

test('state: warning from 80%, exhausted when nothing is left, unlimited and unvalued never block', () => {
  const base = { isUnlimited: false, pointValueUsd: 0.01, budgetUsd: 100, reservedUsd: 0 };
  assert.deepEqual(aiCreditState({ ...base, usedUsd: 50 }), { state: 'ok', percent: 50 });
  assert.deepEqual(aiCreditState({ ...base, usedUsd: 79.9 }), { state: 'ok', percent: 79.9 });
  assert.deepEqual(aiCreditState({ ...base, usedUsd: 80 }), { state: 'warning', percent: 80 });
  assert.deepEqual(aiCreditState({ ...base, usedUsd: 90, reservedUsd: 10 }), { state: 'exhausted', percent: 100 });
  assert.deepEqual(aiCreditState({ ...base, usedUsd: 150 }), { state: 'exhausted', percent: 100 }, 'an admitted run may overdraw');
  assert.deepEqual(aiCreditState({ ...base, isUnlimited: true, usedUsd: 500 }), { state: 'unlimited', percent: null });
  assert.deepEqual(aiCreditState({ ...base, pointValueUsd: null, budgetUsd: null, usedUsd: 5 }), { state: 'unvalued', percent: null });
});

test('month helpers', () => {
  assert.equal(monthStart('2026-10-17'), '2026-10-01');
  assert.equal(monthKey('2026-10-01'), '2026-10');
  assert.equal(nextMonthStart('2026-10-01'), '2026-11-01');
  assert.equal(nextMonthStart('2026-12-01'), '2027-01-01');
  assert.equal(roundUsd(0.1234567), 0.123457);
  assert.throws(() => monthStart('bad'));
});

test('month pickers list real months only: newest first, the current month always, never a future month', () => {
  assert.deepEqual(availableMonths(['2026-08-01', '2026-10-01', '2026-08-01', '2025-12-01', '2026-11-01'], '2026-10-01'),
    ['2026-10', '2026-08', '2025-12']);
  assert.deepEqual(availableMonths([], '2026-10-01'), ['2026-10']);
  assert.equal(availableMonths(Array.from({ length: 40 }, (_, index) => `${2020 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`), '2026-10-01').length, 24);
  assert.equal(clampDayToMonth('2026-09-30', '2026-10-01'), '2026-10-01');
  assert.equal(clampDayToMonth('2026-11-01', '2026-10-01'), '2026-10-31');
  assert.equal(clampDayToMonth('2026-02-29', '2026-02-01'), '2026-02-28');
  assert.equal(clampDayToMonth('2026-10-15', '2026-10-01'), '2026-10-15');
});

test('a total of points is split over its parts so the parts add up exactly (tenths, largest remainder)', () => {
  const tenths = (values: Array<number | null>) => values.reduce<number>((sum, value) => sum + Math.round((value ?? 0) * 10), 0);
  assert.deepEqual(apportionPoints(1, [1, 1, 1]), [0.4, 0.3, 0.3]);
  assert.deepEqual(apportionPoints(0.1, [0.04, 0.04, 0.04]), [0.1, 0, 0], 'small days still add up to the total');
  assert.deepEqual(apportionPoints(null, [1, 2]), [null, null]);
  assert.deepEqual(apportionPoints(5, []), []);
  assert.deepEqual(apportionPoints(2.5, [0, 0]), [2.5, 0]);
  for (const total of [0, 0.1, 7.3, 2358.3, 99_999.9]) {
    const weights = [0.013, 0.2, 0.0001, 3.5, 0.75, 0.75, 1e-7];
    assert.equal(tenths(apportionPoints(total, weights)), Math.round(total * 10), `total ${total}`);
  }
});

test("a person's daily points add up to the person's points (same ledger rows), and so do features and days", () => {
  const pointValueUsd = 0.0173076923; // 5,000,000 VND plan, 50% / 10%, 26,000 VND per USD, 5,000 points
  const breakdown = buildUsageBreakdown({
    periodStart: '2026-10-01',
    pointValueUsd,
    features: [{ feature: 'ai_id', calls: 3, usd: 2.6 }, { feature: 'chat', calls: 40, usd: 0.4123 }],
    daily: [
      { day: '2026-10-01', feature: 'ai_id', usd: 1.1 }, { day: '2026-10-02', feature: 'ai_id', usd: 1.5 },
      { day: '2026-09-30', feature: 'chat', usd: 0.0123 }, { day: '2026-10-02', feature: 'chat', usd: 0.4 },
    ],
    users: [
      { user_key: 'u1', name: 'An', email: 'an@x.vn', deleted: false, system: false, calls: 30, usd: 2.80117 },
      { user_key: 'system', name: null, email: null, deleted: false, system: true, calls: 13, usd: 0.21113 },
    ],
    userFeatures: [
      { user_key: 'u1', feature: 'ai_id', usd: 2.6 }, { user_key: 'u1', feature: 'chat', usd: 0.20117 },
      { user_key: 'system', feature: 'chat', usd: 0.21113 },
    ],
    userDaily: [
      { day: '2026-10-01', user_key: 'u1', usd: 1.10001 }, { day: '2026-10-02', user_key: 'u1', usd: 1.70116 },
      { day: '2026-09-30', user_key: 'system', usd: 0.0123 }, { day: '2026-10-02', user_key: 'system', usd: 0.19883 },
    ],
  });
  const tenths = (value: number | null) => Math.round((value ?? 0) * 10);
  for (const user of breakdown.users) {
    const days = breakdown.user_daily.filter(item => item.user_key === user.user_key);
    assert.ok(days.length > 0);
    assert.equal(days.reduce((sum, item) => sum + tenths(item.points), 0), tenths(user.points), `${user.user_key}: days = total`);
    assert.equal(Object.values(user.features).reduce<number>((sum, value) => sum + tenths(value), 0), tenths(user.points), `${user.user_key}: features = total`);
  }
  assert.equal(breakdown.users[0]!.points, pointsFromUsd(2.80117, pointValueUsd));
  for (const feature of breakdown.features) {
    const days = breakdown.daily.filter(item => item.feature === feature.feature);
    assert.equal(days.reduce((sum, item) => sum + tenths(item.points), 0), tenths(feature.points), `${feature.feature}: days = total`);
  }
  assert.ok(breakdown.daily.every(item => item.date >= '2026-10-01' && item.date <= '2026-10-31'), 'every day is inside the month');
  assert.ok(breakdown.user_daily.every(item => item.date >= '2026-10-01'));
  assert.deepEqual(breakdown.user_daily.map(item => item.date), [...breakdown.user_daily.map(item => item.date)].sort());
  const unvalued = buildUsageBreakdown({ periodStart: '2026-10-01', pointValueUsd: null, features: [{ feature: 'chat', calls: 2, usd: 1 }],
    daily: [{ day: '2026-10-03', feature: 'chat', usd: 1 }], users: [{ user_key: 'u1', name: 'An', email: null, deleted: false, system: false, calls: 2, usd: 1 }],
    userFeatures: [{ user_key: 'u1', feature: 'chat', usd: 1 }], userDaily: [{ day: '2026-10-03', user_key: 'u1', usd: 1 }] });
  assert.equal(unvalued.users[0]!.points, null);
  assert.deepEqual(unvalued.user_daily, [{ date: '2026-10-03', user_key: 'u1', points: null }]);
  assert.deepEqual(unvalued.users[0]!.features, { chat: null });
  assert.equal(unvalued.features[0]!.calls, 2);
});
