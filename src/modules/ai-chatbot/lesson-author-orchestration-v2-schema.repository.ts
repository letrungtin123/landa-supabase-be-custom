import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';

export const ORCHESTRATION_V2_TABLES = [
  'lesson_author_workspace_source_snapshots',
  'lesson_author_workspace_source_facts',
  'lesson_author_workspace_v2_runs',
  'lesson_author_workspace_v2_tasks',
  'lesson_author_workspace_v2_dependencies',
  'lesson_author_workspace_v2_artifacts',
  'lesson_author_workspace_v2_dispatch_outbox',
  'lesson_author_workspace_v2_completion_receipts',
  'lesson_author_workspace_quality_receipts',
  'lesson_author_workspace_v2_attempt_events',
  'lesson_author_workspace_v2_assessment_obligations',
  'lesson_author_workspace_v2_review_receipts',
] as const;

/** Exact hashes of reviewed SECURITY INVOKER function bodies in the manual artifact. */
export const ORCHESTRATION_V2_GUARDS = {
  'guard_lesson_author_workspace_source_snapshot_v2()': '9c7df8552236baa01eb3fe517e2d145a',
  'guard_lesson_author_workspace_source_fact_v2()': '6e1aa7fd21af9c229bebc7388718cbfd',
  'guard_lesson_author_workspace_v2_run()': '5d4828cdad69bded21a4a55f4c2bb124',
  'guard_lesson_author_workspace_v2_task()': '41929858fa2887bbe83d36d2555acf55',
  'guard_lesson_author_workspace_v2_dependency()': 'dd347f4d6cb80814bb57d87e136f9c3e',
  'guard_lesson_author_workspace_v2_artifact()': '4cf67dccee7c7e00c87041b4ae5a2bbe',
  'guard_lesson_author_workspace_v2_outbox()': 'e4fde4589943cd935ba9099582311fc8',
  'guard_lesson_author_workspace_v2_completion()': '07e3c89e9b76064e92c259c9aa06077f',
  'guard_lesson_author_workspace()': '4d8a8428162110c8b60b64e39788771f',
  'guard_lesson_author_workspace_node()': '3e6fecf88368b46c1ee93b112056f026',
  'guard_lesson_author_workspace_revision()': 'b13f1a1a13b37e1e62e31b69ebf92e52',
  'guard_lesson_author_workspace_event()': '3e03bacb3ee2ac53749286fa133a4e1e',
  'fence_lesson_author_workspace_baseline()': '2849f826f369316db05ec64a4b17cf76',
  'assert_lesson_author_workspace_unit_commit()': '2dd603d20d5c19c4678468479ddecae9',
  'assert_lesson_author_workspace_run_commit()': '4f218179c17e8a1503104f3490e6dd18',
  'assert_lesson_author_workspace_v2_completion_commit()': 'c15968c86517171607deaa74e04a672d',
  'guard_lesson_author_workspace_quality_receipt()': '5bc4b48ab7aeb9ca73f9083edf6b3e62',
  'guard_lesson_author_workspace_v2_attempt_event()': 'ab88535c99e05e44e48710752cdb27ac',
  'capture_lesson_author_workspace_v2_task_attempt()': '9e7ea4a3cd98ea3552944b4f0551edd5',
  'assert_lesson_author_workspace_quality_commit()': '959e5b9037a13c97b3fd23a13229ab71',
  'guard_lesson_author_workspace_apply_quality_v2()': '5f83d38c95906246ed4b184bef2642ac',
  'guard_lesson_author_workspace_v2_assessment_obligation()': '2a6558622c93fbab24922ab945ea702c',
  'guard_lesson_author_workspace_v2_review_receipt()': '203201138945fe9913fc82cf7bbd9aea',
} as const;

type TriggerContract = {
  table: (typeof ORCHESTRATION_V2_TABLES)[number];
  name: string;
  fn: string;
  type: number;
  deferrable: boolean;
  deferred: boolean;
  oldTable: string | null;
  newTable: string | null;
};

