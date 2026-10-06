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
const deterministicFallbackGuard = readFileSync(
  new URL('../../../../supabase/manual_sql/20261002_2355_lesson_author_orchestration_v2_fallback_success_guard.sql', import.meta.url),
  'utf8',
);
const deterministicFallbackBaselineFence = readFileSync(
  new URL('../../../../supabase/manual_sql/20261005_1149_lesson_author_v2_fallback_baseline_fence.sql', import.meta.url),
  'utf8',
);
const cp1QualityEvidence = readFileSync(
  new URL('../../../../supabase/manual_sql/20261005_1800_lesson_author_cp1_quality_evidence.sql', import.meta.url),
  'utf8',
);
const cp1AttemptRunAuthorityHotfix = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1025_lesson_author_cp1_attempt_run_authority_hotfix.sql', import.meta.url),
  'utf8',
);
const outboxRecoveryHotfix = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1045_lesson_author_v2_outbox_recovery_hotfix.sql', import.meta.url),
  'utf8',
);
const outboxGuardSchemaOnly = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1105_lesson_author_v2_outbox_guard_schema_only.sql', import.meta.url),
  'utf8',
);
const progressBackpressureHotfix = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1300_lesson_author_v2_progress_backpressure_hotfix.sql', import.meta.url),
  'utf8',
);
const assessmentAuthorityBackpressureHotfix = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1330_lesson_author_v2_assessment_authority_backpressure_hotfix.sql', import.meta.url),
  'utf8',
);
const workConservingCapacityWake = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1500_lesson_author_v2_work_conserving_capacity_wake.sql', import.meta.url),
  'utf8',
);
const providerReplayEvidenceFence = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1530_lesson_author_v2_provider_replay_evidence_fence.sql', import.meta.url),
  'utf8',
);
const needsActionNodeEditGuard = readFileSync(
  new URL('../../../../supabase/manual_sql/20261006_1600_lesson_author_v2_needs_action_node_edit_guard.sql', import.meta.url),
  'utf8',
);
const cp2bAssessmentObligations = readFileSync(
  new URL('../../../../supabase/manual_sql/20261005_1930_lesson_author_cp2b_assessment_obligations.sql', import.meta.url),
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
    const outboxSchemaGuard = outboxGuardSchemaOnly.includes(`FUNCTION public.${name}()`);
    const attemptAuthorityGuard = cp1AttemptRunAuthorityHotfix.includes(`FUNCTION public.${name}()`);
    const assessmentAuthorityGuard = assessmentAuthorityBackpressureHotfix.includes(`FUNCTION public.${name}()`);
    const capacityWakeGuard = workConservingCapacityWake.includes(`FUNCTION public.${name}()`);
    const replayEvidenceGuard = providerReplayEvidenceFence.includes(`FUNCTION public.${name}()`);
    const needsActionNodeGuard = needsActionNodeEditGuard.includes(`FUNCTION public.${name}()`);
    const cp2bGuard = cp2bAssessmentObligations.includes(`FUNCTION public.${name}()`);
    const cp1Guard = cp1QualityEvidence.includes(`FUNCTION public.${name}()`);
    const source = needsActionNodeGuard ? needsActionNodeEditGuard
      : replayEvidenceGuard ? providerReplayEvidenceFence
      : capacityWakeGuard ? workConservingCapacityWake
      : assessmentAuthorityGuard ? assessmentAuthorityBackpressureHotfix
      : outboxSchemaGuard ? outboxGuardSchemaOnly
      : attemptAuthorityGuard ? cp1AttemptRunAuthorityHotfix
      : cp2bGuard ? cp2bAssessmentObligations : cp1Guard ? cp1QualityEvidence
      : signature === 'guard_lesson_author_workspace_v2_task()'
      ? deterministicFallbackGuard
      : signature === 'fence_lesson_author_workspace_baseline()' ? deterministicFallbackBaselineFence : sql;
    const body = source.match(pattern)?.[1];
    assert.ok(body, `missing reviewed guard body: ${signature}`);
    assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'), expected);
  }
});

