import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import {
  ORCHESTRATION_V2_GUARDS,
  ORCHESTRATION_V2_TABLES,
} from './lesson-author-orchestration-v2-schema.repository.js';

/** SELECT-only startup prerequisite, not migration execution or rollout approval.
 * Function body hashes pin reviewed manual artifacts, not a permissive table-count
 * check. Actual concurrency/rollback tests remain a separate rollout requirement. */
export const WORKSPACE_FOUNDATION_GUARDS = {
  'guard_lesson_author_workspace()': '70ec47651eed22e29f4d617177b89654',
  'guard_lesson_author_workspace_node()': 'a755658ee7cbce51504a039cbea4f4dc',
  'guard_lesson_author_workspace_revision()': '342f131e155ee6ee525b6241201015a5',
  'guard_lesson_author_workspace_event()': '653878921d8950a4752e3b6da2d97064',
  'assert_lesson_author_workspace_event_commit()': '0d7b7272ddd07a776ef77f8da2256fef',
  'publish_lesson_author_workspace_revision()': '4089f0939f48230b55922b0bcd9a78e7',
  'publish_lesson_author_workspace_created()': 'a4c4f8ff24044b4ba84e2e5ed60bb863',
} as const;
export const WORKSPACE_EXECUTION_GUARDS = {
  'guard_lesson_author_workspace_run()': '899ce32d811fb652ba75559671913494',
  'guard_lesson_author_workspace_work_item()': '353bb642e394cbcde94a743b80d6ca7f',
  'fence_lesson_author_workspace_baseline()': '288b45fb8ed3c2846bf75b8e013af463',
  'assert_lesson_author_workspace_unit_commit()': '12071f0db2cc3362ab83f4f9079ebce7',
  'publish_lesson_author_workspace_unit(uuid,uuid,uuid,jsonb,text,text,boolean,jsonb)': '30e992300082162a74bce2aeb3042f77',
  'workspace_course_block_hash(uuid,character varying,uuid)': '58831cfc046f9f2d76d081be873a36a6',
  'guard_lesson_author_workspace_apply_receipt()': '8c86e411a7b06ab569b3bb2a145db903',
  'guard_lesson_author_workspace_apply_mapping()': '77e599cef9767b9fa14ba9aa21c66132',
  'assert_lesson_author_workspace_apply_commit()': 'c4a6c31eae1e43ae73981521fe1ede0d',
  'assert_lesson_author_workspace_run_commit()': 'd53eb1132071f5805c6d595ef5130c1e',
} as const;

/**
 * V2-only replacements for execution guards that cannot be installed on a
 * legacy catalog because their reviewed body references V2 relations.
 * Keep these separate from ORCHESTRATION_V2_GUARDS: the dedicated generation
 * worker does not own Apply, while the API workspace runtime does.
 */
