import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  verifyWorkspaceSchema,
  workspaceSchemaContract,
  WORKSPACE_FOUNDATION_GUARDS,
  WORKSPACE_EXECUTION_GUARDS,
  WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES,
} from './lesson-author-workspace-schema.repository.js';
import { ORCHESTRATION_V2_GUARDS, ORCHESTRATION_V2_TABLES } from './lesson-author-orchestration-v2-schema.repository.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';

function fixture(execution = true, v2Installed = false) {
  const contract = workspaceSchemaContract(execution);
  const state = {
    tables: contract.tables.map(name => ({ name, rls: true, browser_access: false, can_write: true, policies: 0, quota_registered: true, constraints_validated: true })),
    functions: Object.entries(contract.guards).map(([signature, hash]) => ({
      signature,
      hash: v2Installed
        ? WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES[
          signature as keyof typeof WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES
        ] ?? ORCHESTRATION_V2_GUARDS[signature as keyof typeof ORCHESTRATION_V2_GUARDS] ?? hash
        : hash,
      v2_table_count: v2Installed ? ORCHESTRATION_V2_TABLES.length : 0,
      definer: false,
      browser_access: false,
      can_execute: true,
      proconfig: ['search_path=pg_catalog, public'],
    })),
    triggers: contract.triggers.map(e => ({ ...e, function_schema: 'public', deferrable: e.deferred, enabled: 'O',
      old_table: e.name.startsWith('tenant_data_quota_direct_') && e.type !== 4 ? 'old_rows' : null,
      new_table: e.name.startsWith('tenant_data_quota_direct_') && e.type !== 8 ? 'new_rows' : null })),
  };
  const sql: string[] = [];
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>(query: string) {
    sql.push(query); assert.match(query, /^SELECT /); assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT)\s+(?:INTO|FROM|TABLE|FUNCTION)\b/);
    const rows = query.includes('FROM pg_trigger t') ? state.triggers : query.startsWith('SELECT x.signature') ? state.functions : state.tables;
    return { rows: structuredClone(rows) as unknown as T[], rowCount: rows.length };
  } };
  return { db, state, sql, run: () => verifyWorkspaceSchema(db, execution) };
}

