import assert from 'node:assert/strict';
import test from 'node:test';
import { aiCreditState, monthBudgetUsd, monthKey, monthStart, nextMonthStart, pointsFromUsd, pointValueUsd, roundUsd } from './ai-credit.logic.js';

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