export const WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES = {
  'guard_lesson_author_workspace_apply_receipt()': 'fd5e31a98980789f8632b6c7e0fc51f2',
} as const;
type Trigger = { table: string; name: string; fn: string; type: number; deferred: boolean };
const t = (table: string, name: string, fn: string, type: number, deferred = false): Trigger => ({ table, name, fn, type, deferred });
export function workspaceSchemaContract(execution: boolean) {
  const tables = ['lesson_author_workspaces', 'lesson_author_workspace_nodes', 'lesson_author_workspace_revisions', 'lesson_author_workspace_events'];
  const triggers: Trigger[] = [
    t(tables[0], 'trg_la_workspace_guard', 'guard_lesson_author_workspace', 23),
    t(tables[0], 'trg_la_workspace_created', 'publish_lesson_author_workspace_created', 5),
    t(tables[0], 'trg_la_workspace_event_commit', 'assert_lesson_author_workspace_event_commit', 21, true),
    t(tables[1], 'trg_la_workspace_node_guard', 'guard_lesson_author_workspace_node', 31),
    t(tables[2], 'trg_la_workspace_revision_guard', 'guard_lesson_author_workspace_revision', 31),
    t(tables[2], 'trg_la_workspace_revision_publish', 'publish_lesson_author_workspace_revision', 5),
    t(tables[3], 'trg_la_workspace_event_guard', 'guard_lesson_author_workspace_event', 31),
    // Additive, metadata-only post-commit wake bridge. Its exact identity is
    // pinned here so startup remains fail-closed for any other extra trigger.
    t(tables[3], 'trg_la_workspace_event_notify', 'notify_lesson_author_workspace_event', 5),
  ];
  if (execution) {
    tables.push('lesson_author_workspace_runs', 'lesson_author_workspace_work_items', 'lesson_author_workspace_apply_mappings', 'lesson_author_workspace_apply_receipts');
    triggers.push(
      t(tables[4], 'trg_la_workspace_run_guard', 'guard_lesson_author_workspace_run', 31),
      t(tables[5], 'trg_la_workspace_item_guard', 'guard_lesson_author_workspace_work_item', 31),
      t(tables[2], 'trg_la_workspace_baseline_fence', 'fence_lesson_author_workspace_baseline', 7),
      t(tables[2], 'trg_la_workspace_baseline_commit', 'assert_lesson_author_workspace_unit_commit', 5, true),
      t(tables[5], 'trg_la_workspace_item_commit', 'assert_lesson_author_workspace_unit_commit', 21, true),
      t(tables[3], 'trg_la_workspace_unit_event_commit', 'assert_lesson_author_workspace_unit_commit', 5, true),
      t(tables[7], 'trg_la_workspace_receipt_guard', 'guard_lesson_author_workspace_apply_receipt', 31),
      t(tables[6], 'trg_la_workspace_mapping_guard', 'guard_lesson_author_workspace_apply_mapping', 31),
      t(tables[7], 'trg_la_workspace_receipt_commit', 'assert_lesson_author_workspace_apply_commit', 5, true),
      t(tables[6], 'trg_la_workspace_mapping_commit', 'assert_lesson_author_workspace_apply_commit', 21, true),
      t(tables[3], 'trg_la_workspace_apply_event_commit', 'assert_lesson_author_workspace_apply_commit', 5, true),
      t(tables[0], 'trg_la_workspace_run_commit', 'assert_lesson_author_workspace_run_commit', 21, true),
    );
  }
  for (const table of tables) triggers.push(
    t(table, 'trg_deletion_fence_course_write', 'assert_active_course_deletion_fence', 23),
    t(table, 'tenant_data_quota_direct_insert', 'tenant_data_quota_apply_direct_delta', 4),
    t(table, 'tenant_data_quota_direct_update', 'tenant_data_quota_apply_direct_delta', 16),
    t(table, 'tenant_data_quota_direct_delete', 'tenant_data_quota_apply_direct_delta', 8),
  );
  return { tables, triggers, guards: { ...WORKSPACE_FOUNDATION_GUARDS, ...(execution ? WORKSPACE_EXECUTION_GUARDS : {}) } };
}
export class WorkspaceSchemaError extends Error {
  constructor(readonly code: 'WORKSPACE_SCHEMA_MISSING' | 'WORKSPACE_SCHEMA_ACCESS_INVALID' | 'WORKSPACE_SCHEMA_GUARD_DRIFT' | 'WORKSPACE_SCHEMA_TRIGGER_DRIFT' | 'WORKSPACE_SCHEMA_UNAVAILABLE') { super(code); }
}
export async function verifyWorkspaceSchema(db: GenerationJobSql, execution: boolean) {
  const expected = workspaceSchemaContract(execution);
  try {
    const tables = await db.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS browser_access,
      has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE')
        AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user)) AS can_write,
      (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies,
      EXISTS (SELECT 1 FROM tenant_data_quota_table_registry r JOIN tenant_data_quota_ownership_manifest m USING (relation_name)
        WHERE r.relation_name=c.oid AND r.tenant_column='tenant_id' AND r.is_active AND m.classification='direct') AS quota_registered,
      NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND NOT k.convalidated) AS constraints_validated
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`, [expected.tables]);
    if (tables.rows.length !== expected.tables.length || new Set(tables.rows.map(r => r.name)).size !== expected.tables.length) throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_MISSING');
    if (tables.rows.some(r => r.rls !== true || r.browser_access !== false || r.can_write !== true || r.policies !== 0 || r.quota_registered !== true || r.constraints_validated !== true)) throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_ACCESS_INVALID');
    const functions = await db.query(`SELECT x.signature,p.proname,p.prosecdef AS definer,p.proconfig,
        md5(btrim(replace(p.prosrc,chr(13),''),E' \\n\\t')) AS hash,
        (SELECT count(*)::int FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid=c2.relnamespace
          WHERE n2.nspname='public' AND c2.relkind='r' AND c2.relname=ANY($2::text[])) AS v2_table_count,
        has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') AS browser_access,
        has_function_privilege(current_user,p.oid,'EXECUTE') AS can_execute
      FROM unnest($1::text[]) x(signature) LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||x.signature)`,
      [Object.keys(expected.guards), ORCHESTRATION_V2_TABLES]);
    const v2TableCounts = new Set(functions.rows.map(r => Number(r.v2_table_count)));
    const v2TableCount = v2TableCounts.size === 1 ? [...v2TableCounts][0] : -1;
    if (v2TableCount !== 0 && v2TableCount !== ORCHESTRATION_V2_TABLES.length) {
      throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_GUARD_DRIFT');
    }
    const v2Installed = v2TableCount === ORCHESTRATION_V2_TABLES.length;
    if (functions.rows.length !== Object.keys(expected.guards).length || functions.rows.some(r => {
      const legacyHash = expected.guards[r.signature as keyof typeof expected.guards];
      const upgradedHash = WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES[
        r.signature as keyof typeof WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES
      ] ?? ORCHESTRATION_V2_GUARDS[r.signature as keyof typeof ORCHESTRATION_V2_GUARDS];
      const expectedHash = v2Installed && upgradedHash ? upgradedHash : legacyHash;
      return expectedHash !== r.hash || r.definer !== false || r.browser_access !== false || r.can_execute !== true
        || JSON.stringify(r.proconfig) !== JSON.stringify(['search_path=pg_catalog, public']);
    })) throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_GUARD_DRIFT');
    const triggers = await db.query(`SELECT c.relname AS table,t.tgname AS name,p.proname AS fn,t.tgtype::int AS type,
        t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,t.tgenabled AS enabled,n.nspname AS function_schema,
        t.tgoldtable AS old_table,t.tgnewtable AS new_table
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND ns.nspname='public' AND c.relname=ANY($1::text[])`, [expected.tables]);
    // Foundation-only inspection allows the additive execution triggers if already installed.
    const known = workspaceSchemaContract(true).triggers;
    if (triggers.rows.some(r => !known.some(e => e.table === r.table && e.name === r.name))) throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_TRIGGER_DRIFT');
    for (const e of expected.triggers) {
      const matches = triggers.rows.filter(r => r.table === e.table && r.name === e.name), r = matches[0];
      const quota = e.name.startsWith('tenant_data_quota_direct_');
      if (matches.length !== 1 || r.fn !== e.fn || r.function_schema !== 'public' || r.type !== e.type || r.enabled !== 'O'
        || r.deferrable !== e.deferred || r.deferred !== e.deferred
        || r.old_table !== (quota && e.type !== 4 ? 'old_rows' : null) || r.new_table !== (quota && e.type !== 8 ? 'new_rows' : null)) throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_TRIGGER_DRIFT');
    }
    return { status: 'CATALOG_VERIFIED' as const, execution, table_count: tables.rows.length, guard_count: functions.rows.length,
      runtime_enabled: false as const, concurrency_verified: false as const };
  } catch (e) { if (e instanceof WorkspaceSchemaError) throw e; throw new WorkspaceSchemaError('WORKSPACE_SCHEMA_UNAVAILABLE'); }
}
