import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { buildBadgeOverview, cacheableBadgeOverview } from './badge-evaluation.logic.js';
import type { BadgeEvaluationOverview, BadgeOverviewCache } from './badge-evaluation.service.js';

// H8: the badge evaluation (GET /api/learner/badges and POST /badges/evaluate)
// reads the cached tenant rules, writes only when a badge is earned, and
// answers from the last overview while nothing it depends on changed (tenant
// badge version + the user's badge version in the key).

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000b1';
const EARNED_AT = new Date('2026-10-01T08:00:00.000Z');

const ruleRows = [
  {
    id: 'onboarding_warrior', name: 'Hồ sơ', title: 'Hồ sơ', description: 'd1', desc: 'd1', image_key: 'k1',
    card_image_url: null, icon_image_url: null, mobile_card_image_url: null, sort_order: 1,
    criteria: { version: 1, type: 'profile_any', profile_fields: ['bio'] }, rule_version: 'r1', mapped_courses: [],
  },
  {
    id: 'course_finisher', name: 'Một khóa', title: 'Một khóa', description: 'd2', desc: 'd2', image_key: 'k2',
    card_image_url: 'c.png', icon_image_url: null, mobile_card_image_url: null, sort_order: 2,
    criteria: { version: 1, type: 'completed_any_courses', threshold: 1 }, rule_version: 'r2', mapped_courses: [],
  },
];

type Facts = {
  moduleEnabled?: boolean;
  completed?: Array<{ course_id: string; enrolled_at: Date; completed_at: Date }>;
  profile?: Record<string, unknown>;
  owned?: Array<{ badge_id: string; is_shown: boolean; earned_at: Date }>;
};

async function installFakeDb(t: TestContext, facts: Facts): Promise<string[]> {
  const sqls: string[] = [];
  const state = { owned: [...(facts.owned ?? [])] };
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    if (text.includes('FROM modules m') && text.includes('tenant_modules tm')) {
      return { rows: [{ code: 'badge_management', enabled: facts.moduleEnabled !== false }], rowCount: 1 };
    }
    if (text.includes('FROM badge_definitions b')) return { rows: ruleRows, rowCount: ruleRows.length };
    if (text.includes('JOIN course_progress cp')) return { rows: facts.completed ?? [], rowCount: (facts.completed ?? []).length };
    if (text.includes('level_of_education')) return { rows: [facts.profile ?? {}], rowCount: 1 };
    if (text.includes('INSERT INTO user_badges')) {
      const candidates = JSON.parse(String(params[2])) as Array<{ badge_id: string }>;
      const rows = candidates.map((c) => ({ badge_id: c.badge_id, is_shown: false, earned_at: EARNED_AT }));
      state.owned.unshift(...rows);
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM user_badges')) {
      const ids = text.includes('ANY($2::varchar[])') ? new Set(params[1] as string[]) : null;
      const rows = state.owned.filter((row) => !ids || ids.has(row.badge_id));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return sqls;
}

function memoryCache(): BadgeOverviewCache & { versions: Map<string, number>; values: Map<string, string>; writes: number } {
  const versions = new Map<string, number>();
  const values = new Map<string, string>();
  const cache = {
    versions,
    values,
    writes: 0,
    version: async (...segments: readonly unknown[]) => String(versions.get(segments.join(':')) ?? 0),
    // JSON like Redis: Dates come back as ISO strings.
    read: async (key: string) => (values.has(key)
      ? { hit: true as const, value: JSON.parse(values.get(key)!) as BadgeEvaluationOverview }
      : { hit: false as const }),
    write: async (key: string, value: BadgeEvaluationOverview) => { cache.writes += 1; values.set(key, JSON.stringify(value)); },
  };
  return cache;
}

const definitions = ruleRows.map(({ criteria: _c, mapped_courses: _m, rule_version: _r, ...definition }) => definition);

test('the overview strips rule internals, orders popups by time then sort order, keeps only effective new badges', () => {
  const rules = ruleRows as unknown as Parameters<typeof buildBadgeOverview>[0]['rules'];
  const older = { badge_id: 'course_finisher', is_shown: false, earned_at: '2026-10-01T08:00:00.000Z' };
  const sameTime = { badge_id: 'onboarding_warrior', is_shown: false, earned_at: '2026-10-01T08:00:00.000Z' };
  const overview = buildBadgeOverview({
    rules,
    completedCourses: [],
    profile: { bio: 'x' },
    earnedRows: [older, sameTime],
    newlyEarned: [sameTime, { badge_id: 'retired_badge', is_shown: false, earned_at: '2026-10-01T08:00:00.000Z' }],
  });
  assert.deepEqual(overview.badge_definitions, definitions);
  assert.deepEqual(overview.pending_popups.map((row) => row.badge_id), ['onboarding_warrior', 'course_finisher']);
  assert.deepEqual(overview.newly_earned, [sameTime]);
  assert.deepEqual(overview.progress.onboarding_warrior, { current: 1, target: 1, percent: 100, unit_label: 'hồ sơ' });
  assert.deepEqual(cacheableBadgeOverview(overview).newly_earned, []);
  assert.equal(overview.newly_earned.length, 1, 'the original is not changed');
});

test('nothing earned: one rules load, no write, no second badge read; the next call is served from the kept overview', async (t) => {
  const sqls = await installFakeDb(t, {
    owned: [{ badge_id: 'onboarding_warrior', is_shown: true, earned_at: EARNED_AT }],
    profile: { bio: 'hello' },
  });
  const svc = await import('./badge-evaluation.service.js');
  const cache = memoryCache();

  const first = await svc.evaluateUserBadges(USER, TENANT, cache);
  assert.deepEqual(first, {
    badge_definitions: definitions,
    earned_badges: [{ badge_id: 'onboarding_warrior', is_shown: true, earned_at: EARNED_AT }],
    newly_earned: [],
    pending_popups: [],
    progress: {
      onboarding_warrior: { current: 1, target: 1, percent: 100, unit_label: 'hồ sơ' },
      course_finisher: { current: 0, target: 1, percent: 0, unit_label: 'khóa' },
    },
  });
  assert.equal(sqls.filter((sql) => sql.includes('FROM badge_definitions b')).length, 1, 'rules aggregated once (cached loader)');
  assert.equal(sqls.some((sql) => sql.includes('INSERT INTO user_badges')), false);
  assert.equal(sqls.filter((sql) => sql.includes('FROM user_badges')).length, 1);

  sqls.length = 0;
  const second = await svc.evaluateUserBadges(USER, TENANT, cache);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)), 'same answer');
  assert.deepEqual(sqls.filter((sql) => !sql.includes('FROM modules m')), [], 'no badge, profile or course query');
});

