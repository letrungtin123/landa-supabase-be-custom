import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// Cache bumps registered inside withDatabaseTransaction() run only after
// COMMIT (a reader in between could otherwise cache the old data under the
// new version), never after ROLLBACK, and right away without a transaction.

async function fakePool(t: TestContext, log: string[]) {
  const db = await import('./database.js');
  const client = {
    query: async (text: string) => { log.push(text); return { rows: [], rowCount: 0 }; },
    release: () => { log.push('release'); },
  };
  t.mock.method(db.pool, 'connect', async () => client);
  return db;
}

test('work registered in a transaction runs after COMMIT', async (t) => {
  const log: string[] = [];
  const db = await fakePool(t, log);
  const result = await db.withDatabaseTransaction(async () => {
    await db.afterCommit(async () => { log.push('bump 1'); });
    await db.withDatabaseTransaction(async () => {
      await db.afterCommit(async () => { log.push('bump 2'); });
    });
    log.push('work done');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(log, ['BEGIN', 'work done', 'COMMIT', 'release', 'bump 1', 'bump 2']);
});

test('work registered in a transaction that rolls back never runs', async (t) => {
  const log: string[] = [];
  const db = await fakePool(t, log);
  await assert.rejects(db.withDatabaseTransaction(async () => {
    await db.afterCommit(async () => { log.push('bump'); });
    throw new Error('write failed');
  }), /write failed/);
  assert.deepEqual(log, ['BEGIN', 'ROLLBACK', 'release']);

  // The next transaction on the same client does not inherit it.
  await db.withDatabaseTransaction(async () => undefined);
  assert.equal(log.includes('bump'), false);
});

test('without a transaction the work runs right away', async () => {
  const db = await import('./database.js');
  const log: string[] = [];
  await db.afterCommit(async () => { log.push('bump'); });
  assert.deepEqual(log, ['bump']);
});