test('needs-action workspaces retain exact revision editing authority without weakening node fences', () => {
  const pattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_node\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = needsActionNodeEditGuard.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    ORCHESTRATION_V2_GUARDS['guard_lesson_author_workspace_node()']);
  assert.match(body, /r\.status IN \('planning','executing','finalizing','ready','needs_action'\)/);
  assert.match(body, /Workspace node scope invalid/);
  assert.match(body, /Node structure and provenance are immutable/);
  assert.match(body, /Accepted node cannot be reset to generation/);
  assert.match(body, /Node revision pointer invalid/);
  const executableHotfix = needsActionNodeEditGuard.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(executableHotfix, /^\s*BEGIN;/m);
  assert.match(executableHotfix, /COMMIT;\s*$/);
  assert.match(executableHotfix, /de68aa84684d9bfefcad7e04cdcf3eed/);
  assert.match(executableHotfix, /3e6fecf88368b46c1ee93b112056f026/);
  assert.doesNotMatch(executableHotfix,
    /\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+)\b/i);
  assert.doesNotMatch(executableHotfix, /SECURITY\s+DEFINER/i);
});

test('work-conserving capacity wake is guarded, data-neutral and indexed for bounded selection', () => {
  const pattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_v2_outbox\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = workConservingCapacityWake.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    ORCHESTRATION_V2_GUARDS['guard_lesson_author_workspace_v2_outbox()']);
  assert.match(body, /OLD\.status='pending' AND NEW\.status='pending'/);
  assert.match(body, /OLD\.capacity_deferral_count<=0/);
  assert.match(body, /NEW\.capacity_deferral_count<>OLD\.capacity_deferral_count/);
  assert.match(body, /NEW\.available_at IS DISTINCT FROM NEW\.updated_at OR NEW\.available_at>=OLD\.available_at/);
  assert.match(body, /Invalid V2 outbox capacity wake/);
  assert.match(workConservingCapacityWake, /idx_la_ws_v2_outbox_capacity_wake/);
  assert.match(workConservingCapacityWake, /idx_la_ws_v2_outbox_capacity_admitted/);
  assert.match(workConservingCapacityWake, /idx_la_ws_v2_task_running_capacity/);
  const executableHotfix = workConservingCapacityWake.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(executableHotfix, /^\s*BEGIN;/m);
  assert.match(executableHotfix, /COMMIT;\s*$/);
  assert.doesNotMatch(executableHotfix,
    /\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE|DISABLE TRIGGER)\b/i);
});

