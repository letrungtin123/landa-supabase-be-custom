import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// Publish and discard remove the course files their content no longer uses.
// The objects are removed only after the audited transaction committed: the
// quota fence of a Storage delete runs on another connection and needs the
// tenant quota row this transaction already locked (it waited until
// statement_timeout, then the file stayed), and a rolled-back discard must
// keep the files its rows still reference. A recording fetch stands in for
// Supabase Storage (no socket is opened); the pool hands out recording fake
// clients.

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'course-v1:T+1+2026';
const BLOCK = 'b0000000-0000-4000-8000-000000000001';
const OLD_FILE = `${TENANT}/courses/${COURSE}/old-video.mp4`;

const log: string[] = [];

const { env } = await import('../../config/env.js');
Object.assign(env as Record<string, unknown>, {
  // Unreachable on purpose: every Storage request goes to the recording fetch below.
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_KEY: 'test-service-key',
});
const db = await import('../../config/database.js');
const svc = await import('./course-authoring.service.js');
const { runAuditedTransaction } = await import('../../middleware/audit-log.js');

function rowsFor(sql: string): { rows: unknown[]; rowCount: number } {
  const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
  if (/WITH RECURSIVE ancestors[\s\S]*JOIN courses c/.test(sql)) {
    return rows([{
      id: BLOCK, course_id: COURSE, course_name: 'Course', parent_id: null, parent_name: null,
      block_type: 'vertical', display_name: 'Unit', data: {}, metadata: {}, sort_order: 0,
      is_published: true, has_draft_changes: true,
    }]);
  }
  if (/AS has_pub/.test(sql)) return rows([{ has_pub: true }]);
  // The draft (discard) or the published version (publish) referenced the old file.
  if (/SELECT data, metadata\s+FROM course_blocks/.test(sql)) return rows([{ data: { video_url: OLD_FILE }, metadata: {} }]);
  if (/SELECT published_data, published_metadata\s+FROM course_blocks/.test(sql)) {
    return rows([{ published_data: { video_url: OLD_FILE }, published_metadata: {} }]);
  }
  // No block of the course references it any more.
  if (/WITH candidate\(storage_path\)/.test(sql)) return rows([]);
  if (/DELETE FROM course_assets/.test(sql)) return rows([{ storage_path: OLD_FILE }]);
  if (/\)\s*SELECT id FROM descendants\s*$/.test(sql)) return rows([{ id: BLOCK }]);
  if (/FOR UPDATE OF usage/.test(sql)) {
    return rows([{ data_limit_bytes: null, database_used_bytes: '0', storage_used_bytes: '10', storage_reserved_bytes: '0', state: 'enforced' }]);
  }
  if (/SELECT storage_path, size_bytes\s+FROM tenant_storage_quota_objects/.test(sql)) return rows([{ storage_path: OLD_FILE, size_bytes: '10' }]);
  if (/DELETE FROM tenant_storage_quota_objects/.test(sql)) return rows([{ size_bytes: '10' }]);
  return { rows: [], rowCount: 0 };
}

const label = (sql: string) => sql.trim().split(/\s+/).slice(0, 3).join(' ');

/** Supabase Storage as seen through fetch: the bucket exists and every remove succeeds. */
async function fakeStorageFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  log.push(`storage ${request.method} ${new URL(request.url).pathname}`);
  const body = request.method === 'GET'
    ? { id: 'landa-storage', name: 'landa-storage', public: true }
    : ((await request.json().catch(() => ({}))) as { prefixes?: string[] }).prefixes?.map((name) => ({ name })) ?? [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function installFakes(t: TestContext): void {
  log.length = 0;
  t.mock.method(globalThis, 'fetch', fakeStorageFetch);
  let connections = 0;
  t.mock.method(db.pool, 'connect', async () => {
    const id = `c${++connections}`;
    return {
      query: async (sql: string) => { log.push(`${id} ${label(sql)}`); return rowsFor(sql); },
      release: () => { log.push(`${id} release`); },
    };
  });
  t.mock.method(db.pool, 'query', async (sql: string) => { log.push(`pool ${label(sql)}`); return rowsFor(sql); });
}

/** c1 is the audited transaction; c2 and c3 are the quota fence and ledger of the Storage delete. */
function assertRemovedAfterCommit(): void {
  const trace = `\n${log.join('\n')}`;
  const assetRow = log.indexOf('c1 DELETE FROM course_assets');
  const commit = log.indexOf('c1 COMMIT');
  const fence = log.indexOf('c2 BEGIN');
  const remove = log.indexOf('storage DELETE /storage/v1/object/landa-storage');
  assert.ok(assetRow >= 0 && commit > assetRow, `the asset row is deleted inside the transaction${trace}`);
  assert.ok(fence > log.indexOf('c1 release'), `the quota fence starts once the transaction is over${trace}`);
  assert.ok(remove > fence, `the file is removed after its quota fence${trace}`);
  assert.ok(log.indexOf('c3 DELETE FROM tenant_storage_quota_objects') > remove, `the quota ledger follows the removal${trace}`);
}

test('publish removes the file the new version no longer uses once the audited transaction committed', async (t) => {
  installFakes(t);
  await runAuditedTransaction(() => svc.publishBlock(BLOCK, TENANT), () => null);
  assertRemovedAfterCommit();
});

test('discard removes the unused draft file once the audited transaction committed', async (t) => {
  installFakes(t);
  await runAuditedTransaction(() => svc.discardDraftCascade(BLOCK, TENANT), () => null);
  assertRemovedAfterCommit();
});

test('a discard that rolls back keeps the file', async (t) => {
  installFakes(t);
  await assert.rejects(runAuditedTransaction(() => svc.discardDraftCascade(BLOCK, TENANT), () => {
    throw new Error('audit write failed');
  }), /audit write failed/);

  assert.ok(log.includes('c1 ROLLBACK'));
  assert.equal(log.some((line) => line.startsWith('storage ')), false, 'Storage is never called');
  assert.equal(log.includes('c2 BEGIN'), false, 'no quota fence is taken');
});
