import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { orchestrationV2Hash } from '../../shared/lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease } from '../worker/lesson-author-orchestration-v2-worker.repository.js';
import {
  createOrchestrationV2UnitRepository, ORCHESTRATION_V2_SOURCE_DOCUMENT_MISSING,
} from './lesson-author-orchestration-v2-unit.repository.js';

// A source document deleted after its run stopped (owner rule: only documents of runs actively writing are
// protected). A unit then rewritten fails before any AI call with one stable code, never the generic authority
// failure, so the author is told plainly why (task and run failure_code).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lease = {
  task_id: uuid(41), run_id: uuid(42), workspace_id: uuid(43), tenant_id: uuid(44), course_id: 'course-v1:test+1+2026',
  task_key: 'content:chapter-1:unit:1', kind: 'generate_unit', chapter_key: 'chapter-1', node_id: uuid(45),
  contract_hash: orchestrationV2Hash('task'), input_context_hash: orchestrationV2Hash('input'), source_snapshot_id: uuid(46),
  source_snapshot_hash: orchestrationV2Hash('source'), model: 'test-model', locale: 'vi', max_output_tokens: 4_000,
  provider_max_attempts: 1, execution_budget_ms: 60_000, lease_token: uuid(47), dispatch_epoch: 2, routing_shard: 3,
  ai_reservation_id: uuid(48),
} as unknown as OrchestrationV2TaskLease;

function database(learned: string[]) {
  const seen: string[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string) {
    seen.push(sql);
    let rows: Array<Record<string, unknown>>;
    if (sql.includes('SELECT w.kb_id::text')) {
      rows = [{ kb_id: uuid(49), conversation_id: uuid(50), correlation_id: uuid(51), content_locale: 'vi',
        source_document_ids: [uuid(11), uuid(12)], canonical_path: 'chapter_1.lesson_1.unit_1',
        node_contract_hash: orchestrationV2Hash('node'), content_state: 'planned', current_revision: null, task_key: lease.task_key }];
    } else if (sql.includes('FROM kb_documents')) {
      rows = learned.map(id => ({ document_id: id, kb_id: uuid(49), name: 'source.pdf', type: 'file', status: 'learned' }));
    } else if (sql.includes('FROM lesson_author_workspace_v2_artifacts a')) {
      throw new Error('the evidence is never read without the sources');
    } else {
      assert.fail(`unexpected SQL: ${sql}`);
    }
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) { return work(tx); } };
  return { db, seen };
}

test('a unit whose source document was deleted fails with ORCHESTRATION_V2_SOURCE_DOCUMENT_MISSING before any AI call', async () => {
  for (const learned of [[], [uuid(11)]]) {
    const { db, seen } = database(learned);
    await assert.rejects(createOrchestrationV2UnitRepository(db, {} as never).load(lease),
      { name: 'OrchestrationV2UnitRepositoryError', code: ORCHESTRATION_V2_SOURCE_DOCUMENT_MISSING });
    assert.equal(seen.length, 2, 'authority, then the sources; nothing else');
    assert.match(seen[1]!, /status='learned'/);
  }
  assert.equal(ORCHESTRATION_V2_SOURCE_DOCUMENT_MISSING, 'ORCHESTRATION_V2_SOURCE_DOCUMENT_MISSING');
  assert.match(ORCHESTRATION_V2_SOURCE_DOCUMENT_MISSING, /^[A-Z][A-Z0-9_]{0,99}$/, 'a valid task and run failure_code');
});