const guardTriggers: ReadonlyArray<TriggerContract> = [
  ['lesson_author_workspace_source_snapshots', 'trg_la_ws_source_snapshot_v2_guard', 'guard_lesson_author_workspace_source_snapshot_v2'],
  ['lesson_author_workspace_source_facts', 'trg_la_ws_source_fact_v2_guard', 'guard_lesson_author_workspace_source_fact_v2'],
  ['lesson_author_workspace_v2_runs', 'trg_la_ws_v2_run_guard', 'guard_lesson_author_workspace_v2_run'],
  ['lesson_author_workspace_v2_tasks', 'trg_la_ws_v2_task_guard', 'guard_lesson_author_workspace_v2_task'],
  ['lesson_author_workspace_v2_dependencies', 'trg_la_ws_v2_dependency_guard', 'guard_lesson_author_workspace_v2_dependency'],
  ['lesson_author_workspace_v2_artifacts', 'trg_la_ws_v2_artifact_guard', 'guard_lesson_author_workspace_v2_artifact'],
  ['lesson_author_workspace_v2_dispatch_outbox', 'trg_la_ws_v2_outbox_guard', 'guard_lesson_author_workspace_v2_outbox'],
  ['lesson_author_workspace_v2_completion_receipts', 'trg_la_ws_v2_completion_guard', 'guard_lesson_author_workspace_v2_completion'],
  ['lesson_author_workspace_quality_receipts', 'trg_la_workspace_quality_guard', 'guard_lesson_author_workspace_quality_receipt'],
  ['lesson_author_workspace_v2_attempt_events', 'trg_la_ws_v2_attempt_guard', 'guard_lesson_author_workspace_v2_attempt_event'],
  ['lesson_author_workspace_v2_assessment_obligations', 'trg_la_ws_v2_assessment_obligation_guard',
    'guard_lesson_author_workspace_v2_assessment_obligation'],
  ['lesson_author_workspace_v2_review_receipts', 'trg_la_ws_v2_review_receipt_guard',
    'guard_lesson_author_workspace_v2_review_receipt'],
].map(([table, name, fn]) => ({
  table: table as TriggerContract['table'], name, fn, type: 31, deferrable: false, deferred: false,
  oldTable: null, newTable: null,
}));

export const ORCHESTRATION_V2_TRIGGERS: ReadonlyArray<TriggerContract> = [
  ...guardTriggers,
  ...ORCHESTRATION_V2_TABLES.flatMap((table): TriggerContract[] => [
    { table, name: 'trg_deletion_fence_course_write', fn: 'assert_active_course_deletion_fence', type: 23,
      deferrable: false, deferred: false, oldTable: null, newTable: null },
    { table, name: 'tenant_data_quota_direct_insert', fn: 'tenant_data_quota_apply_direct_delta', type: 4,
      deferrable: false, deferred: false, oldTable: null, newTable: 'new_rows' },
    { table, name: 'tenant_data_quota_direct_update', fn: 'tenant_data_quota_apply_direct_delta', type: 16,
      deferrable: false, deferred: false, oldTable: 'old_rows', newTable: 'new_rows' },
    { table, name: 'tenant_data_quota_direct_delete', fn: 'tenant_data_quota_apply_direct_delta', type: 8,
      deferrable: false, deferred: false, oldTable: 'old_rows', newTable: null },
  ]),
  { table: 'lesson_author_workspace_v2_tasks', name: 'trg_la_ws_v2_unit_atomic',
    fn: 'assert_lesson_author_workspace_unit_commit', type: 17, deferrable: true, deferred: true,
    oldTable: null, newTable: null },
  { table: 'lesson_author_workspace_v2_tasks', name: 'trg_la_ws_v2_completion_task_atomic',
    fn: 'assert_lesson_author_workspace_v2_completion_commit', type: 17, deferrable: true, deferred: true,
    oldTable: null, newTable: null },
  { table: 'lesson_author_workspace_v2_artifacts', name: 'trg_la_ws_v2_completion_artifact_atomic',
    fn: 'assert_lesson_author_workspace_v2_completion_commit', type: 5, deferrable: true, deferred: true,
    oldTable: null, newTable: null },
  { table: 'lesson_author_workspace_v2_tasks', name: 'trg_la_ws_v2_task_attempt',
    fn: 'capture_lesson_author_workspace_v2_task_attempt', type: 17, deferrable: false, deferred: false,
    oldTable: null, newTable: null },
  { table: 'lesson_author_workspace_quality_receipts', name: 'trg_la_workspace_quality_commit',
    fn: 'assert_lesson_author_workspace_quality_commit', type: 5, deferrable: true, deferred: true,
    oldTable: null, newTable: null },
];

/**
 * CP5 publish-governance fences installed on orchestration-owned evidence
 * tables. The verifier accepts either the pre-CP5 catalog or this complete,
 * exact set; a partial set or any contract drift remains a startup failure.
 */
