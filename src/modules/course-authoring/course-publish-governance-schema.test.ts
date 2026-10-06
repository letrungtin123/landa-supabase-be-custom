import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COURSE_PUBLISH_GOVERNANCE_FUNCTIONS,
  COURSE_PUBLISH_GOVERNANCE_TABLES,
  coursePublishFunctionBodyHash,
} from './course-publish-governance-schema.repository.js';

const sql = readFileSync(new URL('../../../../supabase/manual_sql/20261006_0900_course_publish_governance_cp5.sql',
  import.meta.url), 'utf8');
const applyRepository = readFileSync(new URL('../ai-chatbot/lesson-author-workspace-apply.repository.ts',
  import.meta.url), 'utf8');

function functionBody(name: string): string {
  const expression = new RegExp(`CREATE FUNCTION public\\.${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\([\\s\\S]*?\\)`
    + `[\\s\\S]*?AS \\$(\\w+)\\$([\\s\\S]*?)\\$\\1\\$;`);
  const match = expression.exec(sql);
  assert.ok(match, `missing SQL function ${name}`);
  return match[2]!;
}

test('manual SQL is additive/private and keeps legacy Apply row fingerprints stable', () => {
  for (const table of COURSE_PUBLISH_GOVERNANCE_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
  }
  assert.doesNotMatch(sql, /ALTER TABLE public\.course_blocks\s+ADD COLUMN authoring_revision/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.workspace_course_block_hash/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /tenant_data_quota_assert_coverage\(\)/);
  assert.match(sql, /Backfill only after quota\/deletion triggers are active/);
});

test('reviewed database guard bodies are pinned exactly', () => {
  for (const [signature, expected] of Object.entries(COURSE_PUBLISH_GOVERNANCE_FUNCTIONS)) {
    const name = signature.slice(0, signature.indexOf('('));
    assert.equal(coursePublishFunctionBodyHash(functionBody(name)), expected, signature);
  }
});

