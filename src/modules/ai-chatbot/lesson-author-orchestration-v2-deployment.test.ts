import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const dedicatedPath = new URL('../../../ecosystem.lesson-author-orchestration-v2.config.cjs', import.meta.url);
const mainPath = new URL('../../../ecosystem.config.cjs', import.meta.url);
const applyReceiptPatchPath = new URL('../../../../supabase/manual_sql/20261002_1915_lesson_author_v2_apply_receipt_runtime_binding.sql', import.meta.url);
const applyReceiptAliasHotfixPath = new URL('../../../../supabase/manual_sql/20261002_2015_lesson_author_apply_receipt_alias_hotfix.sql', import.meta.url);
const applyMappingEnumHotfixPath = new URL('../../../../supabase/manual_sql/20261002_2045_lesson_author_apply_mapping_enum_hotfix.sql', import.meta.url);

test('V2 PM2 roles are isolated, explicit opt-in and readiness fenced', () => {
  const dedicated = require(dedicatedPath.pathname.replace(/^\/(.:)/, '$1')) as { apps: any[] };
  const main = require(mainPath.pathname.replace(/^\/(.:)/, '$1')) as { apps: any[] };
  assert.deepEqual(dedicated.apps.map(app => app.name), [
    'landa-lesson-author-v2-dispatcher', 'landa-lesson-author-v2-worker',
  ]);
  assert.equal(main.apps.some(app => dedicated.apps.some(v2 => v2.name === app.name)), false,
    'ordinary PM2 reload must not start V2 roles');
  for (const [index, app] of dedicated.apps.entries()) {
    assert.equal(app.script, './dist/workers/lesson-author-orchestration-v2.worker.js');
    assert.equal(app.exec_mode, 'fork');
    assert.equal(app.instances, 1);
    assert.equal(app.wait_ready, true);
    assert.ok(app.listen_timeout >= 60_000);
    assert.ok(app.kill_timeout > 600_000, 'drain must outlive the provider deadline');
    assert.equal(app.env.LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED, 'true');
    assert.equal(app.env.LESSON_AUTHOR_ORCHESTRATION_V2_ROLE, index === 0 ? 'dispatcher' : 'worker');
    assert.equal(app.env.LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT, '1');
    assert.equal(app.env.LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX, '0');
  }
  const api = main.apps.find(app => app.name === 'landa-refactor-backend');
  assert.notEqual(api?.env?.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED, 'true');
  assert.notEqual(api?.env_production?.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED, 'true');
});

test('worker signals readiness only after schema, Rabbit and role setup', () => {
  const source = readFileSync(new URL('../../../src/workers/lesson-author-orchestration-v2.worker.ts', import.meta.url), 'utf8');
  const schema = source.indexOf('await verifyOrchestrationV2Schema');
  const rabbit = source.indexOf('await connectRabbitMQ');
  const queue = source.indexOf('await assertQueue');
  const dispatcherReady = source.indexOf("signalReady('dispatcher'");
  const dispatcherLoop = source.indexOf('await runOrchestrationV2DispatcherLoop');
  const consumer = source.indexOf('consumer = await startOrchestrationV2RabbitConsumer');
  const workerReady = source.indexOf("signalReady('worker'");
  assert.ok(schema >= 0 && schema < rabbit && rabbit < queue);
  assert.ok(queue < dispatcherReady && dispatcherReady < dispatcherLoop);
  assert.ok(queue < consumer && consumer < workerReady);
  assert.match(source, /typeof process\.send === 'function'\) process\.send\('ready'\)/);
  assert.match(source, /runtime_draining/);
  assert.match(source, /runtime_stopped/);
});

test('V2 Apply receipt guard patch preserves lane identity and sealed source authority', () => {
  const sql = readFileSync(applyReceiptPatchPath.pathname.replace(/^\/(.:)/, '$1'), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_apply_receipt\(\)/);
  assert.match(sql, /IF w\.blueprint_id IS NOT NULL THEN/);
  assert.match(sql, /FROM public\.lesson_author_workspace_runs r/);
  assert.match(sql, /FROM public\.lesson_author_workspace_v2_runs r/);
  assert.match(sql, /JOIN public\.lesson_author_workspace_source_snapshots s/);
  assert.match(sql, /r\.runtime_config_hash=NEW\.runtime_config_hash/);
  assert.match(sql, /s\.status='sealed' AND s\.source_snapshot_hash=NEW\.source_snapshot_hash/);
  assert.match(sql, /r\.status IN \('executing','finalizing','ready','needs_action'\)/);
  assert.match(sql, /Apply manifests must have unique identities/);
  assert.match(sql, /Selected Apply subtree is incomplete/);
  assert.match(sql, /Apply delta scope\/revision\/target invalid/);
  assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP)\s/im,
    'patch must only replace the guard function; it must not rewrite persisted rows or schema');
});

test('Apply receipt alias hotfix removes every PL/pgSQL row-variable/table-alias collision', () => {
  const sql = readFileSync(applyReceiptAliasHotfixPath.pathname.replace(/^\/(.:)/, '$1'), 'utf8');
  assert.match(sql, /mapped_node public\.lesson_author_workspace_nodes%ROWTYPE/);
  assert.match(sql, /lesson_author_workspace_nodes node_row/);
  assert.match(sql, /lesson_author_workspace_revisions revision_row/);
  assert.doesNotMatch(sql, /\bn public\.lesson_author_workspace_nodes%ROWTYPE/);
  assert.doesNotMatch(sql, /lesson_author_workspace_nodes n\b/);
  assert.doesNotMatch(sql, /lesson_author_workspace_revisions r\b/);
  assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP)\s/im,
    'hotfix may replace the trigger function but must not rewrite persisted rows or schema');
});

test('Apply mapping hotfix compares the block_type enum through its reviewed text representation', () => {
  const sql = readFileSync(applyMappingEnumHotfixPath.pathname.replace(/^\/(.:)/, '$1'), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_apply_mapping\(\)/);
  assert.match(sql, /b\.block_type::text<>expected_type/);
  assert.match(sql, /b\.block_type::text<>NEW\.target_block_type/);
  assert.doesNotMatch(sql, /b\.block_type<>expected_type|b\.block_type<>NEW\.target_block_type/);
  assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP)\s/im,
    'hotfix may replace the trigger function but must not rewrite persisted rows or schema');
});