export const ORCHESTRATION_V2_COURSE_PUBLISH_EVIDENCE_TRIGGERS: ReadonlyArray<TriggerContract> = [
  { table: 'lesson_author_workspace_quality_receipts', name: 'trg_course_publish_evidence_mutation_fence',
    fn: 'fence_course_publish_evidence_mutation', type: 31, deferrable: false, deferred: false,
    oldTable: null, newTable: null },
  { table: 'lesson_author_workspace_v2_assessment_obligations', name: 'trg_course_publish_evidence_mutation_fence',
    fn: 'fence_course_publish_evidence_mutation', type: 31, deferrable: false, deferred: false,
    oldTable: null, newTable: null },
  { table: 'lesson_author_workspace_v2_artifacts', name: 'trg_course_publish_evidence_mutation_fence',
    fn: 'fence_course_publish_evidence_mutation', type: 31, deferrable: false, deferred: false,
    oldTable: null, newTable: null },
];

export const ORCHESTRATION_V2_EXTERNAL_TRIGGERS = [
  { table: 'lesson_author_workspace_apply_receipts', name: 'trg_la_workspace_apply_quality_v2',
    fn: 'guard_lesson_author_workspace_apply_quality_v2', type: 7, deferrable: false, deferred: false },
  { table: 'lesson_author_workspace_apply_receipts', name: 'trg_la_workspace_apply_quality_commit',
    fn: 'assert_lesson_author_workspace_quality_commit', type: 5, deferrable: true, deferred: true },
] as const;

export class OrchestrationV2SchemaError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_SCHEMA_MISSING'
    | 'ORCHESTRATION_V2_SCHEMA_ACCESS_INVALID'
    | 'ORCHESTRATION_V2_SCHEMA_GUARD_DRIFT'
    | 'ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT'
    | 'ORCHESTRATION_V2_SCHEMA_UNAVAILABLE') {
    super(code);
  }
}

/**
 * SELECT-only startup prerequisite. It never installs, repairs or enables V2.
 * Concurrency/fault acceptance and feature activation remain separate rollout gates.
 */
