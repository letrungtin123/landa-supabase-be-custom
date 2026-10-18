import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';

// H2/H3: reports run on their own small pool with the main pool's guardrails;
// an export reads one READ ONLY REPEATABLE READ snapshot through a cursor and
// stops (cancelling its statement) when the client leaves. No connection is
// opened here: the pool methods are faked.
const pg = await import('pg');
const { env } = await import('./env.js');
const { pool: mainPool } = await import('./database.js');
const reportsDb = await import('./reports-database.js');

test.after(async () => {
  await reportsDb.endReportsPool();
  await mainPool.end();
});

type Call = { text: string; params?: unknown[] };

function fakeClient(answer: (text: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] } = () => ({ rows: [] })) {
  const calls: Call[] = [];
  const releases: Array<Error | undefined> = [];
  const client = {
    calls,
    releases,
    async query(text: string, params?: unknown[]) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      if (text.includes('pg_backend_pid()')) return { rows: [{ pid: 4242 }] };
      return answer(text);
    },
    release(error?: Error) {
      releases.push(error);
    },
  };
  return client;
}

function installClient(t: TestContext, client: ReturnType<typeof fakeClient>) {
  t.mock.method(pg.default.Pool.prototype, 'connect', async function connect(this: unknown) {
    assert.equal(this, reportsDb.getReportsPool(), 'snapshots use the reports pool');
    return client;
  });
}

test('the reports pool keeps the main pool guardrails at its own size', () => {
  const options = reportsDb.getReportsPool().options as unknown as Record<string, unknown>;
  assert.equal(options.max, env.REPORTS_DB_POOL_MAX);
  assert.equal(options.statement_timeout, 30_000);
  assert.equal(options.connectionTimeoutMillis, 5_000);
  if (env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > 0) {
    assert.equal(options.idle_in_transaction_session_timeout, env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  } else {
    assert.equal(options.idle_in_transaction_session_timeout, undefined);
  }
  if (env.DB_LOCK_TIMEOUT_MS === 0) assert.equal(options.lock_timeout, undefined);
  else assert.equal(options.lock_timeout, env.DB_LOCK_TIMEOUT_MS);
  assert.notEqual(reportsDb.getReportsPool(), mainPool);
});

test('a reports-pool connection ended by the server is logged, never an unhandled error', (t) => {
  t.mock.method(console, 'error', () => {});
  const client = new EventEmitter();
  reportsDb.getReportsPool().emit('connect', client);
  assert.equal(client.listenerCount('error'), 1);
  assert.doesNotThrow(() => client.emit('error', new Error('terminating connection due to idle-in-transaction timeout')));
});

test('report queries go to the reports pool, never the main pool', async (t) => {
  const pools: unknown[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async function query(this: unknown) {
    pools.push(this);
    return { rows: [{ ok: 1 }], rowCount: 1 };
  });
  const result = await reportsDb.reportsQuery<{ ok: number }>('SELECT 1 AS ok');
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.deepEqual(pools, [reportsDb.getReportsPool()]);
});

test('an export snapshot is one READ ONLY REPEATABLE READ transaction with its own statement timeout', async (t) => {
  const client = fakeClient(() => ({ rows: [{ n: 1 }] }));
  installClient(t, client);
  const poolQueries = t.mock.method(pg.default.Pool.prototype, 'query', async () => ({ rows: [] }));

  const value = await reportsDb.withReportsSnapshot({ statementTimeoutMs: 120_000 }, async () => {
    const first = await reportsDb.reportsQuery<{ n: number }>('SELECT 1 AS n');
    const second = await reportsDb.reportsQuery<{ n: number }>('SELECT 2 AS n', [7]);
    return first.rows.length + second.rows.length;
  });

  assert.equal(value, 2);
  assert.deepEqual(client.calls.map((call) => call.text), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    "SELECT set_config('statement_timeout', $1, true), set_config('cursor_tuple_fraction', '1', true), pg_backend_pid() AS pid",
    'SELECT 1 AS n',
    'SELECT 2 AS n',
    'COMMIT',
  ]);
  assert.deepEqual(client.calls[1].params, ['120000ms']);
  assert.deepEqual(client.calls[3].params, [7]);
  assert.deepEqual(client.releases, [undefined]);
  assert.equal(poolQueries.mock.callCount(), 0, 'every read of the snapshot used its connection');

  // After the snapshot, the flow is back on the pool.
  await reportsDb.reportsQuery('SELECT 3');
  assert.equal(poolQueries.mock.callCount(), 1);
});

