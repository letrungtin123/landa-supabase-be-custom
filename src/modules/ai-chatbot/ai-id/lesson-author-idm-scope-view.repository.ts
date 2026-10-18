import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import { IdmError, IDM_PIPELINE_VERSION } from './lesson-author-idm.contract.js';
import { resolveOrchestrationScopeView, remapFactsToBlockScopes,
  type IdmScopeView } from './lesson-author-idm-scope-view.logic.js';

const HASH = /^[0-9a-f]{64}$/;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const designInvalid = (): never => { throw new IdmError('IDM_COURSE_DESIGN_INVALID'); };

/**
 * Load the run's IDM scope view from its succeeded `course_skeleton` artifact
 * (spec §5.3: one scope-view source for every downstream task). The artifact
 * must hash to its stored identity and carry the design the assembly names.
 */
export async function loadIdmRunScopeView(
  tx: GenerationJobSql,
  lease: OrchestrationV2TaskLease,
  expectedDesignHash: string,
): Promise<IdmScopeView> {
  const result = await tx.query(`SELECT a.payload,a.artifact_hash
    FROM lesson_author_workspace_v2_artifacts a
    JOIN lesson_author_workspace_v2_tasks producer ON producer.id=a.task_id AND producer.run_id=a.run_id
      AND producer.workspace_id=a.workspace_id AND producer.tenant_id=a.tenant_id AND producer.course_id=a.course_id
    WHERE a.run_id=$1 AND a.workspace_id=$2 AND a.tenant_id=$3 AND a.course_id=$4
      AND a.artifact_kind='course_skeleton' AND producer.kind='course_skeleton' AND producer.status='succeeded'`,
  [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
  const payload = record(result.rows[0]?.payload);
  if (result.rows.length !== 1 || !payload || !HASH.test(String(result.rows[0]?.artifact_hash))
    || String(result.rows[0]?.artifact_hash) !== orchestrationV2Hash(payload)) designInvalid();
  const view = resolveOrchestrationScopeView(IDM_PIPELINE_VERSION, payload);
  if (view.kind !== 'idm' || view.design.design_hash !== expectedDesignHash
    || view.design.source_snapshot_hash !== lease.source_snapshot_hash
    || orchestrationV2Hash((payload as Record<string, unknown>).scopes) !== orchestrationV2Hash(view.scopeCatalog)) {
    return designInvalid();
  }
  return view;
}

/** Fact keys of the given block scopes, in block-scope order. */
export function idmScopeFactKeys(view: IdmScopeView, scopeKeys: readonly string[]): string[] {
  const byKey = new Map(view.design.block_scopes.map(scope => [scope.scope_key, scope.fact_keys]));
  return scopeKeys.flatMap(key => byKey.get(key) ?? designInvalid());
}

/** Persisted snapshot facts by key (snapshot order), as the V2 fact shape. */
export async function loadIdmSnapshotFacts(
  tx: GenerationJobSql,
  lease: OrchestrationV2TaskLease,
  factKeys: readonly string[],
  withHash = false,
): Promise<Array<OrchestrationV2SourceFact & { fact_hash?: string }>> {
  const facts = await tx.query(`SELECT document_id::text,fact_key,scope_key,fact_text,${withHash ? 'fact_hash,' : ''}
      source_ref,source_page,source_chunk,locator
    FROM lesson_author_workspace_source_facts
    WHERE snapshot_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND fact_key=ANY($5::text[])
    ORDER BY ordinal`,
  [lease.source_snapshot_id, lease.workspace_id, lease.tenant_id, lease.course_id, [...factKeys]]);
  if (facts.rows.length !== new Set(factKeys).size) designInvalid();
  return facts.rows.map(fact => ({
    document_id: String(fact.document_id), fact_key: String(fact.fact_key), scope_key: String(fact.scope_key),
    fact_text: String(fact.fact_text),
    ...(withHash ? { fact_hash: String(fact.fact_hash) } : {}),
    source_ref: fact.source_ref === null ? null : String(fact.source_ref),
    source_page: fact.source_page === null ? null : Number(fact.source_page),
    source_chunk: fact.source_chunk === null ? null : Number(fact.source_chunk),
    locator: record(fact.locator) ?? designInvalid(),
  }));
}

/** Snapshot facts of the given block scopes, re-keyed to their block scope (snapshot order). */
export async function loadIdmScopeFacts(
  tx: GenerationJobSql,
  lease: OrchestrationV2TaskLease,
  view: IdmScopeView,
  scopeKeys: readonly string[],
  withHash = false,
): Promise<Array<OrchestrationV2SourceFact & { fact_hash?: string }>> {
  const facts = await loadIdmSnapshotFacts(tx, lease, idmScopeFactKeys(view, scopeKeys), withHash);
  const remapped = remapFactsToBlockScopes(facts, view) as Array<OrchestrationV2SourceFact & { fact_hash?: string }>;
  if (remapped.length !== facts.length) designInvalid();
  return remapped;
}