export async function verifyOrchestrationV2Schema(db: GenerationJobSql) {
  try {
    const tableResult = await db.query(`SELECT c.relname AS name,c.relrowsecurity AS rls,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS browser_access,
      has_table_privilege(current_user,c.oid,'SELECT')
        AND has_table_privilege(current_user,c.oid,'INSERT')
        AND has_table_privilege(current_user,c.oid,'UPDATE')
        AND has_table_privilege(current_user,c.oid,'DELETE')
        AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
          OR (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user)) AS can_write,
      (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies,
      EXISTS (SELECT 1 FROM tenant_data_quota_table_registry r
        JOIN tenant_data_quota_ownership_manifest m USING (relation_name)
        WHERE r.relation_name=c.oid AND r.tenant_column='tenant_id' AND r.is_active
          AND m.classification='direct') AS quota_registered,
      NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND NOT k.convalidated) AS constraints_validated,
      CASE WHEN c.relname='lesson_author_workspace_v2_dispatch_outbox' THEN EXISTS(
        SELECT 1 FROM pg_attribute attribute JOIN pg_attrdef default_row
          ON default_row.adrelid=attribute.attrelid AND default_row.adnum=attribute.attnum
        WHERE attribute.attrelid=c.oid AND attribute.attname='capacity_deferral_count'
          AND attribute.atttypid='pg_catalog.int4'::regtype AND attribute.attnotnull
          AND NOT attribute.attisdropped
          AND replace(pg_get_expr(default_row.adbin,default_row.adrelid),'::integer','')='0')
        AND EXISTS(SELECT 1 FROM pg_constraint constraint_row
          WHERE constraint_row.conrelid=c.oid
            AND constraint_row.conname='la_ws_v2_outbox_capacity_deferral_count_check'
            AND constraint_row.contype='c' AND constraint_row.convalidated
            AND regexp_replace(pg_get_expr(constraint_row.conbin,constraint_row.conrelid),'[()[:space:]]','','g')
              ='capacity_deferral_count>=0ANDcapacity_deferral_count<=1000000')
        AND to_regclass('public.idx_la_ws_v2_outbox_capacity_wake') IS NOT NULL
        AND to_regclass('public.idx_la_ws_v2_outbox_capacity_admitted') IS NOT NULL
      WHEN c.relname='lesson_author_workspace_v2_tasks' THEN
        to_regclass('public.idx_la_ws_v2_task_running_capacity') IS NOT NULL
      WHEN c.relname='lesson_author_workspace_v2_attempt_events' THEN
        to_regclass('public.idx_la_ws_v2_attempt_task') IS NOT NULL
      ELSE true END AS runtime_columns_ready
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`, [ORCHESTRATION_V2_TABLES]);
    if (tableResult.rows.length !== ORCHESTRATION_V2_TABLES.length
      || new Set(tableResult.rows.map((row) => row.name)).size !== ORCHESTRATION_V2_TABLES.length) {
      throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_MISSING');
    }
    if (tableResult.rows.some((row) => row.rls !== true || row.browser_access !== false || row.can_write !== true
      || row.policies !== 0 || row.quota_registered !== true || row.constraints_validated !== true
      || row.runtime_columns_ready !== true)) {
      throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_ACCESS_INVALID');
    }

    const signatures = Object.keys(ORCHESTRATION_V2_GUARDS);
    const functionResult = await db.query(`SELECT x.signature,p.proname,p.prosecdef AS definer,p.proconfig,
        md5(btrim(replace(p.prosrc,chr(13),''),E' \\n\\t')) AS hash,
        has_function_privilege('anon',p.oid,'EXECUTE')
          OR has_function_privilege('authenticated',p.oid,'EXECUTE') AS browser_access,
        has_function_privilege(current_user,p.oid,'EXECUTE') AS can_execute
      FROM unnest($1::text[]) x(signature)
      LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||x.signature)`, [signatures]);
    if (functionResult.rows.length !== signatures.length || functionResult.rows.some((row) =>
      ORCHESTRATION_V2_GUARDS[row.signature as keyof typeof ORCHESTRATION_V2_GUARDS] !== row.hash
      || row.definer !== false || row.browser_access !== false || row.can_execute !== true
      || JSON.stringify(row.proconfig) !== JSON.stringify(['search_path=pg_catalog, public']))) {
      throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_GUARD_DRIFT');
    }

    const triggerResult = await db.query(`SELECT c.relname AS table,t.tgname AS name,p.proname AS fn,
        t.tgtype::int AS type,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,
        t.tgenabled AS enabled,n.nspname AS function_schema,t.tgoldtable AS old_table,t.tgnewtable AS new_table
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND ns.nspname='public' AND c.relname=ANY($1::text[])`, [ORCHESTRATION_V2_TABLES]);
    const installedPublishFences = ORCHESTRATION_V2_COURSE_PUBLISH_EVIDENCE_TRIGGERS.filter(expected =>
      triggerResult.rows.some(row => row.table === expected.table && row.name === expected.name));
    if ((installedPublishFences.length !== 0
        && installedPublishFences.length !== ORCHESTRATION_V2_COURSE_PUBLISH_EVIDENCE_TRIGGERS.length)
      || triggerResult.rows.length !== ORCHESTRATION_V2_TRIGGERS.length + installedPublishFences.length) {
      throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT');
    }
    for (const expected of [...ORCHESTRATION_V2_TRIGGERS, ...installedPublishFences]) {
      const matches = triggerResult.rows.filter((row) => row.table === expected.table && row.name === expected.name);
      const actual = matches[0];
      if (matches.length !== 1 || actual.fn !== expected.fn || actual.type !== expected.type
        || actual.deferrable !== expected.deferrable || actual.deferred !== expected.deferred || actual.enabled !== 'O'
        || actual.function_schema !== 'public' || actual.old_table !== expected.oldTable
        || actual.new_table !== expected.newTable) {
        throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT');
      }
    }
    const externalTriggerNames = ORCHESTRATION_V2_EXTERNAL_TRIGGERS.map(trigger => trigger.name);
    const externalTriggerResult = await db.query(`SELECT c.relname AS table,t.tgname AS name,p.proname AS fn,
        t.tgtype::int AS type,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,
        t.tgenabled AS enabled,n.nspname AS function_schema
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND ns.nspname='public'
        AND c.relname='lesson_author_workspace_apply_receipts' AND t.tgname=ANY($1::text[])`,
    [externalTriggerNames]);
    if (externalTriggerResult.rows.length !== ORCHESTRATION_V2_EXTERNAL_TRIGGERS.length
      || ORCHESTRATION_V2_EXTERNAL_TRIGGERS.some(expected => {
        const matches = externalTriggerResult.rows.filter(row => row.table === expected.table && row.name === expected.name);
        const actual = matches[0];
        return matches.length !== 1 || actual.fn !== expected.fn || actual.type !== expected.type
          || actual.deferrable !== expected.deferrable || actual.deferred !== expected.deferred
          || actual.enabled !== 'O' || actual.function_schema !== 'public';
      })) throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT');
    return {
      status: 'CATALOG_VERIFIED' as const,
      contract_version: 2 as const,
      table_count: tableResult.rows.length,
      guard_count: functionResult.rows.length,
      trigger_count: triggerResult.rows.length + externalTriggerResult.rows.length,
      runtime_enabled: false as const,
      concurrency_verified: false as const,
    };
  } catch (error) {
    if (error instanceof OrchestrationV2SchemaError) throw error;
    throw new OrchestrationV2SchemaError('ORCHESTRATION_V2_SCHEMA_UNAVAILABLE');
  }
}