test('a bump of the user badge version or the tenant badge version evaluates again', async (t) => {
  const sqls = await installFakeDb(t, {});
  const svc = await import('./badge-evaluation.service.js');
  const cache = memoryCache();
  await svc.evaluateUserBadges(USER, TENANT, cache);

  cache.versions.set(['user', USER, 'badges'].join(':'), 1);
  sqls.length = 0;
  await svc.evaluateUserBadges(USER, TENANT, cache);
  assert.ok(sqls.some((sql) => sql.includes('JOIN course_progress cp')), 'user facts read again');

  cache.versions.set(['tenant', TENANT, 'badges'].join(':'), 1);
  sqls.length = 0;
  await svc.evaluateUserBadges(USER, TENANT, cache);
  assert.ok(sqls.some((sql) => sql.includes('JOIN course_progress cp')));
  assert.equal(cache.writes, 3);
});

test('a badge earned now is inserted once, reported as newly earned, and kept without newly_earned', async (t) => {
  const sqls = await installFakeDb(t, {
    completed: [{ course_id: 'course-v1:A+1', enrolled_at: new Date('2026-09-01T00:00:00Z'), completed_at: EARNED_AT }],
  });
  const svc = await import('./badge-evaluation.service.js');
  const cache = memoryCache();

  const first = await svc.evaluateUserBadges(USER, TENANT, cache);
  const row = { badge_id: 'course_finisher', is_shown: false, earned_at: EARNED_AT };
  assert.deepEqual(first.newly_earned, [row]);
  assert.deepEqual(first.earned_badges, [row]);
  assert.deepEqual(first.pending_popups, [row]);
  assert.equal(sqls.filter((sql) => sql.includes('INSERT INTO user_badges')).length, 1);
  assert.ok(sqls.some((sql) => sql.includes('ANY($2::varchar[])')), 'earned badges re-read after the insert');

  const second = await svc.evaluateUserBadges(USER, TENANT, cache);
  assert.deepEqual(second.newly_earned, [], 'a later read reports nothing new, like a new evaluation would');
  assert.deepEqual(second.pending_popups.map((item) => item.badge_id), ['course_finisher']);
  assert.equal(sqls.filter((sql) => sql.includes('INSERT INTO user_badges')).length, 1);
});

test('badges switched off for the tenant answer the empty overview without reading the user', async (t) => {
  const sqls = await installFakeDb(t, { moduleEnabled: false });
  const svc = await import('./badge-evaluation.service.js');
  const cache = memoryCache();
  assert.deepEqual(await svc.evaluateUserBadges(USER, TENANT, cache), svc.EMPTY_BADGE_OVERVIEW);
  assert.deepEqual(sqls.filter((sql) => !sql.includes('FROM modules m')), []);
  assert.equal(cache.writes, 0);
});
