import { createHash } from 'node:crypto';
import { query } from '../../config/database.js';

type Sql = Pick<typeof import('../../config/database.js'), 'query'>['query'];

export const COURSE_PUBLISH_GOVERNANCE_TABLES = [
  'course_publish_block_revisions',
  'course_publish_asset_revisions',
  'course_publish_policies',
  'course_publish_reviewer_assignments',
  'course_publish_candidates',
  'course_publish_candidate_blocks',
  'course_publish_candidate_assets',
  'course_publish_approvals',
  'course_publish_receipts',
] as const;

export const COURSE_PUBLISH_GOVERNANCE_FUNCTIONS = {
  'course_publish_actor_has_permission(uuid,uuid,character varying)': '2fee62201e5713dc9c8b82bf39dae393',
  'course_publish_actor_is_policy_admin(uuid,uuid)': '0868dfb99592f1474422576f105c6bf2',
  'course_publish_actor_has_permission_locked(uuid,uuid,character varying)': '977dcd2d0e0912053f03c4dfe7a6eff6',
  'course_publish_block_draft_hash(uuid,character varying,uuid)': '8201899a07a59fb0edcfa5cf19cccaa6',
  'course_publish_asset_hash(uuid,character varying,uuid)': '2daf61994c5e1869c374d69db56fc1df',
  'course_publish_candidate_snapshot_matches(uuid)': '124a9c7761711d5c8e68590e0b2a0ade',
  'guard_course_publish_policy()': '9b430b208239a6135b702b53f33d9612',
  'guard_course_publish_reviewer_assignment()': '1b89211daac17ab08d8aa27f2d6859a9',
  'guard_course_publish_candidate()': '8b504f658d60b3e21d2f2d6eba5f12f2',
  'guard_course_publish_candidate_child()': 'e5e4b72573879d159bb105876ac519a2',
  'guard_course_publish_approval()': 'cbf4e8ce995350a1e72351c158a86a1f',
  'guard_course_publish_receipt()': '0445b536fa14002c653ce13657a5058b',
  'guard_course_publish_revision_ledger()': 'eb39f86d1d551f613c249dcc04c62ef6',
  'fence_course_publish_mutation()': '56870786e889ae1f92f7b4165a474899',
  'fence_course_publish_evidence_mutation()': 'd308e04dfca22b6252a6476cd03a037a',
  'begin_course_publish_candidate(uuid,uuid,character varying,uuid,uuid)': '82bca74f6a131ab74d10b47a4a96e470',
  'finish_course_publish_candidate(uuid,uuid)': '2ea7b0c0aa9db725410c026d58bf3943',
  'assert_course_publish_candidate_commit()': '15223f87b59b03ec022cc8506c997271',
  'assert_course_publish_commit()': '579d92f89589f630fa6762374d22d31f',
} as const;

const CUSTOM_TRIGGERS = [
  ['course_publish_policies', 'trg_course_publish_policy_guard', 'guard_course_publish_policy', 31, false, false],
  ['course_publish_reviewer_assignments', 'trg_course_publish_assignment_guard', 'guard_course_publish_reviewer_assignment', 31, false, false],
  ['course_publish_candidates', 'trg_course_publish_candidate_guard', 'guard_course_publish_candidate', 31, false, false],
  ['course_publish_candidate_blocks', 'trg_course_publish_candidate_block_guard', 'guard_course_publish_candidate_child', 31, false, false],
  ['course_publish_candidate_assets', 'trg_course_publish_candidate_asset_guard', 'guard_course_publish_candidate_child', 31, false, false],
  ['course_publish_approvals', 'trg_course_publish_approval_guard', 'guard_course_publish_approval', 31, false, false],
  ['course_publish_receipts', 'trg_course_publish_receipt_guard', 'guard_course_publish_receipt', 31, false, false],
  ['course_publish_block_revisions', 'trg_course_publish_block_revision_guard',
    'guard_course_publish_revision_ledger', 31, false, false],
  ['course_publish_asset_revisions', 'trg_course_publish_asset_revision_guard',
    'guard_course_publish_revision_ledger', 31, false, false],
  ['course_publish_candidates', 'trg_course_publish_candidate_atomic', 'assert_course_publish_candidate_commit', 5, true, true],
  ['course_blocks', 'trg_course_publish_block_mutation_fence', 'fence_course_publish_mutation', 31, false, false],
  ['course_assets', 'trg_course_publish_asset_mutation_fence', 'fence_course_publish_mutation', 31, false, false],
  ['lesson_author_workspace_apply_receipts', 'trg_course_publish_evidence_mutation_fence',
    'fence_course_publish_evidence_mutation', 31, false, false],
  ['lesson_author_workspace_apply_mappings', 'trg_course_publish_evidence_mutation_fence',
    'fence_course_publish_evidence_mutation', 31, false, false],
  ['lesson_author_workspace_quality_receipts', 'trg_course_publish_evidence_mutation_fence',
    'fence_course_publish_evidence_mutation', 31, false, false],
  ['lesson_author_workspace_v2_assessment_obligations', 'trg_course_publish_evidence_mutation_fence',
    'fence_course_publish_evidence_mutation', 31, false, false],
  ['lesson_author_workspace_v2_artifacts', 'trg_course_publish_evidence_mutation_fence',
    'fence_course_publish_evidence_mutation', 31, false, false],
  ['course_blocks', 'trg_course_publish_commit_atomic', 'assert_course_publish_commit', 17, true, true],
] as const;

