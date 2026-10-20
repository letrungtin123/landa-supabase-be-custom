import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyOrgContextProfile, orgContextProfileHash } from '../contracts/lesson-author-org-context.contract.js';
import { createOrgContextDistillRepository } from './lesson-author-org-context-distill.repository.js';
import { createOrgContextRepository } from './lesson-author-org-context.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = uuid(1), KB = uuid(2);
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function recorder(answer: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    calls.push({ sql: flat(sql), params });
    const rows = answer(flat(sql), params);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  return { db, calls };
}

test('every statement of the repository is bound to the tenant', async () => {
  const profile = { ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu.' };
  const r = recorder(sql => {
    if (sql.includes('RETURNING id::text AS id')) return [{ id: KB }];
    if (sql.includes('FROM lesson_author_org_context_states s WHERE s.tenant_id=$1 FOR UPDATE OF s')) {
      return [{ revision: '7', current_version: 2, confirmed_version: null, distill_status: 'idle' }];
    }
    if (sql.startsWith('UPDATE lesson_author_org_context_states')) return [{ revision: '8', confirmed_version: 2,
      distill_status: 'queued' }];
    if (sql.includes('RETURNING version')) return [{ version: 3 }];
    return [];
  });
  const repository = createOrgContextRepository(r.db);
  await repository.contextKbId(TENANT);
  await repository.insertContextKb(TENANT, uuid(3));
  await repository.usedBytes(TENANT, KB);
  await repository.listDocuments(TENANT, KB, 500);
  await repository.readDocument(TENANT, KB, uuid(4));
  await repository.findDocument(TENANT, KB, uuid(4));
  await repository.learnedDocuments(TENANT, KB, 50);
  await repository.unreadDocumentCount(TENANT, KB, [uuid(4)]);
  await repository.readState(TENANT);
  assert.equal((await repository.lockState(TENANT)).revision, 7);
  await repository.readVersion(TENANT, 1);
  await repository.history(TENANT, 20);
  await repository.latestDraftSources(TENANT);
  assert.equal(await repository.insertVersion(TENANT, { origin: 'author_edit', profile,
    profileHash: orgContextProfileHash(profile), charCount: 12, createdBy: uuid(3) }), 3);
  assert.deepEqual(await repository.updateVersions(TENANT, { currentVersion: 3, confirm: true, actorId: uuid(3) }),
    { revision: 8, confirmed_version: 2 });
  await repository.confirmedContext(TENANT, true);
  for (const call of r.calls) {
    assert.ok(call.params.includes(TENANT), `tenant parameter: ${call.sql.slice(0, 90)}`);
    assert.match(call.sql, /tenant_id ?= ?\$1|tenant_id=\$2|VALUES \(\$1[,)]|SELECT \$1::uuid/, call.sql.slice(0, 120));
  }
  const kb = r.calls.find(call => call.sql.startsWith('INSERT INTO tenant_kb_assignments'))!;
  assert.match(kb.sql, /'lesson_author_context'/);
  assert.match(r.calls.find(call => call.sql.includes('FOR SHARE OF s'))!.sql, /p\.version=s\.confirmed_version/);
  const update = r.calls.find(call => call.sql.startsWith('UPDATE lesson_author_org_context_states'))!;
  assert.match(update.sql, /revision=revision\+1/, 'a version change always bumps the revision');
});

test('the 50 MB check locks per tenant and sums the stored sizes', async () => {
  const r = recorder(sql => sql.includes('AS used_bytes') ? [{ used_bytes: '52428800' }] : []);
  const repository = createOrgContextRepository(r.db);
  await repository.lockUsage(TENANT);
  assert.equal(await repository.usedBytes(TENANT, KB), 52_428_800);
  assert.deepEqual(r.calls[0], { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [`lesson_author_org_context:${TENANT}`] });
  assert.match(r.calls[1]!.sql, /source_info->>'size'/);
  assert.match(r.calls[1]!.sql, /d\.tenant_id=\$1 AND d\.kb_id=\$2/);
});

test('rows read as numbers and fail closed on another shape', async () => {
  const profile = { ...emptyOrgContextProfile(), culture_tone: 'Thân thiện.' };
  const r = recorder(sql => {
    if (sql.includes('FROM kb_documents d LEFT JOIN users u')) return [{ id: uuid(4), name: 'a.pdf', status: 'learned',
      error_reason: null, size_bytes: '1048576', created_at: new Date('2026-10-20T00:00:00Z'), created_by_name: '' }];
    if (sql.includes('FROM lesson_author_org_context_profiles p LEFT JOIN users u') && sql.includes('p.version=$2')) {
      return [{ version: 2, origin: 'restore', profile, char_count: 11, profile_hash: orgContextProfileHash(profile),
        created_at: '2026-10-20T00:00:00Z', created_by_name: 'Tác giả' }];
    }
    return [];
  });
  const repository = createOrgContextRepository(r.db);
  assert.deepEqual(await repository.listDocuments(TENANT, KB, 1), [{ id: uuid(4), name: 'a.pdf', status: 'learned',
    error_reason: null, size_bytes: 1_048_576, created_at: '2026-10-20T00:00:00.000Z', created_by_name: null }]);
  assert.equal((await repository.readVersion(TENANT, 2))?.origin, 'restore');
  const bad = createOrgContextRepository(recorder(() => [{ version: 2, origin: 'pasted', profile, char_count: 1,
    profile_hash: 'x', created_at: '2026-10-20T00:00:00Z' }]).db);
  await assert.rejects(bad.readVersion(TENANT, 2), { code: 'ORG_CONTEXT_ROW_INVALID' });
});

test('the drafting worker claims one row with SKIP LOCKED under the tenant fences and owns it by lease token', async () => {
  const r = recorder(sql => sql.startsWith('WITH candidate') ? [{ tenant_id: TENANT, distill_locale: 'en',
    requested_by: uuid(3), distill_attempts: 2 }] : []);
  const distill = createOrgContextDistillRepository(r.db);
  await distill.failExhaustedLeases();
  const claim = await distill.claim(uuid(9), 660_000, first => ({ clause: ` AND s.tenant_id = ANY($${first}::uuid[])`,
    params: [[TENANT]] }));
  assert.deepEqual(claim, { tenant_id: TENANT, locale: 'en', requested_by: uuid(3), attempts: 2, lease_token: uuid(9) });
  const sql = r.calls[1]!.sql;
  assert.match(sql, /FOR UPDATE OF s SKIP LOCKED/);
  assert.match(sql, /distill_status='queued' OR \(s\.distill_status='running' AND s\.distill_lease_until<now\(\)\)/);
  assert.match(sql, /AND s\.tenant_id = ANY\(\$3::uuid\[\]\)/);
  assert.match(sql, /distill_attempts=s\.distill_attempts\+1/);
  assert.doesNotMatch(sql, /revision/, 'a lease update keeps the revision');
  assert.deepEqual(r.calls[1]!.params, [uuid(9), 660_000, [TENANT]]);
  assert.match(r.calls[0]!.sql, /distill_attempts>=\$1/);
  await distill.lockLease(TENANT, uuid(9));
  await distill.finishSucceeded(TENANT, uuid(9), 4);
  await distill.finishFailed(TENANT, uuid(9), 'queued', 'SERVICE_BUSY');
  for (const call of r.calls.slice(2)) {
    assert.match(call.sql, /tenant_id=\$1 AND distill_status='running' AND distill_lease_token=\$2::uuid/);
    assert.deepEqual(call.params.slice(0, 2), [TENANT, uuid(9)]);
  }
  assert.match(r.calls[3]!.sql, /revision=revision\+1,current_version=\$3/);
  assert.doesNotMatch(r.calls[4]!.sql, /revision/);
});