test('assessment authority/backpressure hotfix is additive, transactional and lifecycle exact', () => {
  const pattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_v2_assessment_obligation\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = assessmentAuthorityBackpressureHotfix.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    ORCHESTRATION_V2_GUARDS['guard_lesson_author_workspace_v2_assessment_obligation()']);
  assert.match(body, /run\.status='planning'/);
  assert.match(body, /task\.kind='validate_architecture' AND task\.status='succeeded'/);
  assert.match(body, /task\.result_hash=NEW\.plan_revision_hash/);
  assert.match(body, /task\.validation_contract='architecture-validation-v2'/);
  assert.match(body, /artifact\.artifact_hash=NEW\.plan_revision_hash/);
  assert.match(body, /artifact\.validation_contract='architecture-validation-v2'/);
  assert.doesNotMatch(body, /run\.status='executing'/);
  const outboxPattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_v2_outbox\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const outboxBody = assessmentAuthorityBackpressureHotfix.match(outboxPattern)?.[1];
  assert.ok(outboxBody);
  assert.equal(createHash('md5').update(outboxBody.replace(/\r/g, '').trim()).digest('hex'),
    '5d11bfd0893fba481e83c6d8b6c0d69b');
  assert.match(outboxBody, /NEW\.capacity_deferral_count<>0/);
  assert.match(outboxBody, /OLD\.status='published' AND NEW\.status='pending'/);
  assert.match(outboxBody, /NEW\.capacity_deferral_count<>LEAST\(OLD\.capacity_deferral_count\+1,1000000\)/);
  assert.match(outboxBody, /NEW\.available_at>NEW\.updated_at\+INTERVAL '121 seconds'/);
  assert.match(assessmentAuthorityBackpressureHotfix,
    /ADD COLUMN IF NOT EXISTS capacity_deferral_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(assessmentAuthorityBackpressureHotfix,
    /CHECK \(capacity_deferral_count>=0 AND capacity_deferral_count<=1000000\)/);
  assert.match(assessmentAuthorityBackpressureHotfix,
    /guard_hash NOT IN \('3aaf49ced403a83e5dce26830ceb1886','2a6558622c93fbab24922ab945ea702c'\)/);
  assert.match(assessmentAuthorityBackpressureHotfix,
    /outbox_guard_hash NOT IN \('5d6df34f7362db9b4bc40bdcce5d088c','5d11bfd0893fba481e83c6d8b6c0d69b'\)/);
  const executableHotfix = assessmentAuthorityBackpressureHotfix.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(executableHotfix, /^\s*BEGIN;/m);
  assert.match(executableHotfix, /COMMIT;\s*$/);
  assert.doesNotMatch(executableHotfix,
    /\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE|DISABLE TRIGGER|DROP\s+)/i);
});

test('production outbox guard hotfix is schema-only and release-coordinated', () => {
  const pattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_v2_outbox\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = outboxGuardSchemaOnly.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    '5d6df34f7362db9b4bc40bdcce5d088c');
  assert.match(outboxGuardSchemaOnly,
    /guard_hash NOT IN \('183be9ec3e0f3b848b82ec15a90aae0a','5d6df34f7362db9b4bc40bdcce5d088c'\)/);
  assert.match(outboxGuardSchemaOnly, /Do not run while the 2026-10-02 production backend/);
  const executableHotfix = outboxGuardSchemaOnly.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(executableHotfix, /^\s*BEGIN;/m);
  assert.match(executableHotfix, /COMMIT;\s*$/);
  assert.doesNotMatch(executableHotfix,
    /(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+)/i);
  assert.doesNotMatch(outboxGuardSchemaOnly,
    /e58a1340-bd10-467b-91c1-7a6615d224f1|0fe69d8c-045e-438e-8b3c-b6ef7ec7f763/);
});

test('progress/backpressure hotfix is transactional, data-neutral and fail-closed', () => {
  const hotfix = progressBackpressureHotfix.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(hotfix, /^\s*BEGIN;/m);
  assert.match(hotfix, /COMMIT;\s*$/);
  assert.match(hotfix, /'architecture_progressed'/);
  assert.match(hotfix, /IF v_delta\.delta_bytes = 0 THEN\s+CONTINUE;/);
  assert.match(hotfix, /SECURITY INVOKER/);
  assert.doesNotMatch(hotfix, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|public\.)\s*lesson_author_workspace_/i);
  assert.doesNotMatch(hotfix, /\b(?:TRUNCATE|DISABLE TRIGGER)\b/i);
});

