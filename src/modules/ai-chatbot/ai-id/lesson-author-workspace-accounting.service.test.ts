import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceQuotaAccounting, workspaceUsageObservation } from './lesson-author-workspace-accounting.service.js';
import type { WorkspaceWorkItemContext } from './lesson-author-workspace-work-item.repository.js';
import type { WorkspaceUnitUsage } from './lesson-author-workspace-unit-runner.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';

const actual: WorkspaceUnitUsage = { usage_complete:true, usage_source:'provider',
  usage:{inputTokens:120,outputTokens:60,embeddingTokens:20,totalTokens:200} };
const unknown: WorkspaceUnitUsage = { usage_complete:false,usage_source:'unavailable',usage:{} };
const context = { target:{tenantId:'tenant',workspaceId:'workspace',workItemId:'item',userId:'user',conversationId:'conversation',courseId:'course'},
  ai_reservation_id:'reservation',reserved_tokens:1000,correlation_id:'correlation',kind:'generate_unit',dispatched:true } as WorkspaceWorkItemContext;
function fixture(usage=actual) {
  const state: Record<string,any> = {id:'reservation',status:'reserved',estimated_tokens:1000,budget_metadata:{durable_generation:true},ledger_count:'0'};
  const writes:string[]=[],queries:string[]=[]; let invalidTx=false, identity=true, corruptReadback=false;
  const tx:GenerationJobSql={async query<T extends Record<string,unknown>>(sql:string,params?:unknown[]){
    queries.push(sql);
    if(sql.startsWith('UPDATE')) {writes.push('hold');state.budget_metadata={...state.budget_metadata,...JSON.parse(params![2] as string)};return{rows:[{id:'reservation'}] as unknown as T[],rowCount:1};}
    const copy=structuredClone(state);if(corruptReadback&&sql.includes('ledger_count'))copy.status='reserved';
    const rows=identity?[copy]:[];return{rows:rows as T[],rowCount:rows.length};
  }};
  const account=createWorkspaceQuotaAccounting({transaction:fn=>fn(invalidTx?{...tx}:tx),
    finalize:async input=>{writes.push('finalize');Object.assign(state,{status:'finalized',ledger_count:'1',actual_input_tokens:input.usage.inputTokens,
      actual_output_tokens:input.usage.outputTokens,actual_embedding_tokens:input.usage.embeddingTokens,actual_total_tokens:input.usage.totalTokens});},
    release:async()=>{writes.push('release');state.status='released';},
  },usage,'existing-embedding');
  return{state,writes,queries,account,tx,wrongTransaction:()=>{invalidTx=true;},noIdentity:()=>{identity=false;},badReadback:()=>{corruptReadback=true;}};
}
test('known actual provider usage settles existing ledger once and verifies exact readback',async()=>{
  const f=fixture();const result=await f.account(f.tx,context,'settle_or_hold');
  assert.equal(result.state,'settled');assert.deepEqual(f.writes,['finalize']);assert.equal(f.state.actual_total_tokens,200);
  assert.ok(f.queries[0].includes('FOR UPDATE OF r'));assert.ok(f.queries[0].includes('run.model=r.model'));
  await assert.rejects(()=>f.account(f.tx,context,'settle_or_hold'),/WORKSPACE_ACCOUNTING_IDENTITY_INVALID/);
  assert.deepEqual(f.writes,['finalize']);
});
test('unknown or local usage holds full reservation; never finalizes/releases/fabricates zero',async()=>{
  for(const u of [unknown,{...actual,usage_complete:false,usage_source:'local_estimate' as const}]){
    const f=fixture(u);const result=await f.account(f.tx,context,'settle_or_hold');
    assert.equal(result.state,'pending_reconciliation');assert.deepEqual(f.writes,['hold']);
    assert.equal(f.state.status,'reserved');assert.equal(f.state.estimated_tokens,1000);
    assert.deepEqual(f.state.budget_metadata.workspace_accounting.observed_usage,result.observed_usage);
  }
});
test('uncertain outcome conservatively holds even when a complete observation is available',async()=>{
  const f=fixture();const result=await f.account(f.tx,context,'hold_unknown');
  assert.equal(result.state,'pending_reconciliation');assert.deepEqual(f.writes,['hold']);
});
test('undispatched release requires empty observation and never a dispatched call',async()=>{
  const f=fixture(unknown);assert.equal((await f.account(f.tx,{...context,dispatched:false},'release_undispatched')).state,'settled');
  assert.deepEqual(f.writes,['release']);
  assert.throws(()=>workspaceUsageObservation(context,unknown,'release_undispatched'),/USAGE_INVALID/);
  assert.throws(()=>workspaceUsageObservation({...context,dispatched:false},actual,'release_undispatched'),/USAGE_INVALID/);
});
test('zero no-generation settlement is exclusive to deterministic chapter validation',async()=>{
  const u:WorkspaceUnitUsage={usage_complete:true,usage_source:'no_generation',usage:{inputTokens:0,outputTokens:0,embeddingTokens:0,totalTokens:0}};
  assert.throws(()=>workspaceUsageObservation(context,u,'settle_or_hold'),/USAGE_INVALID/);
  const f=fixture(u);const result=await f.account(f.tx,{...context,kind:'validate_chapter'},'settle_or_hold');
  assert.equal(result.state,'settled');assert.equal(f.state.actual_total_tokens,0);
});
test('no clamping, rounding, omitted counts or false provider attribution',()=>{
  for(const u of [{...actual,usage_source:'local_estimate'}, {...actual,usage:{...actual.usage,outputTokens:1.5}},
    {...actual,usage:{inputTokens:1}},{...actual,usage:{...actual.usage,totalTokens:2_000_001}},
    {...actual,usage:{...actual.usage,privatePrompt:'SECRET'}}]){
    assert.throws(()=>workspaceUsageObservation(context,u as WorkspaceUnitUsage,'settle_or_hold'),/USAGE_INVALID/);
  }
});
test('wrong tx, foreign reservation, incorrect ledger readback fail closed',async()=>{
  const a=fixture();a.wrongTransaction();await assert.rejects(()=>a.account(a.tx,context,'settle_or_hold'),/TRANSACTION_REQUIRED/);assert.equal(a.queries.length,0);
  const b=fixture();b.noIdentity();await assert.rejects(()=>b.account(b.tx,context,'settle_or_hold'),/IDENTITY_INVALID/);assert.equal(b.writes.length,0);
  const c=fixture();c.badReadback();await assert.rejects(()=>c.account(c.tx,context,'settle_or_hold'),/READBACK_INVALID/);
});
test('observation is detached before asynchronous ledger work',async()=>{
  const u=structuredClone(actual),f=fixture(u);u.usage.totalTokens=999;
  await f.account(f.tx,context,'settle_or_hold');assert.equal(f.state.actual_total_tokens,200);
});
