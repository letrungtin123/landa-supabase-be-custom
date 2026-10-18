import assert from 'node:assert/strict';
import test from 'node:test';

// P3: at start each process compares its own connection maximum with what
// the server has left, and only warns. No connection is opened.
const { env } = await import('./env.js');
const { pool } = await import('./database.js');
const { evaluateConnectionHeadroom, logDatabaseConnectionHeadroom, ownDirectConnectionMax } = await import('./database-headroom.js');

test.after(async () => { await pool.end(); });

test('headroom: own maximum plus open connections against max_connections minus the reserve', () => {
  assert.deepEqual(evaluateConnectionHeadroom({ maxConnections: 100, openConnections: 40, ownMax: 14, reserve: 10 }),
    { maxConnections: 100, openConnections: 40, ownMax: 14, reserve: 10, room: 36, fits: true });
  assert.equal(evaluateConnectionHeadroom({ maxConnections: 100, openConnections: 76, ownMax: 14, reserve: 10 }).fits, true);
  const short = evaluateConnectionHeadroom({ maxConnections: 100, openConnections: 77, ownMax: 14, reserve: 10 });
  assert.equal(short.fits, false);
  assert.equal(short.room, -1);
});

test('an API process counts its reports pool; without a pooler every pool is direct', (t) => {
  if (env.DATABASE_POOLER_URL) {
    t.skip('DATABASE_POOLER_URL is set in this environment');
    return;
  }
  assert.equal(ownDirectConnectionMax({ readsReports: true }), env.DB_POOL_MAX + env.REPORTS_DB_POOL_MAX);
  assert.equal(ownDirectConnectionMax({ readsReports: false }), env.DB_POOL_MAX);
});

function fakeServer(maxConnections: string, open: number, calls: string[] = []) {
  return async () => ({
    async query(text: string) {
      calls.push(text);
      if (text === 'SHOW max_connections') return { rows: [{ max_connections: maxConnections }] };
      return { rows: [{ open }] };
    },
    async end() { calls.push('end'); },
  }) as never;
}

test('the start check logs the numbers, warns when the process may not fit, and never throws', async () => {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (level: 'info' | 'warn', event: Record<string, unknown>) => { logs.push([level, event]); };
  const calls: string[] = [];
  await logDatabaseConnectionHeadroom('api:1', 14, { log, connect: fakeServer('100', 40, calls) });
  assert.deepEqual(calls, ['SHOW max_connections', 'SELECT count(*)::int AS open FROM pg_stat_activity WHERE pid <> pg_backend_pid()', 'end']);
  assert.equal(logs[0][0], 'info');
  assert.equal(logs[0][1].event, 'db_connection_headroom');
  assert.equal(logs[0][1].room, 100 - env.DB_CONNECTION_RESERVE - 40 - 14);

  await logDatabaseConnectionHeadroom('api:2', 14, { log, connect: fakeServer('100', 95) });
  assert.equal(logs[1][0], 'warn');
  assert.deepEqual(logs[1][1], {
    event: 'db_connection_headroom_low', process: 'api:2', max_connections: 100, open_connections: 95,
    own_max: 14, reserve: env.DB_CONNECTION_RESERVE, room: 100 - env.DB_CONNECTION_RESERVE - 95 - 14, pooler: false,
  });

  await logDatabaseConnectionHeadroom('api:3', 14, { log, connect: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(logs[2][0], 'warn');
  assert.equal(logs[2][1].event, 'db_connection_headroom_unchecked');
});