test('outbox hotfix forbids confirmed-message republish and repairs only the reviewed stranded row', () => {
  const pattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_v2_outbox\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = outboxRecoveryHotfix.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    '5d6df34f7362db9b4bc40bdcce5d088c');
  assert.match(outboxRecoveryHotfix,
    /guard_hash IS DISTINCT FROM '183be9ec3e0f3b848b82ec15a90aae0a'/);
  assert.match(body, /OLD\.status='dead' AND NEW\.status='pending'/);
  assert.match(body, /OLD\.failure_code NOT IN \('BROKER_DELIVERY_EXHAUSTED','BROKER_PUBLISH_EXHAUSTED'\)/);
  assert.match(body, /NEW\.attempt_count<>OLD\.attempt_count-1/);
  assert.match(body, /task\.status='queued' AND task\.dispatch_epoch=NEW\.dispatch_epoch/);
  assert.match(body, /run\.status IN \('planning','executing'\)/);
  assert.match(outboxRecoveryHotfix,
    /id='e58a1340-bd10-467b-91c1-7a6615d224f1'::uuid[\s\S]*?status='dead' AND attempt_count=8/);
  assert.match(outboxRecoveryHotfix,
    /SET status='pending',attempt_count=attempt_count-1/);
  assert.match(outboxRecoveryHotfix,
    /Expected exactly one Lesson Author V2 outbox repair/);
  const executableHotfix = outboxRecoveryHotfix.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(executableHotfix, /^\s*BEGIN;/m);
  assert.match(executableHotfix, /COMMIT;\s*$/);
  assert.doesNotMatch(executableHotfix, /\b(?:DROP|TRUNCATE|DISABLE TRIGGER)\b/i);
});

test('CP1 attempt hotfix reads model/runtime authority only from the scoped run row', () => {
  const attemptPattern = /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_v2_attempt_event\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const capturePattern = /CREATE OR REPLACE FUNCTION public\.capture_lesson_author_workspace_v2_task_attempt\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const attemptBody = cp1AttemptRunAuthorityHotfix.match(attemptPattern)?.[1];
  const captureBody = cp1AttemptRunAuthorityHotfix.match(capturePattern)?.[1];
  assert.ok(attemptBody);
  assert.ok(captureBody);
  assert.match(attemptBody, /SELECT \* INTO run_row FROM public\.lesson_author_workspace_v2_runs/);
  assert.match(attemptBody, /NEW\.model IS DISTINCT FROM run_row\.model/);
  assert.match(attemptBody, /NEW\.runtime_config_hash IS DISTINCT FROM run_row\.runtime_config_hash/);
  assert.doesNotMatch(attemptBody, /task_row\.(?:model|runtime_config_hash)/);
  assert.match(captureBody, /SELECT \* INTO run_row FROM public\.lesson_author_workspace_v2_runs/);
  assert.match(captureBody, /run_row\.model,run_row\.runtime_config_hash/);
  assert.doesNotMatch(captureBody, /NEW\.(?:model|runtime_config_hash)/);
  assert.match(cp1AttemptRunAuthorityHotfix,
    /attempt_guard_hash IS DISTINCT FROM '41828578b15ac7d743b40c13f2fc6d38'/);
  assert.match(cp1AttemptRunAuthorityHotfix,
    /capture_guard_hash IS DISTINCT FROM 'e7dc15abe0ae09309b8d79dbb49776a1'/);
  assert.doesNotMatch(cp1AttemptRunAuthorityHotfix, /\b(?:DROP|ALTER TABLE|CREATE POLICY)\b/i);
});

