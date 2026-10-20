import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { lessonAuthorSourceSnapshotHash } from '../../shared/lesson-author-source-snapshot.logic.js';
import { buildOrganizationContext, emptyOrgContextProfile } from '../../contracts/lesson-author-org-context.contract.js';
import { prepareOrchestrationV2Admission } from './lesson-author-orchestration-v2-admission.logic.js';
import { createOrchestrationV2AdmissionRepository } from './lesson-author-orchestration-v2-admission.repository.js';

// Admission binds a run to the organization context its workspace froze (bootstrap hash) and refuses it
// outside the IDM pipeline, the only one that reads it (the race with a rollout flag change).

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = { workspaceId: uuid(1), tenantId: uuid(2), courseId: 'course-v1:test+001+2026', conversationId: uuid(3),
  userId: uuid(4) };
const doc = { document_id: uuid(6), name: 'Nguồn.pdf', status: 'learned', type: 'file',
  updated_at: new Date('2026-10-01T00:00:00.000Z'), source_info: {} };
const sourceHash = lessonAuthorSourceSnapshotHash({ tenantId: target.tenantId, courseId: target.courseId }, uuid(5), [{
  document_id: doc.document_id, name: doc.name, status: doc.status, updated_at: doc.updated_at.toISOString(), source_info: {} }]);
const config = { runtime_config_hash: 'a'.repeat(64), model: 'gemini-test', source_snapshot_budget_ms: 300_000,
  tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, routing_shard_count: 64, pipeline: 'idm-1' as const };
const brief = { design_mode: 'instructional_design', learner_audience: 'Nhân viên mới',
  course_purpose: 'Giúp nhân viên mới làm đúng quy trình.', version: 1 };
const context = buildOrganizationContext(2, { ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu.' });

function fixture(organizationContext: unknown) {
  const queries: string[] = [];
  const responses: Array<Record<string, unknown>[]> = [[{ id: target.workspaceId, status: 'designing', kb_id: uuid(5),
    source_snapshot_hash: sourceHash, source_document_ids: [doc.document_id], launch_brief: brief,
    organization_context: organizationContext }], [doc], [], [{ id: uuid(20) }], [{ id: uuid(21) }], [{ id: uuid(22) }],
  [{ id: uuid(23) }]];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push(sql);
    const rows = responses.shift() ?? assert.fail(`unexpected SQL: ${sql}`);
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_runs')) runParams.push(params);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const runParams: unknown[][] = [];
  const db: GenerationJobDatabase = { transaction: work => work(tx) };
  let next = 20;
  return { repo: createOrchestrationV2AdmissionRepository({ db, canEdit: async () => true, id: () => uuid(next++) }),
    queries, runParams };
}

const authority = { workspace_id: target.workspaceId, tenant_id: target.tenantId, course_id: target.courseId,
  source_snapshot_hash: sourceHash, source_document_ids: [doc.document_id],
  launch_brief: { design_mode: 'instructional_design' as const, learner_audience: brief.learner_audience,
    course_purpose: brief.course_purpose } };

test('the frozen context is read by name and bound into the bootstrap hash; without it the hash is unchanged', async () => {
  const plain = fixture(null);
  await plain.repo.admit(target, config);
  assert.match(plain.queries[0]!, /to_jsonb\(w\)->'organization_context' AS organization_context/);
  assert.equal(plain.runParams[0]![5], prepareOrchestrationV2Admission(authority, config).bootstrap_hash);
  const organized = fixture(context);
  await organized.repo.admit(target, config);
  assert.equal(organized.runParams[0]![5], prepareOrchestrationV2Admission({ ...authority, organization_context: context },
    config).bootstrap_hash);
  assert.notEqual(organized.runParams[0]![5], plain.runParams[0]![5]);
});

test('a frozen context outside the IDM pipeline, or of another shape, is refused before anything is written', async () => {
  const legacy = fixture(context);
  await assert.rejects(legacy.repo.admit(target, { ...config, pipeline: 'v2-legacy' }), { code: 'ORG_CONTEXT_NOT_APPLICABLE' });
  assert.equal(legacy.queries.length, 1);
  const broken = fixture({ ...context, profile_hash: 'b'.repeat(64) });
  await assert.rejects(broken.repo.admit(target, config), { code: 'ORCHESTRATION_V2_ADMISSION_STATE_INVALID' });
  assert.equal(broken.queries.length, 1);
});
