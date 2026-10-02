import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ORCHESTRATION_V2_GUARDS } from './lesson-author-orchestration-v2-schema.repository.js';

const sql = readFileSync(
  new URL('../../../../supabase/manual_sql/20261001_1100_lesson_author_orchestration_v2.sql', import.meta.url),
  'utf8',
);
const runningTaskGuardCorrection = readFileSync(
  new URL('../../../../supabase/manual_sql/20261001_1445_lesson_author_orchestration_v2_running_task_guard.sql', import.meta.url),
  'utf8',
);
const completionGuardCorrection = readFileSync(
  new URL('../../../../supabase/manual_sql/20261001_1700_lesson_author_orchestration_v2_completion_guard_hotfix.sql', import.meta.url),
  'utf8',
);
const outcomeReplayGuard = readFileSync(
  new URL('../../../../supabase/manual_sql/20261001_1715_lesson_author_orchestration_v2_outcome_replay_guard.sql', import.meta.url),
  'utf8',
);
const executable = sql
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const compact = executable.replace(/\s+/g, ' ').trim();

const tables = [
  'lesson_author_workspace_source_snapshots',
  'lesson_author_workspace_source_facts',
  'lesson_author_workspace_v2_runs',
  'lesson_author_workspace_v2_tasks',
  'lesson_author_workspace_v2_dependencies',
  'lesson_author_workspace_v2_artifacts',
  'lesson_author_workspace_v2_dispatch_outbox',
  'lesson_author_workspace_v2_completion_receipts',
] as const;

