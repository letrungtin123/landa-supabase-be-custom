import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import {
  ORCHESTRATION_V2_GUARDS,
  ORCHESTRATION_V2_TABLES,
  ORCHESTRATION_V2_TRIGGERS,
  OrchestrationV2SchemaError,
  verifyOrchestrationV2Schema,
} from './lesson-author-orchestration-v2-schema.repository.js';

type Overrides = {
  table?: Record<string, unknown>;
  fn?: Record<string, unknown>;
  triggers?: Array<Record<string, unknown>>;
};

function catalog(overrides: Overrides = {}): GenerationJobSql {
  return {
    async query(sql: string) {
      if (sql.includes('FROM pg_class c JOIN pg_namespace')) {
        return { rows: ORCHESTRATION_V2_TABLES.map((name) => ({
          name, rls: true, browser_access: false, can_write: true, policies: 0,
          quota_registered: true, constraints_validated: true, ...overrides.table,
        })) };
      }
      if (sql.includes('FROM unnest($1::text[])')) {
        return { rows: Object.entries(ORCHESTRATION_V2_GUARDS).map(([signature, hash]) => ({
          signature, proname: signature.slice(0, -2), definer: false,
          proconfig: ['search_path=pg_catalog, public'], hash,
          browser_access: false, can_execute: true, ...overrides.fn,
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
  assert.equal(ORCHESTRATION_V2_TABLES.length, 8);
  assert.equal(Object.keys(ORCHESTRATION_V2_GUARDS).length, 16);
  assert.equal(ORCHESTRATION_V2_TRIGGERS.length, 43);
  const result = await verifyOrchestrationV2Schema(catalog());
  assert.deepEqual(result, {
    status: 'CATALOG_VERIFIED', contract_version: 2, table_count: 8, guard_count: 16,
    trigger_count: 43, runtime_enabled: false, concurrency_verified: false,
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
});

test('unexpected catalog failures are normalized without exposing database details', async () => {
  const db = { query: async () => { throw new Error('driver details'); } } as unknown as GenerationJobSql;
  await assert.rejects(
    verifyOrchestrationV2Schema(db),
    (error) => error instanceof OrchestrationV2SchemaError && error.code === 'ORCHESTRATION_V2_SCHEMA_UNAVAILABLE',
  );
});
