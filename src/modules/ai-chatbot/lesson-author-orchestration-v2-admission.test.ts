import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { lessonAuthorSourceSnapshotHash } from './lesson-author-source-snapshot.logic.js';
import { prepareOrchestrationV2Admission } from './lesson-author-orchestration-v2-admission.logic.js';
import { createOrchestrationV2AdmissionRepository } from './lesson-author-orchestration-v2-admission.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const H = 'a'.repeat(64);
const target = { workspaceId: uuid(1), tenantId: uuid(2), courseId: 'course-v1:test+001+2026',
  conversationId: uuid(3), userId: uuid(4) };
const doc = { document_id: uuid(6), name: 'Nguồn.pdf', status: 'learned', type: 'file',
  updated_at: new Date('2026-10-01T00:00:00.000Z'), source_info: {} };
const sourceHash = lessonAuthorSourceSnapshotHash({ tenantId: target.tenantId, courseId: target.courseId }, uuid(5), [{
  document_id: doc.document_id, name: doc.name, status: doc.status, updated_at: doc.updated_at.toISOString(), source_info: {},
}]);
const config = { runtime_config_hash: H, model: 'gemini-test', source_snapshot_budget_ms: 300_000,
  tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, routing_shard_count: 64 };
const workspace = { id: target.workspaceId, status: 'designing', kb_id: uuid(5), source_snapshot_hash: sourceHash,
  source_document_ids: [doc.document_id] };

function fixture(responses: Array<Record<string, unknown>[] | Error>) {
  const events: string[] = [], queries: Array<{ sql: string; params: unknown[] }> = [];
  let active = false;
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    assert.equal(active, true); queries.push({ sql, params }); const next = responses.shift();
    assert.notEqual(next, undefined, `unexpected SQL: ${sql}`); if (next instanceof Error) throw next;
    const rows = next as Record<string, unknown>[];
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    active = true; events.push('BEGIN'); try { const value = await work(tx); events.push('COMMIT'); return value; }
    catch (error) { events.push('ROLLBACK'); throw error; } finally { active = false; }
  } };
  let nextId = 20;
  const repo = createOrchestrationV2AdmissionRepository({ db, canEdit: async () => true, id: () => uuid(nextId++) });
  return { repo, events, queries, assertDone: () => assert.equal(responses.length, 0) };
}

test('prepares stable bootstrap/task identities and tenant routing shard', () => {
  const input = { workspace_id: target.workspaceId, tenant_id: target.tenantId, course_id: target.courseId,
    source_snapshot_hash: sourceHash, source_document_ids: [uuid(9), doc.document_id] };
  const first = prepareOrchestrationV2Admission(input, config);
  const second = prepareOrchestrationV2Admission({ ...input, source_document_ids: [doc.document_id, uuid(9)] }, config);
  assert.deepEqual(first, second); assert.match(first.bootstrap_hash, /^[0-9a-f]{64}$/);
  assert.ok(first.routing_shard >= 0 && first.routing_shard < config.routing_shard_count);
});

test('admission commits snapshot, planning run, source task and outbox in one transaction', async () => {
  const f = fixture([[workspace], [doc], [], [{ id: uuid(20) }], [{ id: uuid(21) }], [{ id: uuid(22) }], [{ id: uuid(23) }]]);
  const receipt = await f.repo.admit(target, config);
  assert.equal(receipt.created, true); assert.deepEqual(f.events, ['BEGIN', 'COMMIT']); f.assertDone();
  assert.match(f.queries[0]!.sql, /FOR UPDATE OF w/);
  assert.match(f.queries[3]!.sql, /lesson_author_workspace_source_snapshots/);
  assert.match(f.queries[4]!.sql, /lesson_author_workspace_v2_runs/);
  assert.match(f.queries[5]!.sql, /'source:snapshot','source_snapshot'/);
  assert.match(f.queries[6]!.sql, /lesson_author_workspace_v2_dispatch_outbox/);
  assert.equal(f.queries[6]!.params[6], prepareOrchestrationV2Admission({ workspace_id: target.workspaceId,
    tenant_id: target.tenantId, course_id: target.courseId, source_snapshot_hash: sourceHash,
    source_document_ids: [doc.document_id] }, config).routing_shard);
});

test('same immutable admission is idempotent and creates no second durable row', async () => {
  const prepared = prepareOrchestrationV2Admission({ workspace_id: target.workspaceId, tenant_id: target.tenantId,
    course_id: target.courseId, source_snapshot_hash: sourceHash, source_document_ids: [doc.document_id] }, config);
  const run = { id: uuid(21), source_snapshot_id: uuid(20), bootstrap_hash: prepared.bootstrap_hash,
    runtime_config_hash: config.runtime_config_hash, model: config.model,
    tenant_concurrency_limit: config.tenant_concurrency_limit, workspace_concurrency_limit: config.workspace_concurrency_limit };
  const f = fixture([[workspace], [doc], [run], [{ snapshot_id: uuid(20), task_id: uuid(22), outbox_id: uuid(23) }]]);
  const receipt = await f.repo.admit(target, config);
  assert.equal(receipt.created, false); assert.equal(f.queries.length, 4); assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('changed source or config conflicts and transaction rolls back before publishing', async () => {
  const changed = fixture([[{ ...workspace, source_snapshot_hash: 'b'.repeat(64) }], [doc]]);
  await assert.rejects(changed.repo.admit(target, config), { code: 'ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED' });
  assert.deepEqual(changed.events, ['BEGIN', 'ROLLBACK']);
  const existing = fixture([[workspace], [doc], [{ id: uuid(21), source_snapshot_id: uuid(20), bootstrap_hash: H,
    runtime_config_hash: 'b'.repeat(64), model: config.model, tenant_concurrency_limit: 16,
    workspace_concurrency_limit: 4 }]]);
  await assert.rejects(existing.repo.admit(target, config), { code: 'ORCHESTRATION_V2_ADMISSION_CONFLICT' });
  assert.deepEqual(existing.events, ['BEGIN', 'ROLLBACK']);
});

test('any insert/readback failure rolls back all admission evidence', async () => {
  const f = fixture([[workspace], [doc], [], [{ id: uuid(20) }], [{ id: uuid(21) }], new Error('task insert failed')]);
  await assert.rejects(f.repo.admit(target, config), /task insert failed/);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});