test('reviewed guard hashes exactly match the manual SQL bodies', () => {
  for (const [signature, expected] of Object.entries(ORCHESTRATION_V2_GUARDS)) {
    const name = signature.slice(0, -2);
    const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(\\)[\\s\\S]*?AS \\$guard\\$\\r?\\n([\\s\\S]*?)\\r?\\n\\$guard\\$;`);
    const source = signature === 'guard_lesson_author_workspace_v2_task()' ? outcomeReplayGuard : sql;
    const body = source.match(pattern)?.[1];
    assert.ok(body, `missing reviewed guard body: ${signature}`);
    assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'), expected);
  }
});

test('outcome replay guard requires pessimistic accounting before one bounded retry', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.guard_lesson_author_workspace_v2_task\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = outcomeReplayGuard.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    ORCHESTRATION_V2_GUARDS['guard_lesson_author_workspace_v2_task()']);
  assert.match(body, /OLD\.status='outcome_unknown' AND NEW\.status='queued'/);
  assert.match(body, /OLD\.attempt_count>=OLD\.max_attempts/);
  assert.match(body, /r\.status='finalized'/);
  assert.match(body, /reconciled_ledgers<>1/);
  const executableCorrection = outcomeReplayGuard.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(executableCorrection, /\bDROP\b/i);
  assert.match(executableCorrection, /^\s*BEGIN;/m);
  assert.match(executableCorrection, /COMMIT;\s*$/);
});

test('running-task correction is drift-fenced and exactly matches the reviewed install body', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.guard_lesson_author_workspace_v2_task\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const installBody = sql.match(pattern)?.[1];
  const correctionBody = runningTaskGuardCorrection.match(pattern)?.[1];
  assert.ok(installBody);
  assert.equal(correctionBody, installBody);
  assert.match(runningTaskGuardCorrection,
    /current_hash NOT IN \('89d7989dfb12b491753895bf370c4317','fcda3a219402c20c4ae1e2cd875ebd9a'\)/);
  assert.match(runningTaskGuardCorrection,
    /current_hash IS DISTINCT FROM 'fcda3a219402c20c4ae1e2cd875ebd9a'/);
  const executableCorrection = runningTaskGuardCorrection.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(executableCorrection, /\bDROP\b/i);
  assert.match(executableCorrection, /^\s*BEGIN;/m);
  assert.match(executableCorrection, /COMMIT;\s*$/);
});

test('completion correction removes task_id ambiguity and matches the reviewed install body', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.assert_lesson_author_workspace_v2_completion_commit\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const installBody = sql.match(pattern)?.[1];
  const correctionBody = completionGuardCorrection.match(pattern)?.[1];
  assert.ok(installBody);
  assert.equal(correctionBody, installBody);
  assert.doesNotMatch(correctionBody, /DECLARE task_id UUID/);
  assert.match(correctionBody, /DECLARE v_task_id UUID/);
  assert.match(completionGuardCorrection,
    /current_hash NOT IN \('d634b3a5913b88ad4377890da71b3915','397e0d0394703136479379d064739faf'\)/);
  assert.match(completionGuardCorrection,
    /current_hash IS DISTINCT FROM '397e0d0394703136479379d064739faf'/);
  const executableCorrection = completionGuardCorrection.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(executableCorrection, /\bDROP\b/i);
  assert.match(executableCorrection, /^\s*BEGIN;/m);
  assert.match(executableCorrection, /COMMIT;\s*$/);
});

test('V2 manual SQL is additive, transactional and cannot silently rerun', () => {
  assert.match(executable, /^\s*BEGIN;/m);
  assert.match(executable, /SELECT public\.tenant_data_quota_assert_coverage\(\);\s*COMMIT;\s*$/);
  assert.equal([...executable.matchAll(/CREATE TABLE public\.(\w+)/g)].length, tables.length);
  for (const table of tables) {
    assert.match(executable, new RegExp(`CREATE TABLE public\\.${table} \\(`));
    assert.match(executable, new RegExp(`to_regclass\\('public\\.'\\|\\|relation\\) IS NOT NULL`));
  }
  assert.doesNotMatch(executable, /CREATE\s+(?:OR\s+REPLACE\s+)?POLICY/i);
  const replacements = [...executable.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)\(\)/gi)]
    .map((match) => match[1]).sort();
  assert.deepEqual(replacements, [
    'assert_lesson_author_workspace_run_commit', 'assert_lesson_author_workspace_unit_commit',
    'fence_lesson_author_workspace_baseline',
    'guard_lesson_author_workspace', 'guard_lesson_author_workspace_event',
    'guard_lesson_author_workspace_node', 'guard_lesson_author_workspace_revision',
  ]);
  assert.doesNotMatch(executable, /SECURITY\s+DEFINER/i);
  assert.doesNotMatch(executable, /ALTER TABLE public\.lesson_author_workspaces\b/i);
  assert.doesNotMatch(executable, /(?:INSERT INTO|DELETE FROM) public\.lesson_author_workspaces\b/i);
  const workspaceUpdates = [...executable.matchAll(/UPDATE public\.lesson_author_workspaces\b[^;]*;/gi)];
  assert.equal(workspaceUpdates.length, 1);
  assert.match(workspaceUpdates[0]![0], /SET event_head=NEW\.sequence WHERE id=w\.id/);
  assert.doesNotMatch(executable, /(?:INSERT INTO|UPDATE|DELETE FROM) public\.lesson_author_workspace_(?:events|nodes|revisions|runs|work_items|apply_mappings|apply_receipts)\b/i);
});

test('legacy workspace guards remain fail-closed while admitting exact V2 inventory and unit evidence', () => {
  assert.match(compact, /t\.kind='publish_inventory' AND t\.status='succeeded' AND t\.validation_contract='inventory-publication-v2'/);
  assert.match(compact, /a\.artifact_kind='inventory_receipt' AND a\.validation_contract='inventory-publication-v2'/);
  assert.match(compact, /NEW\.validation_contract='lesson-author-inventory-publication-v2'/);
  assert.match(compact, /n\.kind NOT IN \('unit','component'\)/);
  assert.match(compact, /NEW\.validation_contract<>'orchestration-unit-baseline-v2'/);
  assert.match(compact, /t\.accounting_state<>'reserved'/);
  assert.match(compact, /artifact_kind='unit_baseline' AND artifact_hash=t\.result_hash/);
  assert.match(compact, /trg_la_ws_v2_unit_atomic AFTER UPDATE ON public\.lesson_author_workspace_v2_tasks DEFERRABLE INITIALLY DEFERRED/);
  assert.match(compact, /Entire V2 unit baseline, artifact, unit_ready and success must commit atomically/);
});

test('all V2 relations are server-only, quota-owned and deletion-fenced', () => {
  assert.match(compact, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(compact, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.match(compact, /trg_deletion_fence_course_write BEFORE INSERT OR UPDATE/);
  assert.match(compact, /tenant_data_quota_table_registry\(relation_name,tenant_column,is_active\)/);
  assert.match(compact, /tenant_data_quota_ownership_manifest\(relation_name,classification,note\)/);
  assert.match(compact, /tenant_data_quota_direct_insert AFTER INSERT/);
  assert.match(compact, /tenant_data_quota_direct_update AFTER UPDATE/);
  assert.match(compact, /tenant_data_quota_direct_delete AFTER DELETE/);
  assert.match(compact, /FOREACH relation IN ARRAY ARRAY\[[^]*lesson_author_workspace_v2_completion_receipts[^]*\] LOOP/);
  assert.doesNotMatch(executable, /GRANT\s+[^;]*(?:anon|authenticated)/i);
});

test('source ledger is immutable, hash-bound and seals only exact admitted facts', () => {
  assert.match(compact, /source_document_ids UUID\[\] NOT NULL CHECK \(cardinality\(source_document_ids\) BETWEEN 1 AND 5\)/);
  assert.match(compact, /encode\(pg_catalog\.sha256\(convert_to\(NEW\.fact_text,'UTF8'\)\),'hex'\)<>NEW\.fact_hash/);
  assert.match(compact, /s\.status='building' AND d\.status='learned' AND NEW\.document_id=ANY\(s\.source_document_ids\)/);
  assert.match(compact, /count\(\*\)::integer,coalesce\(sum\(octet_length\(fact_text\)\),0\),count\(DISTINCT scope_key\)::integer INTO actual_facts,actual_bytes,actual_scopes/);
  assert.match(compact, /actual_facts<>NEW\.fact_count OR actual_bytes<>NEW\.content_bytes OR actual_scopes<>NEW\.scope_count/);
  assert.match(compact, /Source fact is immutable/);
  assert.match(compact, /Sealed\/failed source snapshot is immutable/);
});

test('task DAG has bounded provider work, backward dependencies and dispatch fences', () => {
  for (const kind of ['source_snapshot', 'course_skeleton', 'chapter_blueprint', 'validate_architecture', 'publish_inventory', 'generate_unit', 'validate_chapter', 'finalize_course']) {
    assert.match(executable, new RegExp(`'${kind}'`));
  }
  assert.match(compact, /max_attempts SMALLINT NOT NULL CHECK \(max_attempts BETWEEN 1 AND 2\)/);
  assert.match(compact, /provider_max_attempts SMALLINT NOT NULL CHECK \(provider_max_attempts BETWEEN 0 AND 2\)/);
  assert.match(compact, /max_output_tokens INTEGER NOT NULL CHECK \(max_output_tokens BETWEEN 0 AND 65536\)/);
  assert.match(compact, /execution_budget_ms INTEGER NOT NULL CHECK \(execution_budget_ms BETWEEN 1 AND 600000\)/);
  assert.match(compact, /parent_ordinal>=child_ordinal/);
  assert.match(compact, /p\.status<>'succeeded'/);
  assert.match(compact, /OLD\.dispatch_started_at IS NOT NULL OR NEW\.attempt_count>=NEW\.max_attempts/);
  assert.match(compact, /accounting_state<>'pending_reconciliation'/);
  assert.match(compact, /UNIQUE \(task_id,dispatch_epoch\)/);
  assert.match(compact, /V2 outbox requires exact queued dispatch epoch/);
  assert.match(compact, /V2 run requires a fresh building source snapshot/);
  assert.match(compact, /V2 manifest seal invalid/);
  assert.match(compact, /NEW\.contract_hash,NEW\.input_context_hash,NEW\.priority/);
  assert.match(compact, /OLD\.contract_hash,OLD\.input_context_hash,OLD\.priority/);
  assert.match(compact, /payload JSONB NOT NULL CHECK \(jsonb_typeof\(payload\)='object' AND octet_length\(payload::text\)<=16777216\)/);
});

test('ready is gated by immutable all-task and exact all-fact completion evidence', () => {
  assert.match(compact, /duplicate_fact_count INTEGER NOT NULL CHECK \(duplicate_fact_count=0\)/);
  assert.match(compact, /unresolved_fact_count INTEGER NOT NULL CHECK \(unresolved_fact_count=0\)/);
  assert.match(compact, /admitted_fact_count=allocated_fact_count AND admitted_fact_count=covered_fact_count/);
  assert.match(compact, /succeeded<>r\.task_count OR chapters<>NEW\.chapter_receipt_count OR chapter_artifacts<>NEW\.chapter_receipt_count OR course_artifacts<>1 OR facts<>NEW\.admitted_fact_count/);
  assert.match(compact, /artifact_kind='chapter_receipt' AND a\.artifact_hash=t\.result_hash/);
  assert.match(compact, /artifact_kind='course_receipt' AND a\.artifact_hash=t\.result_hash/);
  assert.match(compact, /trg_la_ws_v2_completion_task_atomic AFTER UPDATE ON public\.lesson_author_workspace_v2_tasks DEFERRABLE INITIALLY DEFERRED/);
  assert.match(compact, /trg_la_ws_v2_completion_artifact_atomic AFTER INSERT ON public\.lesson_author_workspace_v2_artifacts DEFERRABLE INITIALLY DEFERRED/);
  assert.match(compact, /Finalizer success, receipt, event and ready states must commit atomically/);
  assert.match(compact, /Ready V2 workspace requires complete accepted inventory and final receipt/);
  assert.match(compact, /Ready V2 run requires completion receipt/);
  assert.match(compact, /V2 completion receipt is immutable/);
});

test('rollback remains reviewable comments and refuses nonempty evidence', () => {
  const rollback = sql.slice(sql.indexOf('-- ROLLBACK SQL'));
  assert.ok(rollback.startsWith('-- ROLLBACK SQL'));
  assert.ok(rollback.split(/\r?\n/).every((line) => line.length === 0 || line.trimStart().startsWith('--')));
  assert.match(rollback, /Refusing rollback of nonempty orchestration V2 evidence/);
  assert.match(rollback, /Do not continue rollback while any dual-lane guard still references V2 catalogs/);
  assert.doesNotMatch(rollback, /DROP TABLE[^\n]*CASCADE/i);
});