test('catalog readiness is SELECT-only and does not claim deployment or concurrency verification', async () => {
  for (const execution of [false, true]) {
    const f = fixture(execution), result = await f.run();
    assert.equal(result.status, 'CATALOG_VERIFIED'); assert.equal(result.table_count, execution ? 8 : 4);
    assert.equal(result.guard_count, execution ? 17 : 7); assert.equal(result.runtime_enabled, false);
    assert.equal(result.concurrency_verified, false); assert.equal(f.sql.length, 3);
  }
});
test('missing or browser-accessible schema, invalid quota or unvalidated constraints fail closed', async () => {
  const absent = fixture(); absent.state.tables.pop(); await assert.rejects(absent.run, /WORKSPACE_SCHEMA_MISSING/);
  for (const patch of [{ rls: false }, { browser_access: true }, { can_write: false }, { policies: 1 }, { quota_registered: false }, { constraints_validated: false }]) {
    const f = fixture(); Object.assign(f.state.tables[0], patch); await assert.rejects(f.run, /WORKSPACE_SCHEMA_ACCESS_INVALID/);
  }
});
test('exact function hashes, invoker security, search path and private EXECUTE are required', async () => {
  for (const patch of [{ hash: 'b'.repeat(32) }, { definer: true }, { browser_access: true }, { can_execute: false }, { proconfig: ['search_path=public'] }]) {
    const f = fixture(); Object.assign(f.state.functions[0], patch); await assert.rejects(f.run, /WORKSPACE_SCHEMA_GUARD_DRIFT/);
  }
});
test('workspace verifier accepts only a complete reviewed V1 or V2 guard generation', async () => {
  await assert.doesNotReject(fixture(true, false).run);
  await assert.doesNotReject(fixture(true, true).run);
  const partial = fixture(true, true);
  for (const row of partial.state.functions) row.v2_table_count = ORCHESTRATION_V2_TABLES.length - 1;
  await assert.rejects(partial.run, /WORKSPACE_SCHEMA_GUARD_DRIFT/);
  const mixed = fixture(true, true);
  mixed.state.functions[0].hash = WORKSPACE_FOUNDATION_GUARDS['guard_lesson_author_workspace()'];
  await assert.rejects(mixed.run, /WORKSPACE_SCHEMA_GUARD_DRIFT/);
});
test('trigger count alone is insufficient: timing, function identity, deferred state and transition tables checked', async () => {
  for (const patch of [{ fn: 'permissive_guard' }, { enabled: 'D' }, { type: 5 }, { deferrable: true }, { function_schema: 'attacker' }, { old_table: 'wrong' }]) {
    const f = fixture(); Object.assign(f.state.triggers[0], patch); await assert.rejects(f.run, /WORKSPACE_SCHEMA_TRIGGER_DRIFT/);
  }
  const f = fixture(); f.state.triggers.push({ ...f.state.triggers[0], name: 'unexpected_mutator' });
  await assert.rejects(f.run, /WORKSPACE_SCHEMA_TRIGGER_DRIFT/);
});
test('the approved workspace event notification bridge is accepted only with its exact trigger contract', async () => {
  const accepted = fixture();
  await assert.doesNotReject(accepted.run);
  const notification = accepted.state.triggers.find(trigger => trigger.name === 'trg_la_workspace_event_notify');
  assert.ok(notification);
  for (const patch of [{ fn: 'unexpected_notify' }, { type: 21 }, { deferrable: true }, { enabled: 'D' }, { function_schema: 'attacker' }]) {
    const f = fixture();
    const target = f.state.triggers.find(trigger => trigger.name === 'trg_la_workspace_event_notify');
    assert.ok(target);
    Object.assign(target, patch);
    await assert.rejects(f.run, /WORKSPACE_SCHEMA_TRIGGER_DRIFT/);
  }
});
test('catalog exception text is not leaked', async () => {
  await assert.rejects(verifyWorkspaceSchema({ query: async () => { throw new Error('secret connection data'); } }, true),
    error => error instanceof Error && error.message === 'WORKSPACE_SCHEMA_UNAVAILABLE');
});
test('pinned runtime function bodies match manual SQL artifacts; no stale hash after editing SQL', () => {
  for (const [file, guards] of [
    ['20260929_1611_lesson_author_workspace_foundation.sql', WORKSPACE_FOUNDATION_GUARDS],
    ['20260929_1833_lesson_author_workspace_execution_apply.sql', WORKSPACE_EXECUTION_GUARDS],
  ] as const) {
    const sql = readFileSync(new URL(`../../../../supabase/manual_sql/${file}`, import.meta.url), 'utf8');
    const bodies = [...sql.matchAll(/CREATE FUNCTION public\.(\w+)\s*\([^]*?\)\s*RETURNS\s+\w+[^]*?AS \$(\w+)\$([^]*?)\$\2\$/g)];
    assert.equal(bodies.length, Object.keys(guards).length);
    for (const [signature, expected] of Object.entries(guards)) {
      const body = bodies.find(m => m[1] === signature.split('(')[0]); assert.ok(body, signature);
      const hash = createHash('md5').update(body[3].replace(/\r/g, '').replace(/^[ \n\t]+|[ \n\t]+$/g, '')).digest('hex');
      assert.equal(hash, expected, signature);
    }
  }

  const hotfixSql = readFileSync(
    new URL('../../../../supabase/manual_sql/20261002_2230_lesson_author_four_level_apply_scope.sql', import.meta.url),
    'utf8',
  );
  const hotfixBody = hotfixSql.match(
    /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_apply_receipt\(\)[^]*?AS \$guard\$([^]*?)\$guard\$/,
  );
  assert.ok(hotfixBody);
  const hotfixHash = createHash('md5')
    .update(hotfixBody[1].replace(/\r/g, '').replace(/^[ \n\t]+|[ \n\t]+$/g, ''))
    .digest('hex');
  assert.equal(
    hotfixHash,
    WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES['guard_lesson_author_workspace_apply_receipt()'],
  );

  const mappingHotfixSql = readFileSync(
    new URL('../../../../supabase/manual_sql/20261002_2045_lesson_author_apply_mapping_enum_hotfix.sql', import.meta.url),
    'utf8',
  );
  const mappingHotfixBody = mappingHotfixSql.match(
    /CREATE OR REPLACE FUNCTION public\.guard_lesson_author_workspace_apply_mapping\(\)[^]*?AS \$guard\$([^]*?)\$guard\$/,
  );
  assert.ok(mappingHotfixBody);
  const mappingHotfixHash = createHash('md5')
    .update(mappingHotfixBody[1].replace(/\r/g, '').replace(/^[ \n\t]+|[ \n\t]+$/g, ''))
    .digest('hex');
  assert.equal(
    mappingHotfixHash,
    WORKSPACE_EXECUTION_GUARDS['guard_lesson_author_workspace_apply_mapping()'],
  );
});
