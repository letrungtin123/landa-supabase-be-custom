import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { GoogleGenAI } from '@google/genai';

// ensureStore() calls Gemini with no transaction open and no pool
// connection checked out, records the store in a short transaction, and
// never leaves a KB with two stores when two calls race. In-memory pg
// double and a fake Gemini client; no database, no network, no paid call.

const KB = 'b0000000-0000-4000-8000-000000000001';

interface StoreRow { id: string; store_name: string; api_key_fingerprint: string | null; remote_status: string }

interface Harness {
  log: string[];
  rows: StoreRow[];
  state: { checkedOut: number; inTransaction: boolean };
  /** Runs once, right before the transaction's re-read (simulates another caller). */
  beforeReRead?: () => void;
  failInsert?: boolean;
}

async function install(t: TestContext, harness: Harness) {
  const db = await import('../../../config/database.js');
  const select = () => {
    const row = harness.rows[0];
    return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
  };
  t.mock.method(db.pool, 'query', async (text: string) => {
    harness.log.push(`pool:${text.trim().split(/\s+/)[0]}`);
    if (text.includes('FROM kb_google_store')) return select();
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(db.pool, 'connect', async () => {
    harness.state.checkedOut += 1;
    return {
      query: async (text: string, params: unknown[] = []) => {
        const verb = text.trim().split(/\s+/)[0];
        harness.log.push(`tx:${verb}`);
        if (verb === 'BEGIN') harness.state.inTransaction = true;
        if (verb === 'COMMIT' || verb === 'ROLLBACK') harness.state.inTransaction = false;
        if (text.includes('pg_advisory_xact_lock')) {
          assert.equal(params[0], `kb-google-store:${KB}`);
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM kb_google_store')) {
          harness.beforeReRead?.();
          harness.beforeReRead = undefined;
          return select();
        }
        if (verb === 'INSERT') {
          if (harness.failInsert) throw Object.assign(new Error('insert failed'), { code: '23505' });
          const row = { id: 'store-row-1', store_name: String(params[1]), api_key_fingerprint: (params[2] as string) ?? null, remote_status: 'active' };
          harness.rows.push(row);
          return { rows: [{ id: row.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => { harness.state.checkedOut -= 1; harness.log.push('release'); },
    };
  });
}

function fakeGemini(harness: Harness) {
  const created: Array<{ displayName: string; signal: unknown }> = [];
  const deleted: string[] = [];
  const client = {
    fileSearchStores: {
      create: async ({ config }: { config: { displayName: string; abortSignal?: AbortSignal } }) => {
        // The provider call must never run inside a transaction or hold a pool slot.
        assert.equal(harness.state.inTransaction, false, 'no open transaction during the Gemini call');
        assert.equal(harness.state.checkedOut, 0, 'no pool connection held during the Gemini call');
        harness.log.push('gemini:create');
        created.push({ displayName: config.displayName, signal: config.abortSignal });
        return { name: `fileSearchStores/new-${created.length}` };
      },
      delete: async ({ name }: { name: string }) => { harness.log.push('gemini:delete'); deleted.push(name); },
    },
  };
  return { client: client as unknown as GoogleGenAI, created, deleted };
}

function harness(rows: StoreRow[] = []): Harness {
  return { log: [], rows, state: { checkedOut: 0, inTransaction: false } };
}

test('a recorded active store is returned without a transaction or a Gemini call', async (t) => {
  const h = harness([{ id: 'existing', store_name: 'fileSearchStores/old', api_key_fingerprint: 'fp', remote_status: 'active' }]);
  await install(t, h);
  const gemini = fakeGemini(h);
  const { ensureStore } = await import('./gemini.service.js');
  assert.deepEqual(await ensureStore(KB, gemini.client, 'fp'), { storeId: 'existing', storeName: 'fileSearchStores/old' });
  assert.deepEqual(h.log, ['pool:SELECT']);
  assert.equal(gemini.created.length, 0);
});

test('a store that needs a restore is refused as before', async (t) => {
  const h = harness([{ id: 'existing', store_name: 'fileSearchStores/old', api_key_fingerprint: 'old-fp', remote_status: 'active' }]);
  await install(t, h);
  const { ensureStore } = await import('./gemini.service.js');
  await assert.rejects(ensureStore(KB, fakeGemini(h).client, 'new-fp'), /can khoi phuc/);
  const keyChanged = harness([{ id: 'existing', store_name: 'x', api_key_fingerprint: null, remote_status: 'key_changed' }]);
  t.mock.restoreAll();
  await install(t, keyChanged);
  await assert.rejects(ensureStore(KB, fakeGemini(keyChanged).client, 'fp'), /can khoi phuc/);
});

test('a new store is created outside any transaction, with a deadline, then recorded in a short one', async (t) => {
  const h = harness();
  await install(t, h);
  const gemini = fakeGemini(h);
  const { ensureStore } = await import('./gemini.service.js');
  assert.deepEqual(await ensureStore(KB, gemini.client, 'fp'), { storeId: 'store-row-1', storeName: 'fileSearchStores/new-1' });
  assert.deepEqual(h.log, ['pool:SELECT', 'gemini:create', 'tx:BEGIN', 'tx:SELECT', 'tx:SELECT', 'tx:INSERT', 'tx:COMMIT', 'release']);
  assert.equal(gemini.created[0].displayName, `kb-store-${KB}`);
  assert.ok(gemini.created[0].signal instanceof AbortSignal, 'the Gemini call has a client-side deadline');
  assert.equal((gemini.created[0].signal as AbortSignal).aborted, false);
  assert.deepEqual(h.rows.map((row) => [row.store_name, row.api_key_fingerprint]), [['fileSearchStores/new-1', 'fp']]);
  assert.equal(gemini.deleted.length, 0);
});

test('two racing calls leave one recorded store: the later one deletes its own and uses the recorded one', async (t) => {
  const h = harness();
  await install(t, h);
  h.beforeReRead = () => {
    h.rows.push({ id: 'winner', store_name: 'fileSearchStores/winner', api_key_fingerprint: 'fp', remote_status: 'active' });
  };
  const gemini = fakeGemini(h);
  const { ensureStore } = await import('./gemini.service.js');
  assert.deepEqual(await ensureStore(KB, gemini.client, 'fp'), { storeId: 'winner', storeName: 'fileSearchStores/winner' });
  assert.equal(h.rows.length, 1, 'only the first recorded store remains');
  assert.deepEqual(gemini.deleted, ['fileSearchStores/new-1']);
  assert.equal(h.log.includes('tx:INSERT'), false);
  assert.ok(h.log.indexOf('gemini:delete') > h.log.indexOf('release'), 'the extra store is deleted after the transaction ended');
});

test('a failed record rolls back and deletes the store it created', async (t) => {
  const h = harness();
  h.failInsert = true;
  await install(t, h);
  const gemini = fakeGemini(h);
  const { ensureStore } = await import('./gemini.service.js');
  await assert.rejects(ensureStore(KB, gemini.client, 'fp'), /insert failed/);
  assert.deepEqual(gemini.deleted, ['fileSearchStores/new-1']);
  assert.ok(h.log.includes('tx:ROLLBACK'));
  assert.equal(h.state.checkedOut, 0);
});

test('a Gemini call past its deadline fails with a plain message and records nothing', async (t) => {
  const h = harness();
  await install(t, h);
  const client = {
    fileSearchStores: {
      create: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
      delete: async () => undefined,
    },
  } as unknown as GoogleGenAI;
  const { ensureStore } = await import('./gemini.service.js');
  await assert.rejects(ensureStore(KB, client, 'fp'), /thời gian cho phép/);
  assert.deepEqual(h.log, ['pool:SELECT']);
  assert.equal(h.rows.length, 0);
});