test('CP1 quality evidence is transactional, metadata-only and keeps V1 Apply compatible', () => {
  const cp1Executable = cp1QualityEvidence.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(cp1Executable, /^\s*BEGIN;/m);
  assert.match(cp1Executable, /SELECT public\.tenant_data_quota_assert_coverage\(\);\s*COMMIT;\s*$/);
  assert.match(cp1Executable, /CREATE TABLE public\.lesson_author_workspace_quality_receipts/);
  assert.match(cp1Executable, /CREATE TABLE public\.lesson_author_workspace_v2_attempt_events/);
  assert.match(cp1Executable, /validation_contract='workspace-scoped-apply-1' AND quality_receipt_id IS NULL/);
  assert.match(cp1Executable, /validation_contract='workspace-scoped-apply-2' AND quality_receipt_id IS NOT NULL/);
  assert.match(cp1Executable, /"pedagogy":"NOT_RUN"/);
  assert.match(cp1Executable, /"dependencies":"NOT_APPLICABLE"/);
  assert.match(cp1Executable, /usage_source IN \('provider_reported','estimated','unknown'\)/);
  assert.match(cp1Executable, /trg_la_ws_v2_task_attempt AFTER UPDATE/);
  assert.match(cp1Executable, /Quality receipt and V2 Apply must commit one-to-one/);
  assert.match(cp1Executable,
    /constraint_row\.conkey=ARRAY\[\(SELECT attribute\.attnum FROM pg_attribute attribute[\s\S]*?attribute\.attname='validation_contract'[\s\S]*?\)\]::smallint\[\]/);
  assert.match(cp1Executable,
    /constraint_row\.conkey=ARRAY\[\(SELECT attribute\.attnum FROM pg_attribute attribute[\s\S]*?attribute\.attname='checks'[\s\S]*?\)\]::smallint\[\]/);
  assert.match(cp1Executable,
    /COALESCE\(cardinality\(contract_constraints\),0\)<>1[\s\S]*?COALESCE\(cardinality\(checks_constraints\),0\)<>1/);
  assert.doesNotMatch(cp1Executable, /LIKE '%checks%pedagogy%dependencies%registry%'/);
  assert.doesNotMatch(cp1Executable, /SECURITY\s+DEFINER/i);
  assert.doesNotMatch(cp1Executable, /(?:prompt|source_text|model_output)\s+(?:TEXT|JSONB)/i);
  assert.doesNotMatch(cp1Executable, /CREATE\s+(?:OR\s+REPLACE\s+)?POLICY/i);
});

test('CP2B assessment obligations are additive, private and never learner components', () => {
  const cp2bExecutable = cp2bAssessmentObligations.split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.match(cp2bExecutable, /^\s*BEGIN;/m);
  assert.match(cp2bExecutable, /SELECT public\.tenant_data_quota_assert_coverage\(\);\s*COMMIT;\s*$/);
  assert.match(cp2bExecutable, /CREATE TABLE public\.lesson_author_workspace_v2_assessment_obligations/);
  assert.match(cp2bExecutable, /CREATE TABLE public\.lesson_author_workspace_v2_review_receipts/);
  assert.match(cp2bExecutable, /status VARCHAR\(16\) NOT NULL DEFAULT 'open' CHECK \(status IN \('open','resolved'\)\)/);
  assert.match(cp2bExecutable, /required_assessment_kind VARCHAR\(32\) NOT NULL CHECK \(required_assessment_kind='single_choice'\)/);
  assert.match(cp2bExecutable, /validation_contract='orchestration-course-review-required-v1'/);
  assert.match(cp2bExecutable, /event_kind='run_needs_action'/);
  assert.match(cp2bExecutable, /r\.status='needs_action' AND r\.failure_code='ASSESSMENT_REVIEW_REQUIRED'/);
  assert.match(cp2bExecutable, /w\.status='needs_action'/);
  assert.match(cp2bExecutable, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.match(cp2bExecutable, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(cp2bExecutable, /tenant_data_quota_table_registry\(relation_name,tenant_column,is_active\)/);
  assert.match(cp2bExecutable, /trg_deletion_fence_course_write BEFORE INSERT OR UPDATE/);
  assert.doesNotMatch(cp2bExecutable, /ready_for_review/);
  assert.doesNotMatch(cp2bExecutable,
    /(?:INSERT INTO|UPDATE|DELETE FROM) public\.lesson_author_workspace_(?:nodes|revisions|apply_mappings|apply_receipts)\b/i);
  assert.doesNotMatch(cp2bExecutable, /CREATE\s+(?:OR\s+REPLACE\s+)?POLICY/i);
  assert.doesNotMatch(cp2bExecutable, /SECURITY\s+DEFINER/i);
});

test('CP2B completion guard keeps ready and review-required outcomes mutually exclusive', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.assert_lesson_author_workspace_v2_completion_commit\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = cp2bAssessmentObligations.match(pattern)?.[1];
  assert.ok(body);
  assert.match(body, /t\.validation_contract='orchestration-course-finalization-v2'/);
  assert.match(body, /EXISTS\(SELECT 1 FROM public\.lesson_author_workspace_v2_review_receipts c WHERE c\.run_id=t\.run_id\)/);
  assert.match(body, /t\.validation_contract='orchestration-course-review-required-v1'/);
  assert.match(body, /EXISTS\(SELECT 1 FROM public\.lesson_author_workspace_v2_completion_receipts c WHERE c\.run_id=t\.run_id\)/);
  assert.match(body, /RAISE EXCEPTION 'Unsupported finalizer terminal contract'/);
  assert.match(cp2bAssessmentObligations, /current_hash NOT IN \('397e0d0394703136479379d064739faf'\)/);
});

test('outcome replay guard requires pessimistic accounting before one bounded retry', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.guard_lesson_author_workspace_v2_task\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = outcomeReplayGuard.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    '22ed2b31cb88939fb9b5c55addfce85a');
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

test('deterministic unit fallback is the only undispatched provider success admitted by the current guard', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.guard_lesson_author_workspace_v2_task\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = providerReplayEvidenceFence.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    ORCHESTRATION_V2_GUARDS['guard_lesson_author_workspace_v2_task()']);
  assert.match(body, /deterministic_fallback:=NEW\.kind='generate_unit' AND NEW\.status='succeeded'/);
  assert.match(body, /OLD\.attempt_count>=2 AND OLD\.dispatch_epoch>=2/);
  assert.match(body, /prior_attempt\.provider_dispatched AND prior_attempt\.dispatch_epoch<OLD\.dispatch_epoch/);
  assert.match(body, /NEW\.accounting_state='not_required' AND NEW\.ai_reservation_id IS NULL/);
  assert.match(body, /NEW\.validation_contract='orchestration-unit-baseline-v2'/);
  assert.match(body, /NEW\.status='succeeded' AND NOT deterministic_fallback/);
  const executableCorrection = providerReplayEvidenceFence.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(executableCorrection, /\bDROP\b/i);
  assert.match(executableCorrection, /^\s*BEGIN;/m);
  assert.match(executableCorrection, /COMMIT;\s*$/);
});

