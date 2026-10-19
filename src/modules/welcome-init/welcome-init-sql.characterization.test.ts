import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  callHandler,
  failWhen,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/staff-sql-characterization.js';

// Characterization of the welcome screen routes (/api/welcome-init): every
// SQL statement and the answer of both handlers (src/test-support/
// staff-sql-characterization.ts). The golden file was written by the code before
// the welcome init repository existed; moving SQL into it must keep every
// entry equal. Rewrite it only for an intended change:
//   WELCOME_INIT_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/welcome-init/welcome-init-sql.characterization.test.ts
// WELCOME_INIT_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./welcome-init.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';

const ROW = { is_demo_account: false, shown_at: '2026-10-01T01:02:03.000Z' };

interface CallOptions {
  tenantId?: string | null;
  sessionMode?: string;
  noUser?: boolean;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: options.noUser
      ? undefined
      : {
          id: USER,
          tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
          role: 'learner',
          username: 'learner01',
          sessionMode: options.sessionMode ?? 'normal',
        },
    query: {},
    params: {},
    body: {},
    originalUrl: '/api/welcome-init',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const H = ctrl;
const DEMO = rowsWhen(/AS is_demo_account/, [{ is_demo_account: true }]);
const NO_DEMO_TABLE = failWhen(/tenant_demo_login_accounts/, '42P01');
const NO_STATE_TABLE = failWhen(/user_welcome_init_states/, '42P01');

add('state seen', () => call(H.getWelcomeInitStateController));
add('state not seen', () => call(H.getWelcomeInitStateController), noRowsWhen(/SELECT shown_at FROM/));
add('state seen no time', () => call(H.getWelcomeInitStateController), rowsWhen(/SELECT shown_at FROM/, [{ shown_at: null }]));
add('state demo account', () => call(H.getWelcomeInitStateController), DEMO);
add('state demo session', () => call(H.getWelcomeInitStateController, { sessionMode: 'demo_iframe' }));
add('state no demo table', () => call(H.getWelcomeInitStateController), NO_DEMO_TABLE);
add('state no state table', () => call(H.getWelcomeInitStateController), NO_STATE_TABLE);
add('state other error', () => call(H.getWelcomeInitStateController), failWhen(/SELECT shown_at FROM/, '57014'));
add('state no user', () => call(H.getWelcomeInitStateController, { noUser: true }));
add('seen', () => call(H.markWelcomeInitSeenController));
add('seen no tenant', () => call(H.markWelcomeInitSeenController, { tenantId: null }));
add('seen no row', () => call(H.markWelcomeInitSeenController), noRowsWhen(/INSERT INTO user_welcome_init_states/));
add('seen demo account', () => call(H.markWelcomeInitSeenController), DEMO);
add('seen demo session', () => call(H.markWelcomeInitSeenController, { sessionMode: 'demo_iframe' }));
add('seen no demo table', () => call(H.markWelcomeInitSeenController), NO_DEMO_TABLE);
add('seen no state table', () => call(H.markWelcomeInitSeenController), NO_STATE_TABLE);
add('seen other error', () => call(H.markWelcomeInitSeenController), failWhen(/tenant_demo_login_accounts/, '57014'));
add('seen no user', () => call(H.markWelcomeInitSeenController, { noUser: true }));

runCharacterization({
  label: 'welcome init characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'welcome-init-sql.characterization.golden.json'),
  writeGolden: process.env.WELCOME_INIT_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.WELCOME_INIT_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER],
});