test('publish and every structural mutation share one per-course transaction lock', () => {
  const fence = functionBody('fence_course_publish_mutation');
  const evidenceFence = functionBody('fence_course_publish_evidence_mutation');
  const begin = functionBody('begin_course_publish_candidate');
  assert.match(fence, /pg_advisory_xact_lock\(hashtextextended\('course:'\|\|v_tenant_id::text\|\|':'\|\|v_course_id,20261006\)\)/);
  assert.match(begin, /pg_advisory_xact_lock\(hashtextextended\('course:'\|\|p_tenant_id::text\|\|':'\|\|p_course_id,20261006\)\)/);
  assert.match(evidenceFence, /pg_advisory_xact_lock\(hashtextextended\('course:'\|\|v_tenant_id::text\|\|':'\|\|v_course_id,20261006\)\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE\s+ON public\.course_blocks/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE\s+ON public\.course_assets/);
  assert.equal((sql.match(/CREATE TRIGGER trg_course_publish_evidence_mutation_fence/g) ?? []).length, 5);
});

test('high-risk publish has no approval, stale receipt, critical finding or assessment bypass', () => {
  const begin = functionBody('begin_course_publish_candidate');
  for (const code of ['COURSE_PUBLISH_APPROVAL_REQUIRED', 'COURSE_PUBLISH_QUALITY_RECEIPT_STALE',
    'COURSE_PUBLISH_ASSESSMENT_REVIEW_REQUIRED', 'COURSE_PUBLISH_CRITICAL_FINDINGS_UNRESOLVED']) {
    assert.match(begin, new RegExp(code));
  }
  assert.match(begin, /assignment\.status='active'/);
  assert.match(begin, /approval\.reviewer_id<>candidate\.created_by/);
  assert.match(begin, /course_publish_actor_has_permission_locked\(approval\.reviewer_id/);
  assert.match(begin, /current_revision\.authoring_revision=snapshot\.authoring_revision/);
  assert.match(begin, /current_revision\.updated_at<=mapping\.updated_at/);
  assert.doesNotMatch(begin, /mapping\.target_hash=public\.workspace_course_block_hash/);
  assert.match(functionBody('guard_course_publish_approval'), /course_publish_candidate_snapshot_matches\(candidate\.id\)/);
  assert.match(sql, /reviewer_role VARCHAR\(20\) NOT NULL/);
  assert.match(sql, /reason VARCHAR\(1000\) NOT NULL/);
  assert.match(sql, /OLD\.policy='high_risk_hse' AND NEW\.policy<>'high_risk_hse'/);
});

test('publication requires a deferred receipt and snapshot recheck at commit', () => {
  assert.match(sql, /trg_course_publish_commit_atomic[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  const commit = functionBody('assert_course_publish_commit');
  assert.match(commit, /course_publish_receipts/);
  assert.match(commit, /course_publish_candidate_snapshot_matches\(candidate_id\)/);
});

test('every private table is deletion-fenced and quota-accounted with transition tables', () => {
  assert.match(sql, /trg_deletion_fence_course_write BEFORE INSERT OR UPDATE/);
  assert.match(sql, /tenant_data_quota_direct_insert AFTER INSERT[\s\S]*REFERENCING NEW TABLE AS new_rows/);
  assert.match(sql, /tenant_data_quota_direct_update AFTER UPDATE[\s\S]*REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/);
  assert.match(sql, /tenant_data_quota_direct_delete AFTER DELETE[\s\S]*REFERENCING OLD TABLE AS old_rows/);
});

test('immutable evidence permits only owner-driven course and candidate cascades', () => {
  assert.match(functionBody('guard_course_publish_policy'),
    /NOT EXISTS\(SELECT 1 FROM public\.courses WHERE id=OLD\.course_id\) THEN RETURN OLD/);
  assert.match(functionBody('guard_course_publish_candidate'),
    /NOT EXISTS\(SELECT 1 FROM public\.courses WHERE id=OLD\.course_id\) THEN RETURN OLD/);
  for (const name of ['guard_course_publish_candidate_child', 'guard_course_publish_approval',
    'guard_course_publish_receipt']) {
    assert.match(functionBody(name),
      /NOT EXISTS\([\s\S]*SELECT 1 FROM public\.course_publish_candidates WHERE id=OLD\.candidate_id\) THEN RETURN OLD/);
  }
});

test('revision ledgers are private and row identity cannot move across courses or tenants', () => {
  const ledger = functionBody('guard_course_publish_revision_ledger');
  const fence = functionBody('fence_course_publish_mutation');
  assert.match(ledger, /course_publish_revision_write/);
  assert.match(ledger, /COURSE_PUBLISH_REVISION_LEDGER_PRIVATE/);
  assert.match(fence, /NEW\.id<>OLD\.id OR NEW\.course_id<>OLD\.course_id/);
  assert.match(fence, /TG_TABLE_NAME='course_assets' AND NEW\.tenant_id<>OLD\.tenant_id/);
  assert.match(sql, /SELECT set_config\('app\.course_publish_revision_write','1',true\);[\s\S]*INSERT INTO public\.course_publish_block_revisions/);
});

test('high-risk semantic and assessment gates are scoped to exact candidate units', () => {
  const begin = functionBody('begin_course_publish_candidate');
  assert.match(begin, /mapping\.target_block_id=snapshot\.block_id/);
  assert.match(begin, /obligation\.unit_path=CASE WHEN node\.kind='component'/);
  assert.match(begin, /artifact\.payload->>'unit_path'=scoped_unit\.unit_path/);
  assert.match(begin, /ORDER BY artifact\.created_at DESC,artifact\.id DESC LIMIT 1/);
});

test('re-Apply advances mapping freshness while publish-only fields do not invalidate quality evidence', () => {
  assert.match(applyRepository, /receipt_id=EXCLUDED\.receipt_id,updated_at=clock_timestamp\(\)/);
  const begin = functionBody('begin_course_publish_candidate');
  assert.match(begin, /current_revision\.updated_at<=mapping\.updated_at/);
  const fence = functionBody('fence_course_publish_mutation');
  assert.match(fence,
    /ROW\(NEW\.parent_id,NEW\.block_type,NEW\.display_name,NEW\.data,NEW\.metadata,NEW\.sort_order,NEW\.deleted_at\)[\s\S]*?authoring_revision=authoring_revision\+1/);
  const publishGuardStart = fence.indexOf('IF ROW(NEW.is_published,NEW.published_data,NEW.published_metadata)');
  const publishGuardEnd = fence.indexOf('RETURN NEW;', publishGuardStart);
  assert.ok(publishGuardStart >= 0 && publishGuardEnd > publishGuardStart);
  assert.doesNotMatch(fence.slice(publishGuardStart, publishGuardEnd),
    /authoring_revision=authoring_revision\+1/);
});

test('revision backfill preserves the course deletion fence and excludes deletion-owned courses', () => {
  assert.match(sql,
    /INSERT INTO public\.course_publish_block_revisions\(block_id,tenant_id,course_id\)[\s\S]*?JOIN public\.courses course ON course\.id=block\.course_id[\s\S]*?WHERE course\.deleted_at IS NULL;/);
  assert.match(sql,
    /INSERT INTO public\.course_publish_asset_revisions\(asset_id,tenant_id,course_id\)[\s\S]*?JOIN public\.courses course ON course\.id=asset\.course_id[\s\S]*?WHERE course\.deleted_at IS NULL;/);
  const backfill = sql.slice(sql.indexOf('-- Backfill only after quota/deletion triggers are active'));
  assert.doesNotMatch(backfill, /DISABLE TRIGGER|session_replication_role|ALTER TABLE[\s\S]*?DISABLE/i);
});
