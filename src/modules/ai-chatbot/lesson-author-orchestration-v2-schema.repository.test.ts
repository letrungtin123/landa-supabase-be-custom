import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import {
  ORCHESTRATION_V2_GUARDS,
  ORCHESTRATION_V2_EXTERNAL_TRIGGERS,
  ORCHESTRATION_V2_COURSE_PUBLISH_EVIDENCE_TRIGGERS,
  ORCHESTRATION_V2_TABLES,
  ORCHESTRATION_V2_TRIGGERS,
  OrchestrationV2SchemaError,
  verifyOrchestrationV2Schema,
} from './lesson-author-orchestration-v2-schema.repository.js';

type Overrides = {
  table?: Record<string, unknown>;
  fn?: Record<string, unknown>;
  triggers?: Array<Record<string, unknown>>;
  externalTriggers?: Array<Record<string, unknown>>;
};

function catalog(overrides: Overrides = {}): GenerationJobSql {
  return {
    async query(sql: string) {
      if (sql.includes('FROM pg_class c JOIN pg_namespace')) {
        return { rows: ORCHESTRATION_V2_TABLES.map((name) => ({
          name, rls: true, browser_access: false, can_write: true, policies: 0,
          quota_registered: true, constraints_validated: true, runtime_columns_ready: true, ...overrides.table,
        })) };
      }
      if (sql.includes('FROM unnest($1::text[])')) {
        return { rows: Object.entries(ORCHESTRATION_V2_GUARDS).map(([signature, hash]) => ({
          signature, proname: signature.slice(0, -2), definer: false,
          proconfig: ['search_path=pg_catalog, public'], hash,
          browser_access: false, can_execute: true, ...overrides.fn,
        })) };
      }
      if (sql.includes("c.relname='lesson_author_workspace_apply_receipts'")) {
        return { rows: overrides.externalTriggers ?? ORCHESTRATION_V2_EXTERNAL_TRIGGERS.map((trigger) => ({
          table: trigger.table, name: trigger.name, fn: trigger.fn, type: trigger.type,
          deferrable: trigger.deferrable, deferred: trigger.deferred, enabled: 'O', function_schema: 'public',
        })) };
      }
      if (sql.includes('FROM pg_trigger t')) {
        return { rows: overrides.triggers ?? ORCHESTRATION_V2_TRIGGERS.map((trigger) => ({
          table: trigger.table, name: trigger.name, fn: trigger.fn, type: trigger.type,
          deferrable: trigger.deferrable, deferred: trigger.deferred, enabled: 'O', function_schema: 'public',
          old_table: trigger.oldTable, new_table: trigger.newTable,
        })) };
      }
      throw new Error('unexpected query');
    },
  } as GenerationJobSql;
}

test('catalog contract pins all private tables, guards and triggers while keeping runtime disabled', async () => {
  assert.equal(ORCHESTRATION_V2_TABLES.length, 12);
  assert.equal(Object.keys(ORCHESTRATION_V2_GUARDS).length, 23);
  assert.equal(ORCHESTRATION_V2_TRIGGERS.length, 65);
  const result = await verifyOrchestrationV2Schema(catalog());
  assert.deepEqual(result, {
    status: 'CATALOG_VERIFIED', contract_version: 2, table_count: 12, guard_count: 23,
    trigger_count: 67, runtime_enabled: false, concurrency_verified: false,
  });
});

test('catalog verification fails closed for browser access or invalid quota ownership', async () => {
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ table: { browser_access: true } })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_ACCESS_INVALID',
  );
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ table: { quota_registered: false } })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_ACCESS_INVALID',
  );
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ table: { runtime_columns_ready: false } })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_ACCESS_INVALID',
  );
});

test('runtime catalog requires the bounded attempt-evidence index used by provider replay claims', async () => {
  const calls: string[] = [];
  const authority = catalog();
  const inspected = { async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    calls.push(sql);
    return authority.query<T>(sql, params);
  } } as GenerationJobSql;
  await verifyOrchestrationV2Schema(inspected);
  assert.ok(calls.some(sql => /idx_la_ws_v2_attempt_task/.test(sql)));
});

test('catalog verification fails closed for guard or trigger drift', async () => {
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ fn: { hash: '00000000000000000000000000000000' } })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_GUARD_DRIFT',
  );
  const missingTrigger = ORCHESTRATION_V2_TRIGGERS.slice(1).map((trigger) => ({
    table: trigger.table, name: trigger.name, fn: trigger.fn, type: trigger.type,
    deferrable: trigger.deferrable, deferred: trigger.deferred, enabled: 'O', function_schema: 'public',
    old_table: trigger.oldTable, new_table: trigger.newTable,
  }));
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ triggers: missingTrigger })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT',
  );
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ externalTriggers: [] })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT',
  );
});

test('catalog accepts only the complete exact CP5 publish evidence fence set', async () => {
  const baseRows = ORCHESTRATION_V2_TRIGGERS.map((trigger) => ({
    table: trigger.table, name: trigger.name, fn: trigger.fn, type: trigger.type,
    deferrable: trigger.deferrable, deferred: trigger.deferred, enabled: 'O', function_schema: 'public',
    old_table: trigger.oldTable, new_table: trigger.newTable,
  }));
  const publishRows = ORCHESTRATION_V2_COURSE_PUBLISH_EVIDENCE_TRIGGERS.map((trigger) => ({
    table: trigger.table, name: trigger.name, fn: trigger.fn, type: trigger.type,
    deferrable: trigger.deferrable, deferred: trigger.deferred, enabled: 'O', function_schema: 'public',
    old_table: trigger.oldTable, new_table: trigger.newTable,
  }));

  const result = await verifyOrchestrationV2Schema(catalog({ triggers: [...baseRows, ...publishRows] }));
  assert.equal(result.trigger_count, 70);

  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ triggers: [...baseRows, publishRows[0]] })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT',
  );

  const drifted = structuredClone(publishRows);
  drifted[0].fn = 'unexpected_publish_fence';
  await assert.rejects(
    verifyOrchestrationV2Schema(catalog({ triggers: [...baseRows, ...drifted] })),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_TRIGGER_DRIFT',
  );
});

test('unexpected catalog failures are normalized without exposing database details', async () => {
  const db = { query: async () => { throw new Error('driver details'); } } as unknown as GenerationJobSql;
  await assert.rejects(
    verifyOrchestrationV2Schema(db),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_UNAVAILABLE',
  );
});