const SAFETY_TRIGGERS = COURSE_PUBLISH_GOVERNANCE_TABLES.flatMap(table => [
  { table, name: 'trg_deletion_fence_course_write', fn: 'assert_active_course_deletion_fence', type: 23,
    oldTable: null, newTable: null },
  { table, name: 'tenant_data_quota_direct_insert', fn: 'tenant_data_quota_apply_direct_delta', type: 4,
    oldTable: null, newTable: 'new_rows' },
  { table, name: 'tenant_data_quota_direct_update', fn: 'tenant_data_quota_apply_direct_delta', type: 16,
    oldTable: 'old_rows', newTable: 'new_rows' },
  { table, name: 'tenant_data_quota_direct_delete', fn: 'tenant_data_quota_apply_direct_delta', type: 8,
    oldTable: 'old_rows', newTable: null },
] as const);

export class CoursePublishGovernanceSchemaError extends Error {
  constructor(readonly code:
    | 'COURSE_PUBLISH_GOVERNANCE_SCHEMA_MISSING'
    | 'COURSE_PUBLISH_GOVERNANCE_SCHEMA_ACCESS_INVALID'
    | 'COURSE_PUBLISH_GOVERNANCE_SCHEMA_GUARD_DRIFT'
    | 'COURSE_PUBLISH_GOVERNANCE_SCHEMA_TRIGGER_DRIFT'
    | 'COURSE_PUBLISH_GOVERNANCE_SCHEMA_UNAVAILABLE') {
    super(code);
  }
}

