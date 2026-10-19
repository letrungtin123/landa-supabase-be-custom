import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  failWhen,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the badge settings routes (/api/badges) and of the
// badge evaluation entry points other modules call: every SQL statement,
// every Storage request and the answer (src/test-support/
// sql-characterization.ts). The golden file was written by the code before
// the badges repositories existed; moving SQL into repositories must keep
// every entry equal. Rewrite it only for an intended change:
//   BADGES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/badges/badges-sql.characterization.test.ts
// BADGES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  storageRequests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', Key: 'k', path: 'p' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./badges.controller.js');
const evaluation = await import('./badge-evaluation.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const LEARNER = 'a0000000-0000-4000-8000-000000000002';
const BADGE = 'course_finisher';
const COURSE = 'course-v1:Landa+C1+2026';
const CARD_PATH = `${TENANT}/branding/badges/${BADGE}/card-1.png`;

/** One row with every column a badges statement reads. */
const ROW = {
  id: BADGE, name: 'Hoàn thành khóa', title: 'Hoàn thành khóa', description: 'Mô tả', desc: 'Mô tả',
  default_name: 'Hoàn thành khóa', default_description: 'Mô tả', name_override: null, description_override: null,
  image_key: 'finisher', card_image_url: CARD_PATH, icon_image_url: null, mobile_card_image_url: null, is_active: true,
  image_url: CARD_PATH, enabled: true, is_enabled: true, sort_order: '2', code: 'badge_management',
  criteria: { version: 1, type: 'completed_any_courses', threshold: 1 }, rule_version: '2026-10-01 00:00:00+07',
  mapped_courses: [], course_id: COURSE, enrolled_at: '2026-02-01T00:00:00.000Z', completed_at: '2026-03-01T00:00:00.000Z',
  bio: 'bio', gender: 'male', country: 'VN', language: 'vi', level_of_education: 'bachelor', year_of_birth: 1990,
  phone: '0900', avatar_url: null, badge_id: BADGE, is_shown: false, earned_at: '2026-03-01T00:00:00.000Z',
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const IMAGE = { originalname: 'card.png', mimetype: 'image/png', size: PNG.length, buffer: PNG };

interface CallOptions {
  role?: string;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: { id: USER, tenantId: null, role: options.role ?? 'superadmin', username: 'root', sessionMode: 'normal' },
    query: {},
    params: { tenantId: TENANT, badgeId: BADGE, ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    originalUrl: `/api/badges/tenants/${TENANT}`,
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

/** An overview cache that never has the overview (every call evaluates). */
const missCache = {
  version: async () => 'v1',
  read: async () => ({ hit: false as const }),
  write: async () => undefined,
};

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const H = ctrl;

// ── Settings ──
add('settings', () => call(H.getTenantBadges));
add('settings empty', () => call(H.getTenantBadges), noRowsWhen(/FROM badge_definitions b/));
add('settings not superadmin', () => call(H.getTenantBadges, { role: 'superuser' }));
add('settings no tenant', () => call(H.getTenantBadges, { params: { tenantId: '' } }));
add('update all', () =>
  call(H.updateTenantBadges, {
    body: {
      badges: [
        { badge_id: BADGE, is_active: false },
        { badge_id: 'onboarding_warrior', is_active: true, title: ' Tên mới ', desc: 'Mô tả' },
        { badge_id: 'profile_pro', is_active: true, name_override: 'Hoàn thành khóa', description_override: null, name: 'x' },
      ],
    },
  }),
  text =>
    /SELECT id, name, description FROM badge_definitions/.test(text)
      ? {
          rows: [
            { id: BADGE, name: 'Hoàn thành khóa', description: 'Mô tả' },
            { id: 'onboarding_warrior', name: 'Chiến binh', description: null },
            { id: 'profile_pro', name: 'Hồ sơ', description: 'Đủ hồ sơ' },
          ],
        }
      : undefined,
);
add('update all name and description', () =>
  call(H.updateTenantBadges, { body: { badges: [{ badge_id: BADGE, is_active: true, name: 'A', description: '  ' }] } }),
);
add('update all empty list', () => call(H.updateTenantBadges, { body: { badges: [] } }));
add('update all duplicate', () =>
  call(H.updateTenantBadges, { body: { badges: [{ badge_id: BADGE, is_active: true }, { badge_id: BADGE, is_active: false }] } }),
);
add('update all unknown badge', () =>
  call(H.updateTenantBadges, { body: { badges: [{ badge_id: 'nope', is_active: true }] } }),
  noRowsWhen(/SELECT id, name, description FROM badge_definitions/),
);
add('update all bad status', () => call(H.updateTenantBadges, { body: { badges: [{ badge_id: BADGE, is_active: 'yes' }] } }));
add('update all bad name', () => call(H.updateTenantBadges, { body: { badges: [{ badge_id: BADGE, is_active: true, name: 5 }] } }));
add('update all long description', () =>
  call(H.updateTenantBadges, { body: { badges: [{ badge_id: BADGE, is_active: true, desc: 'x'.repeat(2001) }] } }),
);
add('update all write fails', () =>
  call(H.updateTenantBadges, { body: { badges: [{ badge_id: BADGE, is_active: true }] } }),
  failWhen(/INSERT INTO tenant_badge_settings/, '23503'),
);
add('update all not a list', () => call(H.updateTenantBadges, { body: { badges: {} } }));
add('update all not superadmin', () => call(H.updateTenantBadges, { role: 'staff', body: { badges: [] } }));

// ── Images ──
add('card image', () => call(H.uploadCardImage, { file: IMAGE }));
add('card image first', () => call(H.uploadCardImage, { file: IMAGE }), rowsWhen(/AS image_url/, [{ image_url: null }]));
add('icon image', () => call(H.uploadIconImage, { file: { ...IMAGE, mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0]) } }));
add('mobile card image', () =>
  call(H.uploadMobileCardImage, { file: { ...IMAGE, mimetype: 'image/webp', buffer: Buffer.from('RIFF0000WEBPVP8 ') } }),
);
add('image other tenant badge', () => call(H.uploadCardImage, { file: IMAGE }), noRowsWhen(/SELECT id FROM badge_definitions/));
add('image write fails', () => call(H.uploadIconImage, { file: IMAGE }), failWhen(/^\s*UPDATE tenant_badge_settings/, '40001'));
add('image no file', () => call(H.uploadCardImage));
add('image too big', () => call(H.uploadCardImage, { file: { ...IMAGE, size: 11 * 1024 * 1024 } }));
add('image bad type', () => call(H.uploadIconImage, { file: { ...IMAGE, mimetype: 'image/gif' } }));
add('image bad signature', () => call(H.uploadMobileCardImage, { file: { ...IMAGE, buffer: Buffer.from('not a png') } }));
add('image no badge', () => call(H.uploadCardImage, { params: { badgeId: '' }, file: IMAGE }));
add('image not superadmin', () => call(H.uploadCardImage, { role: 'superuser', file: IMAGE }));

// ── Evaluation entry points ──
add('module enabled', () => evaluation.isBadgeManagementModuleEnabled(TENANT));
add('module disabled', () => evaluation.isBadgeManagementModuleEnabled(TENANT), noRowsWhen(/AS enabled/));
add('definitions', () => evaluation.getEffectiveBadgeDefinitions(TENANT));
add('definitions bad criteria', () =>
  evaluation.getEffectiveBadgeDefinitions(TENANT),
  rowsWhen(/FROM badge_definitions b/, [{ ...ROW, criteria: { version: 9 } }, { ...ROW, id: 'x', mapped_courses: null }]),
);
add('evaluate', () => evaluation.evaluateUserBadges(LEARNER, TENANT, missCache), noRowsWhen(/^\s*SELECT badge_id, is_shown, earned_at\s+FROM user_badges\s+WHERE user_id = \$1\s+ORDER BY/));
add('evaluate already earned', () => evaluation.evaluateUserBadges(LEARNER, TENANT, missCache));
add('evaluate nothing completed', () =>
  evaluation.evaluateUserBadges(LEARNER, TENANT, missCache),
  answers(noRowsWhen(/FROM enrollments e/), noRowsWhen(/^\s*SELECT badge_id, is_shown, earned_at\s+FROM user_badges\s+WHERE user_id = \$1\s+ORDER BY/)),
);
add('evaluate no rules', () => evaluation.evaluateUserBadges(LEARNER, TENANT, missCache), noRowsWhen(/FROM badge_definitions b/));
add('evaluate module off', () => evaluation.evaluateUserBadges(LEARNER, TENANT, missCache), () => ({ rows: [] }));

runCharacterization({
  label: 'badges characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'badges-sql.characterization.golden.json'),
  writeGolden: process.env.BADGES_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.BADGES_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER, LEARNER],
  sideRequests: storageRequests,
});