test('baseline fence admits only an evidenced deterministic fallback while preserving the paid-provider lane', () => {
  const pattern = /CREATE (?:OR REPLACE )?FUNCTION public\.fence_lesson_author_workspace_baseline\(\)[\s\S]*?AS \$guard\$\r?\n([\s\S]*?)\r?\n\$guard\$;/;
  const body = providerReplayEvidenceFence.match(pattern)?.[1];
  assert.ok(body);
  assert.equal(createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex'),
    ORCHESTRATION_V2_GUARDS['fence_lesson_author_workspace_baseline()']);
  assert.match(providerReplayEvidenceFence,
    /baseline_hash IS DISTINCT FROM '56a4bd1e8ab5bc88288e9b3ec187ade4'/);
  assert.match(providerReplayEvidenceFence,
    /task_hash IS DISTINCT FROM '22b6946da0d57898ecc7a28915c7cc94'/);
  assert.match(body, /t\.attempt_count>=2 AND t\.dispatch_epoch>=2/);
  assert.match(body, /t\.dispatch_started_at IS NULL AND t\.accounting_state='reserved'/);
  assert.match(body, /r\.status='released'/);
  assert.match(body, /prior_attempt\.provider_dispatched AND prior_attempt\.dispatch_epoch<t\.dispatch_epoch/);
  assert.match(body, /artifact\.artifact_kind='unit_baseline'/);
  assert.match(body, /artifact\.payload->>'content_origin'='structured_fallback'/);
  assert.match(body, /artifact\.payload->>'quality_state'='review_required'/);
  assert.match(body,
    /\(t\.dispatch_started_at IS NOT NULL AND t\.accounting_state='reserved'\) OR deterministic_fallback/);
  const executableCorrection = providerReplayEvidenceFence.split(/\r?\n/)
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
