import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Static artifact regression only. No DB/provider/runtime imports or SQL execution.
// This does not parse/execute PL/pgSQL or prove locking, ACL, rollback or concurrency.
const sql = readFileSync(new URL('../../../../supabase/manual_sql/20260929_1833_lesson_author_workspace_execution_apply.sql', import.meta.url), 'utf8');
const foundation = readFileSync(new URL('../../../../supabase/manual_sql/20260929_1611_lesson_author_workspace_foundation.sql', import.meta.url), 'utf8');
const executable = sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');
const tables = ['lesson_author_workspace_runs', 'lesson_author_workspace_work_items',
  'lesson_author_workspace_apply_mappings', 'lesson_author_workspace_apply_receipts'];
function body(name: string, tag = 'guard') {
  const start = executable.indexOf(`CREATE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const from = executable.indexOf(`AS $${tag}$`, start);
  const to = executable.indexOf(`$${tag}$;`, from + 1);
  assert.ok(from > start && to > from, `unterminated ${name}`);
  return executable.slice(from, to);
}
function table(name: string) {
  const start = executable.indexOf(`CREATE TABLE public.${name} (`);
  const end = executable.indexOf('\n);', start);
  assert.ok(start >= 0 && end > start);
  return executable.slice(start, end);
}

test('one transactional manual artifact, four additive tables, no installed guard replacement or course/accounting DML', () => {
  assert.match(executable.trim(), /^BEGIN;/);
  assert.match(executable.trim(), /COMMIT;$/);
  assert.equal((executable.match(/CREATE TABLE public\./g) ?? []).length, 4);
  for (const name of tables) assert.ok(table(name));
  assert.doesNotMatch(executable, /CREATE OR REPLACE|DROP TABLE|DROP FUNCTION|CREATE POLICY|SECURITY DEFINER|DISABLE TRIGGER|DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(executable, /(?:UPDATE|DELETE FROM|INSERT INTO) public\.(?:courses|course_blocks|ai_token_reservations|ai_token_usage_ledger|ai_token_monthly_usage|lesson_author_generation_jobs)\b/i);
  assert.doesNotMatch(executable, /ALTER TABLE public\.(?:lesson_author_workspaces|lesson_author_workspace_nodes|lesson_author_workspace_revisions|lesson_author_workspace_events)\b/);
  assert.match(sql, /Direct execution by Codex: Forbidden/);
  assert.match(sql, /MANUAL INSTALLATION PENDING/);
});

test('preflight pins all seven unchanged foundation function bodies and rejects incompatible history', () => {
  const functions = [...foundation.matchAll(/CREATE FUNCTION public\.(\w+)\(\)[\s\S]*?AS \$guard\$([\s\S]*?)\$guard\$;/g)];
  assert.equal(functions.length, 7);
  for (const match of functions) {
    const fingerprint = createHash('md5').update(match[2].replace(/\r/g, '').trim()).digest('hex');
    assert.ok(executable.includes(`('${match[1]}','${fingerprint}')`), `foundation drift: ${match[1]}`);
    assert.ok(!executable.includes(`CREATE FUNCTION public.${match[1]}(`));
  }
  assert.match(executable, /p\.proconfig=ARRAY\['search_path=pg_catalog, public'\]/);
  assert.match(executable, /LOCK TABLE public\.lesson_author_workspaces[\s\S]*?IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(executable, /Existing generated\/Applied workspace history requires separate reconciliation/);
  assert.match(executable, /r\.revision=0 AND n\.kind IN \('unit','component'\)/);
});

test('every new relation gets no-browser ACL/RLS, direct quota and deletion guards', () => {
  for (const name of tables) assert.ok(executable.includes(`'${name}'`));
  for (const required of ['ENABLE ROW LEVEL SECURITY', 'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
    'CREATE TRIGGER trg_deletion_fence_course_write', 'CREATE TRIGGER tenant_data_quota_direct_insert',
    'CREATE TRIGGER tenant_data_quota_direct_update', 'CREATE TRIGGER tenant_data_quota_direct_delete',
    'public.tenant_data_quota_table_registry', 'public.tenant_data_quota_ownership_manifest']) {
    assert.ok(executable.includes(required));
  }
  assert.match(executable, /SELECT public\.tenant_data_quota_assert_coverage\(\);\s*COMMIT;/);
  assert.match(executable, /REVOKE ALL ON FUNCTION public\.[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(executable, /^\s*GRANT\s/im);
  for (const name of tables) assert.match(table(name), /FOREIGN KEY \(workspace_id,(?:node_id,)?tenant_id,course_id\)/);
});

test('manifest names match main builder and totals derive from all canonical units plus chapter validation', () => {
  const schema = table('lesson_author_workspace_runs');
  assert.match(schema, /budget_manifest->'version'='1'::jsonb/);
  assert.match(schema, /jsonb_typeof\(budget_manifest->'entries'\)='array'/);
  for (const name of ['token_ceiling', 'execution_budget_ms', 'blueprint_budget_tokens', 'total_authorized_tokens']) assert.ok(schema.includes(name));
  const guard = body('guard_lesson_author_workspace_run');
  for (const name of ['ordinal','node_id','kind','contract_hash','input_tokens','output_tokens','embedding_tokens',
    'max_output_tokens','max_provider_attempts','execution_budget_ms']) assert.ok(guard.includes(`'${name}'`));
  assert.match(guard, /array_agg\(x\.id ORDER BY x\.chapter_order,x\.lesson_order,x\.unit_order\)/);
  assert.match(guard, /Manifest must cover every unit and chapter validation exactly once/);
  assert.match(guard, /NEW\.token_ceiling<>tokens OR NEW\.execution_budget_ms<>duration/);
  assert.match(guard, /chapter_tokens>2000000/);
  assert.match(guard, /execution_budget_ms'\)::integer NOT BETWEEN 1 AND 600000/);
  assert.match(guard, /Run budget manifest is immutable/);
  assert.doesNotMatch(schema, /expires_at|paused_at|queue_deadline/);
});

test('validation-only work has zero output/attempts while input and retrieval remain in the budget', () => {
  const guard = body('guard_lesson_author_workspace_run');
  assert.match(guard, /n\.kind='chapter'[\s\S]*?max_output_tokens'\)::integer<>0 OR \(item->>'max_provider_attempts'\)::integer<>0/);
  assert.match(guard, /n\.kind='chapter' AND \(item->>'output_tokens'\)::bigint<>0/);
  assert.match(guard, /item_tokens:=\(item->>'input_tokens'\)::bigint\+\(item->>'output_tokens'\)::bigint\+\(item->>'embedding_tokens'\)::bigint/);
  assert.match(table('lesson_author_workspace_work_items'), /max_provider_attempts BETWEEN 0 AND 2/);
  assert.match(table('lesson_author_workspace_work_items'), /max_output_tokens BETWEEN 0 AND 65536/);
  assert.match(body('guard_lesson_author_workspace_work_item'), /NEW\.kind='validate_chapter' AND NEW\.observed_usage->>'usage_source'='no_generation'/);
});

test('admission is one exact reserved claim per ordinal, and never a dispatched replay', () => {
  const schema = table('lesson_author_workspace_work_items');
  assert.match(schema, /UNIQUE \(workspace_id,ordinal\)/);
  assert.match(schema, /UNIQUE \(workspace_id,idempotency_key\)/);
  assert.match(executable, /uq_la_workspace_running_item[\s\S]*?WHERE status='running'/);
  const guard = body('guard_lesson_author_workspace_work_item');
  assert.match(guard, /Only next never-dispatched work may be admitted/);
  assert.match(guard, /Ended work item is immutable; no replay/);
  assert.match(guard, /Work item identity\/lease token\/deadline is immutable/);
  assert.match(guard, /Work item dispatch is irreversible/);
  assert.match(guard, /Dispatch requires separate live running transition/);
  assert.match(guard, /r\.estimated_tokens<>NEW\.reserved_tokens/);
  assert.match(guard, /r\.expires_at<NEW\.deadline_at/);
  assert.ok(guard.includes("r.budget_metadata->>'workspace_work_item_id' IS DISTINCT FROM NEW.id::text"));
  assert.ok(guard.includes("r.budget_metadata->>'workspace_id' IS DISTINCT FROM w.id::text"));
  assert.ok(guard.includes("r.budget_metadata->>'durable_generation' IS DISTINCT FROM 'true'"));
});

test('unknown execution cannot release quota or silently continue the run', () => {
  const guard = body('guard_lesson_author_workspace_work_item');
  assert.match(guard, /Dispatched expired work is outcome_unknown, not safe timeout/);
  assert.match(guard, /NEW\.accounting_state='pending_reconciliation' AND \(r\.status<>'reserved'/);
  assert.match(guard, /workspace_accounting'->'observed_usage' IS DISTINCT FROM NEW\.observed_usage/);
  assert.match(guard, /Dispatched settlement requires complete finalized ledger evidence/);
  assert.match(guard, /r\.actual_total_tokens IS DISTINCT FROM \(NEW\.observed_usage->>'totalTokens'\)::bigint/);
  assert.match(body('assert_lesson_author_workspace_unit_commit'), /Ended work must atomically stop run with durable event/);
  assert.match(body('assert_lesson_author_workspace_unit_commit'), /status IN \('needs_action','canceled'\)/);
  assert.match(body('assert_lesson_author_workspace_run_commit'), /Stopped\/ready run cannot retain a live work item/);
});

test('generated baseline operation id is an actual live work item; inventory metadata remains allowed', () => {
  const guard = body('fence_lesson_author_workspace_baseline');
  assert.match(guard, /n\.kind NOT IN \('unit','component'\) THEN RETURN NEW/);
  assert.match(guard, /id=NEW\.operation_id FOR UPDATE/);
  assert.match(guard, /a\.node_id IS DISTINCT FROM \(CASE WHEN n\.kind='unit' THEN n\.id ELSE n\.parent_id END\)/);
  for (const fence of ["a.status<>'running'", 'a.dispatch_started_at IS NULL',
    'a.lease_expires_at<=clock_timestamp()', 'a.deadline_at<=clock_timestamp()']) assert.ok(guard.includes(fence));
  assert.match(guard, /NEW\.validation_contract<>'workspace-unit-baseline-1'/);
});

test('CASE expressions in the three IF guards are parenthesized so inner THEN cannot terminate the condition', () => {
  // Regression for user-reported PostgreSQL 42601 at the manifest IF (line 360).
  // This is a targeted static check, not a substitute for PL/pgSQL compilation.
  assert.doesNotMatch(executable, /IS\s+DISTINCT\s+FROM\s+CASE\b/i);
  assert.match(body('guard_lesson_author_workspace_run'), /item->>'kind' IS DISTINCT FROM \(CASE n\.kind WHEN 'unit' THEN 'generate_unit' ELSE 'validate_chapter' END\)/);
  assert.match(body('guard_lesson_author_workspace_work_item'), /NEW\.validation_contract IS DISTINCT FROM\s+\(CASE NEW\.kind WHEN 'generate_unit' THEN 'workspace-unit-baseline-1' ELSE 'workspace-chapter-baseline-1' END\) THEN/);
  assert.match(body('fence_lesson_author_workspace_baseline'), /a\.node_id IS DISTINCT FROM \(CASE WHEN n\.kind='unit' THEN n\.id ELSE n\.parent_id END\)/);
});

test('concrete unit publication API requires token and exact unit set with a final database CAS', () => {
  const publish = body('publish_lesson_author_workspace_unit', 'publish');
  assert.match(publish, /a\.lease_token IS DISTINCT FROM p_lease_token/);
  assert.match(publish, /jsonb_array_length\(p_baselines\)<>expected_count/);
  assert.match(publish, /count\(DISTINCT value->>'node_id'\)/);
  const insert = publish.indexOf('INSERT INTO public.lesson_author_workspace_revisions');
  const event = publish.indexOf("'unit_ready',a.node_id,0,a.id");
  const cas = publish.indexOf('UPDATE public.lesson_author_workspace_work_items');
  assert.ok(insert > 0 && event > insert && cas > event);
  assert.match(publish, /lease_token=p_lease_token AND status='running'[\s\S]*?lease_expires_at>clock_timestamp\(\) AND deadline_at>clock_timestamp\(\)/);
  assert.match(publish, /GET DIAGNOSTICS affected=ROW_COUNT/);
  assert.match(publish, /IF affected<>1 THEN RAISE EXCEPTION/);
  const deferred = body('assert_lesson_author_workspace_unit_commit');
  assert.match(deferred, /Entire unit baseline, unit_ready and success must commit atomically/);
  assert.match(deferred, /Execution expired before publication commit/);
  assert.match(deferred, /Partial unit publication without success is forbidden/);
  assert.match(executable, /trg_la_workspace_baseline_commit[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
  assert.match(executable, /trg_la_workspace_item_commit[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
});

test('Apply binds exact effective revisions and scope; no metadata Save receipt can authorize it', () => {
  const schema = table('lesson_author_workspace_apply_receipts');
  assert.match(schema, /validation_contract='workspace-scoped-apply-1'/);
  assert.match(schema, /UNIQUE \(workspace_id,scope_node_id,revision_set_hash\)/);
  assert.match(schema, /UNIQUE \(workspace_id,idempotency_key\)/);
  const guard = body('guard_lesson_author_workspace_apply_receipt');
  assert.match(guard, /scope\.kind NOT IN \('chapter','lesson','unit','component'\)/);
  assert.match(guard, /NEW\.expected_workspace_revision<>w\.event_head/);
  assert.match(guard, /NEW\.source_snapshot_hash<>w\.source_snapshot_hash/);
  assert.match(guard, /r\.revision=n\.current_revision/);
  assert.match(guard, /Selected Apply subtree is incomplete/);
  assert.match(guard, /Unmapped target requires explicit creation, never title takeover/);
  assert.match(schema, /"security":"PASS"/);
  assert.match(schema, /"dependencies":"PASS"/);
});

test('mapping identity and actual block hierarchy/type/order are preserved and receipt backed', () => {
  const guard = body('guard_lesson_author_workspace_apply_mapping');
  assert.match(table('lesson_author_workspace_apply_mappings'), /target_block_id UUID NOT NULL UNIQUE/);
  assert.match(guard, /Mapping identity\/order is immutable; new receipt required/);
  for (const field of ['target_block_id','target_parent_id','target_block_type','target_sort_order']) assert.ok(guard.includes(`NEW.${field}`));
  assert.match(guard, /b\.metadata->>'workspace_node_id' IS DISTINCT FROM NEW\.node_id::text/);
  assert.match(guard, /b\.metadata->>'component_plan_id' IS DISTINCT FROM n\.protected_contract->'metadata'->>'component_plan_id'/);
  assert.match(guard, /b\.block_type::text<>expected_type/);
  assert.match(guard, /b\.block_type::text<>NEW\.target_block_type/);
  assert.doesNotMatch(guard, /b\.block_type<>expected_type|b\.block_type<>NEW\.target_block_type/);
  assert.match(guard, /Mapped parent required first/);
  assert.doesNotMatch(guard, /n\.sort_order<>NEW\.target_sort_order/);
  assert.match(guard, /m\.target_sort_order-sibling\.sort_order<>NEW\.target_sort_order-n\.sort_order/);
  assert.match(guard, /other\.sort_order=b\.sort_order/);
  assert.match(guard, /Mapping requires exact same-transaction receipt delta/);
  const deferred = body('assert_lesson_author_workspace_apply_commit');
  assert.match(deferred, /Apply receipt and scope_applied must commit together/);
  assert.match(deferred, /Apply target\/mapping read-back changed before commit/);
  assert.match(body('workspace_course_block_hash', 'hash'), /to_jsonb\(b\)::text/);
});

test('rollback is entirely commented, refuses populated evidence and removes only the additive increment', () => {
  const rollback = sql.slice(sql.indexOf('-- ROLLBACK IS COMMENTS ONLY'));
  assert.ok(rollback.startsWith('-- ROLLBACK IS COMMENTS ONLY'));
  assert.ok(rollback.split(/\r?\n/).every(line => !line.trim() || line.startsWith('--')));
  for (const name of tables) assert.ok(rollback.includes(`EXISTS(SELECT 1 FROM public.${name})`));
  assert.match(rollback, /Refusing rollback of nonempty workspace execution\/Apply history/);
  assert.doesNotMatch(rollback, /DROP TABLE[^\n]*CASCADE/);
  assert.doesNotMatch(rollback, /DROP TABLE public\.(?:lesson_author_workspaces|lesson_author_workspace_nodes|lesson_author_workspace_revisions|lesson_author_workspace_events);/);
});