export async function verifyCoursePublishGovernanceSchema(sql: Sql = query) {
  try {
    const tables = await sql(`SELECT c.relname AS name,c.relrowsecurity AS rls,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
          OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS browser_access,
        has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
          AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE')
          AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
            OR (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user)) AS can_write,
        (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies,
        NOT EXISTS(SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid=c.oid AND NOT constraint_row.convalidated) AS constraints_validated,
        EXISTS(SELECT 1 FROM tenant_data_quota_table_registry registry
          JOIN tenant_data_quota_ownership_manifest manifest USING(relation_name)
          WHERE registry.relation_name=c.oid AND registry.tenant_column='tenant_id' AND registry.is_active
            AND manifest.classification='direct') AS quota_registered
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`,
    [COURSE_PUBLISH_GOVERNANCE_TABLES]);
    if (tables.rows.length !== COURSE_PUBLISH_GOVERNANCE_TABLES.length) {
      throw new CoursePublishGovernanceSchemaError('COURSE_PUBLISH_GOVERNANCE_SCHEMA_MISSING');
    }
    if (tables.rows.some(row => row.rls !== true || row.browser_access !== false
      || row.can_write !== true || row.policies !== 0 || row.constraints_validated !== true
      || row.quota_registered !== true)) {
      throw new CoursePublishGovernanceSchemaError('COURSE_PUBLISH_GOVERNANCE_SCHEMA_ACCESS_INVALID');
    }
    const signatures = Object.keys(COURSE_PUBLISH_GOVERNANCE_FUNCTIONS);
    const functions = await sql(`SELECT item.signature,p.prosecdef AS definer,p.proconfig,
        md5(btrim(replace(p.prosrc,chr(13),''),E' \\n\\t')) AS hash,
        has_function_privilege('anon',p.oid,'EXECUTE')
          OR has_function_privilege('authenticated',p.oid,'EXECUTE') AS browser_access,
        has_function_privilege(current_user,p.oid,'EXECUTE') AS can_execute
      FROM unnest($1::text[]) item(signature)
      LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||item.signature)`, [signatures]);
    if (functions.rows.length !== signatures.length || functions.rows.some(row =>
      COURSE_PUBLISH_GOVERNANCE_FUNCTIONS[row.signature as keyof typeof COURSE_PUBLISH_GOVERNANCE_FUNCTIONS] !== row.hash
      || row.definer !== false || row.browser_access !== false || row.can_execute !== true
      || JSON.stringify(row.proconfig) !== JSON.stringify(['search_path=pg_catalog, public']))) {
      throw new CoursePublishGovernanceSchemaError('COURSE_PUBLISH_GOVERNANCE_SCHEMA_GUARD_DRIFT');
    }
    const names = CUSTOM_TRIGGERS.map(item => item[1]);
    const triggers = await sql(`SELECT table_class.relname AS table_name,trigger.tgname AS name,
        function_proc.proname AS function_name,trigger.tgtype::int AS type,
        trigger.tgdeferrable AS deferrable,trigger.tginitdeferred AS deferred,trigger.tgenabled AS enabled
      FROM pg_trigger trigger JOIN pg_class table_class ON table_class.oid=trigger.tgrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid=table_class.relnamespace
      JOIN pg_proc function_proc ON function_proc.oid=trigger.tgfoid
      JOIN pg_namespace function_namespace ON function_namespace.oid=function_proc.pronamespace
      WHERE NOT trigger.tgisinternal AND table_namespace.nspname='public'
        AND function_namespace.nspname='public' AND trigger.tgname=ANY($1::text[])`, [names]);
    if (triggers.rows.length !== CUSTOM_TRIGGERS.length || CUSTOM_TRIGGERS.some(expected => {
      const matches = triggers.rows.filter(row => row.table_name === expected[0] && row.name === expected[1]);
      const actual = matches[0];
      return matches.length !== 1 || actual.function_name !== expected[2] || actual.type !== expected[3]
        || actual.deferrable !== expected[4] || actual.deferred !== expected[5] || actual.enabled !== 'O';
    })) throw new CoursePublishGovernanceSchemaError('COURSE_PUBLISH_GOVERNANCE_SCHEMA_TRIGGER_DRIFT');

    const safetyTriggers = await sql(`SELECT table_class.relname AS table_name,trigger.tgname AS name,
        function_proc.proname AS function_name,trigger.tgtype::int AS type,
        trigger.tgdeferrable AS deferrable,trigger.tginitdeferred AS deferred,trigger.tgenabled AS enabled,
        function_namespace.nspname AS function_schema,trigger.tgoldtable AS old_table,trigger.tgnewtable AS new_table
      FROM pg_trigger trigger JOIN pg_class table_class ON table_class.oid=trigger.tgrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid=table_class.relnamespace
      JOIN pg_proc function_proc ON function_proc.oid=trigger.tgfoid
      JOIN pg_namespace function_namespace ON function_namespace.oid=function_proc.pronamespace
      WHERE NOT trigger.tgisinternal AND table_namespace.nspname='public'
        AND table_class.relname=ANY($1::text[]) AND trigger.tgname=ANY($2::text[])`,
    [COURSE_PUBLISH_GOVERNANCE_TABLES, [...new Set(SAFETY_TRIGGERS.map(item => item.name))]]);
    if (safetyTriggers.rows.length !== SAFETY_TRIGGERS.length || SAFETY_TRIGGERS.some(expected => {
      const matches = safetyTriggers.rows.filter(row => row.table_name === expected.table && row.name === expected.name);
      const actual = matches[0];
      return matches.length !== 1 || actual.function_name !== expected.fn || actual.type !== expected.type
        || actual.deferrable !== false || actual.deferred !== false || actual.enabled !== 'O'
        || actual.function_schema !== 'public' || actual.old_table !== expected.oldTable
        || actual.new_table !== expected.newTable;
    })) throw new CoursePublishGovernanceSchemaError('COURSE_PUBLISH_GOVERNANCE_SCHEMA_TRIGGER_DRIFT');
    return { status: 'CATALOG_VERIFIED' as const, contract_version: 1 as const,
      table_count: tables.rows.length, function_count: functions.rows.length,
      trigger_count: triggers.rows.length + safetyTriggers.rows.length };
  } catch (error) {
    if (error instanceof CoursePublishGovernanceSchemaError) throw error;
    throw new CoursePublishGovernanceSchemaError('COURSE_PUBLISH_GOVERNANCE_SCHEMA_UNAVAILABLE');
  }
}

let verified = false;
export async function ensureCoursePublishGovernanceSchema(): Promise<void> {
  if (verified) return;
  await verifyCoursePublishGovernanceSchema();
  verified = true;
}

export function coursePublishFunctionBodyHash(body: string): string {
  return createHash('md5').update(body.replace(/\r/g, '').trim()).digest('hex');
}