test('a failing export rolls the snapshot back and releases the connection once', async (t) => {
  const client = fakeClient((text) => {
    if (text.startsWith('SELECT broken')) throw new Error('relation does not exist');
    return { rows: [] };
  });
  installClient(t, client);
  await assert.rejects(
    reportsDb.withReportsSnapshot({ statementTimeoutMs: 60_000 }, () => reportsDb.reportsQuery('SELECT broken')),
    /relation does not exist/,
  );
  assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
  assert.deepEqual(client.releases, [undefined]);
});

test('a cursor streams the query once, in batches and in order', async (t) => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: index + 1 }));
  let served = 0;
  const client = fakeClient((text) => {
    if (!text.startsWith('FETCH')) return { rows: [] };
    const batch = rows.slice(served, served + 3);
    served += batch.length;
    return { rows: batch };
  });
  installClient(t, client);
  const batches: number[][] = [];

  await reportsDb.withReportsSnapshot({ statementTimeoutMs: 120_000 }, () => reportsDb.forEachReportsCursorBatch<{ id: number }>(
    { text: 'SELECT id FROM t WHERE tenant_id = $1 ORDER BY id', params: ['tenant-a'], batchSize: 3 },
    (batch) => { batches.push(batch.map((row) => row.id)); },
  ));

  assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7]]);
  const statements = client.calls.map((call) => call.text);
  const declare = statements.find((text) => text.startsWith('DECLARE'));
  assert.match(declare ?? '', /^DECLARE reports_cursor_\d+ NO SCROLL CURSOR FOR SELECT id FROM t WHERE tenant_id = \$1 ORDER BY id$/);
  assert.deepEqual(client.calls.find((call) => call.text.startsWith('DECLARE'))?.params, ['tenant-a']);
  assert.equal(statements.filter((text) => text.startsWith('FETCH FORWARD 3 FROM reports_cursor_')).length, 3);
  assert.equal(statements.filter((text) => text.startsWith('DECLARE')).length, 1, 'the query is planned and run once');
  assert.ok(statements.some((text) => text.startsWith('CLOSE reports_cursor_')));
});

test('a cursor needs an open snapshot', async () => {
  await assert.rejects(
    reportsDb.forEachReportsCursorBatch({ text: 'SELECT 1', params: [], batchSize: 10 }, () => undefined),
    /runs inside withReportsSnapshot/,
  );
});

test('when the client leaves, the running statement is cancelled before the connection goes back to the pool', async (t) => {
  let finishFetch: (() => void) | undefined;
  const order: string[] = [];
  const client = fakeClient((text) => {
    if (text.startsWith('FETCH')) {
      order.push('fetch started');
      return new Promise((resolve, reject) => {
        finishFetch = () => reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
        void resolve;
      });
    }
    return { rows: [] };
  });
  const releaseOrder = client.release.bind(client);
  client.release = (error?: Error) => { order.push('released'); releaseOrder(error); };
  installClient(t, client);
  let cancelDone: (() => void) | undefined;
  const cancels: unknown[][] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', function query(this: unknown, text: string, params: unknown[]) {
    assert.equal(this, mainPool, 'the cancel uses the main pool (the reports pool may be full)');
    cancels.push([text, ...params]);
    order.push('cancel sent');
    return new Promise((resolve) => {
      cancelDone = () => { order.push('cancel done'); resolve({ rows: [{ pg_cancel_backend: true }] }); };
    });
  });

  const controller = new AbortController();
  const running = reportsDb.withReportsSnapshot({ statementTimeoutMs: 120_000, signal: controller.signal }, () => reportsDb.forEachReportsCursorBatch(
    { text: 'SELECT 1', params: [], batchSize: 10, signal: controller.signal },
    () => undefined,
  ));
  while (!finishFetch) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  assert.deepEqual(cancels, [['SELECT pg_cancel_backend($1)', 4242]]);
  finishFetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!order.includes('released'), 'not released while the cancel is in flight');
  cancelDone!();

  await assert.rejects(running, (error: unknown) => reportsDb.isReportsSnapshotAbortedError(error));
  assert.deepEqual(order, ['fetch started', 'cancel sent', 'cancel done', 'released']);
  assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
});

test('an export whose client is already gone opens no transaction', async (t) => {
  const connect = t.mock.method(pg.default.Pool.prototype, 'connect', async () => fakeClient());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reportsDb.withReportsSnapshot({ statementTimeoutMs: 120_000, signal: controller.signal }, async () => 1),
    (error: unknown) => reportsDb.isReportsSnapshotAbortedError(error),
  );
  assert.equal(connect.mock.callCount(), 0);
});
