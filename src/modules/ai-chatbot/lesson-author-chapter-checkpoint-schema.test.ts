import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

// Read-only migration-file regression tests. These do not execute PostgreSQL,
// validate PL/pgSQL semantics, or replace manual staging acceptance.
const file = new URL('../../../../supabase/manual_sql/20260926_0237_lesson_author_chapter_checkpoints.sql', import.meta.url);
const sql = readFileSync(file, 'utf8');
const executable = sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');

test('startup guard fingerprints match the approved SQL, without executing SQL or importing runtime', () => {
  const runtime = readFileSync(new URL('./lesson-author-chapter-runtime.service.ts', import.meta.url), 'utf8');
  for (const name of ['guard_lesson_author_chapter_draft', 'guard_lesson_author_chapter_attempt',
    'guard_lesson_author_chapter_unit', 'assert_lesson_author_chapter_publication']) {
    const start = sql.indexOf(`CREATE FUNCTION public.${name}()`);
    assert.ok(start >= 0);
    const bodyStart = sql.indexOf('AS $guard$', start) + 'AS $guard$'.length;
    const body = sql.slice(bodyStart, sql.indexOf('$guard$;', bodyStart)).replace(/\r/g, '').trim();
    const hash = createHash('md5').update(body).digest('hex');
    assert.ok(runtime.includes(`${name}:'${hash}'`), `readiness fingerprint mismatch: ${name}`);
  }
});
function functionBody(name: string): string {
  const marker = `CREATE FUNCTION public.${name}()`;
  const start = executable.indexOf(marker);
  assert.notEqual(start, -1);
  const end = executable.indexOf('$guard$;', start);
  assert.notEqual(end, -1);
  return executable.slice(start, end);
}

test('manual chapter SQL is additive, transactional, and does not alter course/Apply/Blueprint jobs', () => {
  assert.match(executable.trim(), /^BEGIN;/);
  assert.match(executable.trim(), /COMMIT;$/);
  assert.equal((executable.match(/CREATE TABLE public\./g) ?? []).length, 3);
  assert.doesNotMatch(executable, /(?:ALTER|DROP|TRUNCATE) TABLE public\.(?:courses|course_blocks|lesson_author_jobs|lesson_author_generation_jobs|lesson_author_blueprints)\b/i);
  assert.doesNotMatch(executable, /(?:UPDATE|DELETE FROM|INSERT INTO) public\.(?:courses|course_blocks|lesson_author_jobs|lesson_author_generation_jobs|lesson_author_blueprints|ai_token_reservations)\b/i);
  assert.doesNotMatch(executable, /DROP TABLE|DROP FUNCTION|CREATE POLICY|SECURITY DEFINER/i);
  assert.match(sql, /Direct execution by Codex: Forbidden/);
});

