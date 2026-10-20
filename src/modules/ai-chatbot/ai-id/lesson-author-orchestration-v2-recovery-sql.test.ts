// Contract of SQL 20261020_1500 (author recovery) and its rollback: reviewed
// bodies, fences and the hash pins the backend checks at startup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { manualSqlSkip, readManualSql } from '../../../test-support/manual-sql.js';
import { ORCHESTRATION_V2_GUARDS } from './lesson-author-orchestration-v2-schema.repository.js';

const forward = readManualSql('20261020_1500_lesson_author_v2_recovery.sql');
const rollback = readManualSql('20261020_1500_lesson_author_v2_recovery_ROLLBACK.sql');
/** The apply tool's own test for a file that manages its transactions (plpgsql BEGIN has no semicolon). */
const TRANSACTION_CONTROL = /^\s*(BEGIN(\s+(TRANSACTION|WORK))?\s*;|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b)/im;
const executable = (sql: string) => sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');
const md5 = (text: string) => createHash('md5').update(text.replace(/\r/g, '').trim()).digest('hex');
function body(sql: string, name: string): string {
  const match = sql.match(new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(\\)[\\s\\S]*?AS \\$guard\\$\\r?\\n([\\s\\S]*?)\\r?\\n\\$guard\\$;`));
  assert.ok(match?.[1], `missing body of ${name}`);
  return match[1];
}
const RECOVERY_FUNCTIONS = ['guard_lesson_author_workspace_v2_run', 'guard_lesson_author_workspace_v2_task',
  'fence_lesson_author_workspace_baseline', 'guard_lesson_author_workspace_v2_recovery',
  'guard_lesson_author_workspace_v2_recovery_task', 'assert_lesson_author_workspace_v2_recovery_commit'];

test('recovery SQL: one transaction, fenced, private, quota-registered and pinned', { skip: manualSqlSkip }, () => {
  const sql = executable(forward);
  assert.doesNotMatch(sql, TRANSACTION_CONTROL, 'the apply tool wraps the file in one transaction');
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /SET LOCAL statement_timeout = '120s';/);
  assert.match(sql, /Active V2 tasks detected/);
  assert.match(sql, /run_hash='5d4828cdad69bded21a4a55f4c2bb124' AND task_hash='41929858fa2887bbe83d36d2555acf55'/);
  assert.match(sql, /baseline_hash='2849f826f369316db05ec64a4b17cf76'/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ARRAY\['anon','authenticated','service_role'\]/);
  assert.match(sql, /tenant_data_quota_table_registry\(relation_name,tenant_column,is_active\)/);
  assert.match(sql, /'direct',/);
  assert.match(sql, /trg_deletion_fence_course_write BEFORE INSERT OR UPDATE/);
  assert.match(sql, /'run_canceled',\s*'run_resumed'\)\)/);
  assert.match(sql, /SELECT public\.tenant_data_quota_assert_coverage\(\);/);
  assert.doesNotMatch(sql, /SECURITY DEFINER|DISABLE ROW LEVEL SECURITY|GRANT /i);
  for (const name of RECOVERY_FUNCTIONS) {
    const pinned = ORCHESTRATION_V2_GUARDS[`${name}()` as keyof typeof ORCHESTRATION_V2_GUARDS];
    assert.equal(md5(body(forward, name)), pinned, `${name} body and backend pin`);
    assert.ok(sql.includes(`('${name}()','${pinned}')`), `${name} postflight hash`);
  }
});

test('recovery SQL: resume needs the exact recorded stop; reopen needs settled accounting and fresh evidence', { skip: manualSqlSkip }, () => {
  const run = body(forward, 'guard_lesson_author_workspace_v2_run');
  assert.match(run, /OLD\.status='needs_action' AND NEW\.status='executing'/);
  assert.match(run, /rec\.prior_failure_code=OLD\.failure_code AND rec\.prior_finished_at=OLD\.finished_at/);
  assert.match(run, /OLD\.failure_code='ASSESSMENT_REVIEW_REQUIRED'/);
  assert.match(run, /t\.status='running'/);
  assert.match(run, /lesson_author_workspace_v2_completion_receipts/);
  assert.match(run, /lesson_author_workspace_v2_review_receipts/);
  assert.match(run, /OLD\.status IN \('ready','canceled'\) OR \(OLD\.status='needs_action' AND NEW\.status<>'executing'\)/);
  const task = body(forward, 'guard_lesson_author_workspace_v2_task');
  assert.match(task, /NEW\.dispatch_epoch=OLD\.dispatch_epoch\+1/);
  assert.match(task, /reopen\.generation>\(CASE WHEN OLD\.kind='generate_unit' THEN 3 ELSE 10 END\)/);
  assert.match(task, /accounted exactly once before reopen/);
  assert.match(task, /\(NEW\.status='queued'\)<>\(unmet=0\)/);
  // The replay of a reconciled unknown outcome (same epoch) is unchanged.
  assert.match(task, /OLD\.status='outcome_unknown' AND NEW\.status='queued'/);
  for (const fallback of [task, body(forward, 'fence_lesson_author_workspace_baseline')]) {
    assert.match(fallback, /dispatch_epoch>COALESCE\(\(SELECT max\(reopened\.reopen_epoch\)/);
  }
  const commit = body(forward, 'assert_lesson_author_workspace_v2_recovery_commit');
  assert.match(commit, /event_kind='run_resumed' AND e\.operation_id=rec\.idempotency_key/);
  assert.match(forward, /CREATE CONSTRAINT TRIGGER trg_la_ws_v2_recovery_commit AFTER INSERT[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
});

test('recovery ROLLBACK restores the reviewed bodies and refuses while evidence exists', { skip: manualSqlSkip }, () => {
  const sql = executable(rollback);
  assert.doesNotMatch(sql, TRANSACTION_CONTROL);
  assert.equal(md5(body(rollback, 'guard_lesson_author_workspace_v2_run')), '5d4828cdad69bded21a4a55f4c2bb124');
  assert.equal(md5(body(rollback, 'guard_lesson_author_workspace_v2_task')), '41929858fa2887bbe83d36d2555acf55');
  assert.equal(md5(body(rollback, 'fence_lesson_author_workspace_baseline')), '2849f826f369316db05ec64a4b17cf76');
  assert.match(sql, /Refusing rollback: recovery evidence exists/);
  assert.match(sql, /Refusing rollback: run_resumed workspace events exist/);
  assert.match(sql, /DROP TABLE public\.lesson_author_workspace_v2_recovery_tasks/);
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.guard_lesson_author_workspace_v2_recovery\(\)/);
  assert.doesNotMatch(sql, /'run_resumed'\)\)/);
  for (const pin of ['797d3b3440446a96a27ce68855507b50', 'e485690b8e42fe5a4d755bbcb86aadd2', '641b44ca42a8363783d9ce9fe4406c83']) {
    assert.ok(sql.includes(pin), `rollback drift fence accepts installed ${pin}`);
  }
});