test('all checkpoint relations have tenant composite ownership, RLS, quota and deletion registration', () => {
  for (const name of ['lesson_author_chapter_drafts', 'lesson_author_chapter_attempts', 'lesson_author_chapter_units']) {
    assert.match(executable, new RegExp(`CREATE TABLE public\.${name} \\(`));
    assert.ok(executable.includes(`'${name}'`));
  }
  assert.ok(executable.includes('FOREIGN KEY (attempt_id, draft_id, tenant_id, course_id)'));
  assert.ok(executable.includes('FOREIGN KEY (draft_id, tenant_id, course_id)'));
  assert.match(executable, /ENABLE ROW LEVEL SECURITY/);
  assert.match(executable, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  for (const trigger of ['tenant_data_quota_direct_insert', 'tenant_data_quota_direct_update', 'tenant_data_quota_direct_delete', 'trg_deletion_fence_course_write']) {
    assert.ok(executable.includes(`CREATE TRIGGER ${trigger}`));
  }
  assert.match(executable, /SELECT public\.tenant_data_quota_assert_coverage\(\);\s*COMMIT;/);
});

test('draft identities are immutable and bind exact source/Blueprint/unit inventory', () => {
  const body = functionBody('guard_lesson_author_chapter_draft');
  for (const field of ['blueprint_hash', 'source_snapshot_hash', 'course_outline_hash', 'runtime_config_hash', 'unit_contracts', 'locale', 'model', 'requested_by']) {
    assert.ok(body.includes(`NEW.${field}`) && body.includes(`OLD.${field}`));
  }
  assert.match(body, /b\.conversation_id = NEW\.conversation_id/);
  assert.match(body, /b\.requested_by = NEW\.requested_by/);
  assert.match(body, /Chapter source scope invalid/);
  assert.match(body, /Duplicate chapter unit address/);
});

test('resuming is a new explicit attempt, not redispatch of an ended paid call', () => {
  const body = functionBody('guard_lesson_author_chapter_attempt');
  assert.match(body, /previous\.status NOT IN \('timed_out', 'outcome_unknown'\)/);
  assert.match(body, /NEW\.previous_attempt_id IS DISTINCT FROM previous\.id/);
  assert.match(body, /NEW\.attempt_number <> previous\.attempt_number \+ 1/);
  assert.match(body, /NEW\.user_message_id = previous\.user_message_id/);
  assert.match(body, /Ended chapter attempt is immutable/);
  assert.match(body, /Chapter dispatch marker is irreversible/);
  assert.match(executable, /uq_la_chapter_running_attempt[\s\S]*?WHERE status = 'running'/);
  assert.match(body, /Cannot dispatch an invalid or completed unit/);
});

test('unknown usage remains held and reservations are bound to exact new attempt', () => {
  assert.match(executable, /la_chapter_unknown_usage_hold CHECK \([\s\S]*?accounting_state = 'pending_reconciliation'/);
  const body = functionBody('guard_lesson_author_chapter_attempt');
  assert.ok(body.includes("r.budget_metadata->>'durable_generation' = 'true'"));
  assert.ok(body.includes("r.budget_metadata->>'chapter_attempt_id' = NEW.id::text"));
  assert.ok(body.includes("r.budget_metadata->>'chapter_draft_id' = NEW.draft_id::text"));
  assert.match(body, /r\.user_id = draft\.requested_by/);
  assert.match(executable, /ai_reservation_id UUID NOT NULL UNIQUE/);
});

test('late responses, changed contracts and checkpoint replacement remain fenced', () => {
  const body = functionBody('guard_lesson_author_chapter_unit');
  for (const condition of [
    "attempt.status <> 'running'", 'attempt.lease_token <> NEW.lease_token',
    'attempt.lease_expires_at <= clock_timestamp()', 'attempt.deadline_at <= clock_timestamp()',
    'attempt.in_flight_unit_index IS DISTINCT FROM NEW.unit_index',
    "NEW.contract_hash IS DISTINCT FROM expected->>'contract_hash'",
    "NEW.evidence_hash IS DISTINCT FROM expected->>'evidence_hash'",
  ]) assert.ok(body.includes(condition));
  assert.match(body, /IF TG_OP = 'UPDATE' THEN\s*RAISE EXCEPTION/);
  assert.match(body, /Delete the owning chapter draft, not an individual checkpoint/);
  assert.match(executable, /payload \? 'components'/);
  assert.match(executable, /octet_length\(payload::text\) <= 2097152/);
});

test('only full chapter publication can reference a proposed review job', () => {
  const body = functionBody('guard_lesson_author_chapter_draft');
  assert.match(body, /count\(\*\)[\s\S]*?<> NEW\.total_units/);
  assert.match(body, /j\.status = 'proposed'/);
  assert.match(body, /j\.blueprint_id = NEW\.blueprint_id/);
  assert.equal((executable.match(/DEFERRABLE INITIALLY DEFERRED/g) ?? []).length, 2);
  assert.match(functionBody('assert_lesson_author_chapter_publication'), /Chapter publication must commit with completed attempt/);
});

test('rollback cannot be run accidentally with install and refuses nonempty history', () => {
  assert.match(sql, /-- ROLLBACK IS COMMENTS ONLY/);
  const rollback = sql.slice(sql.indexOf('-- ROLLBACK IS COMMENTS ONLY'));
  assert.ok(rollback.split(/\r?\n/).every(line => !line.trim() || line.startsWith('--')));
  assert.match(rollback, /Refusing rollback of nonempty chapter checkpoint history/);
  assert.doesNotMatch(rollback, /DROP TABLE[^\n]*CASCADE/);
  assert.doesNotMatch(executable, /DELETE FROM public\.tenant_data_quota/);
});
