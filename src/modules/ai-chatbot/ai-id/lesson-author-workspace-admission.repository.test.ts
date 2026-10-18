import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildWorkspaceBudgetManifest } from './lesson-author-workspace-budget.logic.js';
import { createWorkspaceAdmissionRepository, WorkspaceAdmissionError, type WorkspaceAdmissionTarget,
  type WorkspaceRunAdmission, type WorkspaceAdmissionDiagnostic } from './lesson-author-workspace-admission.repository.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const H='a'.repeat(64), R='b'.repeat(64), C='c'.repeat(64), I='d'.repeat(64);
const target:WorkspaceAdmissionTarget={tenantId:uuid(1),userId:uuid(2),conversationId:uuid(3),workspaceId:uuid(4),courseId:'course-v1:TEST+2026'};
const prepared:WorkspaceRunAdmission={blueprint_job_id:uuid(5),inventory_hash:H,runtime_config_hash:R,model:'test-model',
  budget:buildWorkspaceBudgetManifest([{chapter_node_id:uuid(7),chapter_contract_hash:C,units:[{node_id:uuid(6),contract_hash:C}],
    fixed_input_tokens:100,embedding_tokens:5,output_tokens:20,max_provider_attempts:2}])};
const request={expectedOrdinal:0,idempotencyKey:uuid(8)};
const now=Date.parse('2026-09-29T12:00:00Z');
type Row=Record<string,any>;
const code=(c:string)=>(e:unknown)=>e instanceof WorkspaceAdmissionError && e.code===`WORKSPACE_ADMISSION_${c}`;

/** Offline stateful SQL mock: transaction rollback, not PostgreSQL/trigger proof. */
function fixture() {
  let state:{run:Row|null;items:Row[];reservations:Row[];events:Row[];status:string}={run:null,items:[],reservations:[],events:[],status:'drafting'};
  let permission=true,source=H,runtime=R,inventory=H,input=I,missing=false,commitFailure=false,advisory=true,architecture=true;
  let drift=false,inputDrift=false,grantFailure:unknown=null,reportFailure=false,badReadback=false,failCas=false;
  let corruptGrant:((r:Row)=>void)|null=null,activeTx:GenerationJobSql|null=null;
  const log:string[]=[],diagnostics:WorkspaceAdmissionDiagnostic[]=[],queries:{sql:string;params:unknown[]}[]=[];
  let grants=0,contexts=0;
  let wallNow=now;
  const db:GenerationJobDatabase={async transaction<T>(work:(tx:GenerationJobSql)=>Promise<T>) {
    const before=structuredClone(state); log.push('begin');
    const tx:GenerationJobSql={async query<T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) {
      queries.push({sql,params}); let rows:Row[]=[];
      if(sql.startsWith('SET LOCAL')) log.push('timeout');
      else if(sql.includes('pg_try_advisory_xact_lock')) {log.push('advisory');rows=[{acquired:advisory}];}
      else if(sql.startsWith('SELECT id FROM courses')) {log.push('course');rows=[{id:target.courseId}];}
      else if(sql.startsWith('SELECT w.id,w.status')) {
        log.push('workspace'); rows=params[4]===target.userId?[{id:target.workspaceId,status:state.status,blueprint_id:uuid(10),bot_id:uuid(11),kb_id:uuid(12),
          source_snapshot_hash:H,correlation_id:uuid(13),content_locale:'en'}]:[];
      } else if(sql.startsWith('SELECT * FROM lesson_author_workspace_runs')) {log.push('run');rows=state.run?[state.run]:[];}
      else if(sql.startsWith('SELECT r.estimated_tokens')) {log.push('architecture');rows=architecture?[{estimated_tokens:'500'}]:[];}
      else if(sql.startsWith('INSERT INTO lesson_author_workspace_runs')) {
        log.push('insert_run');state.run={workspace_id:params[0],tenant_id:params[1],course_id:params[2],blueprint_job_id:params[3],blueprint_budget_tokens:params[4],
          inventory_hash:params[5],manifest_hash:params[6],runtime_config_hash:params[7],model:params[8],budget_manifest:JSON.parse(String(params[9])),
          token_ceiling:params[10],total_authorized_tokens:params[11],execution_budget_ms:params[12]};
      } else if(sql.startsWith('SELECT id,node_id,ordinal')) {log.push('items');rows=state.items;}
      else if(sql.startsWith('SELECT id FROM lesson_author_workspace_work_items')) {rows=state.items.filter(a=>a.idempotency_key===params[1]);}
      else if(sql==='SELECT now() AS database_now') {rows=[{database_now:new Date(now)}];}
      else if(sql.startsWith('SELECT *,clock_timestamp() AS database_now FROM ai_token_reservations')) {
        log.push('reservation_read');rows=state.reservations.filter(a=>a.id===params[0]).map(a=>({...a,database_now:new Date(wallNow)}));
      } else if(sql.startsWith('WITH tick AS MATERIALIZED')) {
        log.push('insert_item');const a:Row={id:params[0],workspace_id:params[1],tenant_id:params[2],course_id:params[3],node_id:params[4],ordinal:params[5],
          kind:params[6],contract_hash:params[7],input_context_hash:params[8],idempotency_key:params[9],ai_reservation_id:params[10],reserved_tokens:params[11],
          max_output_tokens:params[12],max_provider_attempts:params[13],lease_token:params[14],created_at:params[15],deadline_at:params[16],
          heartbeat_at:new Date(wallNow),lease_expires_at:new Date(Math.min(wallNow+45000,Date.parse(String(params[16])))),status:'running',accounting_state:'reserved',dispatch_started_at:null};
        if(state.items.some(x=>x.ordinal===a.ordinal)) throw new Error('mock uniqueness');state.items.push(a);
      } else if(sql.startsWith('SELECT *,clock_timestamp() AS database_now FROM lesson_author_workspace_work_items')) {
        log.push('item_readback');rows=state.items.filter(a=>a.id===params[0]).map(a=>({...a,database_now:new Date(wallNow),...(badReadback?{lease_token:uuid(99)}:{})}));
      } else if(sql.startsWith('SELECT id FROM lesson_author_workspace_nodes')) {rows=missing?[{id:uuid(90)}]:[];}
      else if(sql.startsWith('SELECT sequence FROM lesson_author_workspace_events')) {rows=state.events;}
      else if(sql.startsWith('UPDATE lesson_author_workspaces')) {log.push('ready');if(!failCas){state.status='ready';rows=[{id:target.workspaceId}];}}
      else if(sql.startsWith('INSERT INTO lesson_author_workspace_events')) {log.push('event');state.events.push({sequence:42});rows=[{sequence:42}];}
      else if(sql.startsWith('SELECT w.status,w.event_head')) {log.push('ready_readback');rows=[{status:state.status,event_head:42,sequence:badReadback?99:42}];}
      else throw new Error('Unexpected mock SQL: '+sql);
      return {rows:structuredClone(rows) as T[],rowCount:rows.length};
    }};
    activeTx=tx;
    try {const result=await work(tx);if(commitFailure)throw new Error('deferred constraint rejected');log.push('commit');return result;}
    catch(e){state=before;log.push('rollback');throw e;} finally{activeTx=null;}
  }};
  const same=(tx:GenerationJobSql)=>assert.equal(tx,activeTx);
  const repo=createWorkspaceAdmissionRepository({db,
    freshAuthority:async(tx,c)=>{same(tx);log.push('auth');assert.ok(Object.isFrozen(c));return permission;},
    currentSourceHash:async(tx)=>{same(tx);return source;},currentRuntimeHash:async(tx)=>{same(tx);return runtime;},
    currentInventoryHash:async(tx)=>{same(tx);return inventory;},
    inputContextHash:async(tx,c,e)=>{same(tx);contexts++;log.push('context');assert.ok(Object.isFrozen(e));return input;},
    grant:async(tx,c)=>{same(tx);grants++;log.push('grant');assert.ok(Object.isFrozen(c));if(grantFailure)throw grantFailure;
      const reservation:Row={id:uuid(20+grants),tenant_id:target.tenantId,user_id:target.userId,conversation_id:target.conversationId,
        target:'lesson_author',operation:'lesson_author',engine:'self_built_rag',model:c.model,status:'reserved',budget_metadata:structuredClone(c.budget_metadata),
        estimated_tokens:c.reserved_tokens,budget_input_tokens:c.entry.input_tokens,budget_output_tokens:c.entry.output_tokens,
        budget_embedding_tokens:c.entry.embedding_tokens,max_output_tokens:c.entry.max_output_tokens,expires_at:new Date(now+600000).toISOString()};
      corruptGrant?.(reservation);state.reservations.push(reservation);if(drift)source=R;if(inputDrift)input=R;return {reservation_id:reservation.id};},
    report:e=>{diagnostics.push(e);if(reportFailure)throw new Error('telemetry down');}
  });
  function success(index:number,held=false) {
    const e=prepared.budget.manifest.entries[index];
    state.items.push({id:uuid(40+index),node_id:e.node_id,ordinal:index,kind:e.kind,contract_hash:e.contract_hash,status:'succeeded',
      dispatch_started_at:new Date(now),result_hash:H,validation_contract:e.kind==='generate_unit'?'workspace-unit-baseline-1':'workspace-chapter-baseline-1',
      accounting_state:held?'pending_reconciliation':'settled',idempotency_key:uuid(60+index)});
  }
  return {repo,log,queries,diagnostics,success,get state(){return state;},get grants(){return grants;},get contexts(){return contexts;},
    seed:()=>repo.admitRun(target,prepared),setPermission:(v:boolean)=>permission=v,setSource:(v:string)=>source=v,setRuntime:(v:string)=>runtime=v,
    setInventory:(v:string)=>inventory=v,setInput:(v:string)=>input=v,setMissing:()=>missing=true,setCommitFailure:()=>commitFailure=true,
    setAdvisory:()=>advisory=false,setArchitecture:()=>architecture=false,setDrift:()=>drift=true,setInputDrift:()=>inputDrift=true,
    setGrantFailure:(v:unknown)=>grantFailure=v,setCorruptGrant:(f:(r:Row)=>void)=>corruptGrant=f,setBadReadback:()=>badReadback=true,
    setFailCas:()=>failCas=true,setReportFailure:()=>reportFailure=true,setElapsed:(ms:number)=>wallNow=now+ms};
}

test('no runtime/provider imports or retry/recovery mutation; existing budget helper and lease constant used',()=>{
  const source=readFileSync(new URL('./lesson-author-workspace-admission.repository.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/from ['"].*(?:config\/|database\/|gemini|chat\.service|quota\.service)/);
  assert.doesNotMatch(source,/UPDATE lesson_author_workspace_work_items|DELETE FROM|setInterval|setTimeout/);
  assert.match(source,/workspaceBudgetForNextItem/);assert.match(source,/GENERATION_JOB_LEASE_MS/);
  assert.match(source,/FOR UPDATE OF w/);assert.match(source,/FOR SHARE OF j,r/);
  assert.match(source,/SELECT now\(\) AS database_now/);
  assert.doesNotMatch(source,/query\('SELECT clock_timestamp\(\) AS database_now'\)/);
});
test('admission persists exact frozen manifest and architecture envelope, reads back, no quota grant',async()=>{
  const f=fixture(),r=await f.seed();assert.equal(r.total_authorized_tokens,850);assert.equal(r.replayed,false);
  assert.deepEqual(f.state.run?.budget_manifest,prepared.budget.manifest);assert.equal(f.grants,0);
  assert.deepEqual(f.log.slice(0,7),['begin','timeout','advisory','course','workspace','auth','run']);assert.equal(f.log.at(-1),'commit');
  assert.equal(f.diagnostics[0].correlation_id,uuid(13));
});
test('identical admission replay never inserts/reserves; changed immutable contract rejects',async()=>{
  const f=fixture();await f.seed();assert.equal((await f.seed()).replayed,true);assert.equal(f.log.filter(x=>x==='insert_run').length,1);
  await assert.rejects(f.repo.admitRun(target,{...prepared,model:'another'}),code('CONFLICT'));assert.equal(f.grants,0);
});
test('invalid sums/hash or missing bound Blueprint never admits',async()=>{
  const f=fixture();await assert.rejects(f.repo.admitRun(target,{...prepared,budget:{...prepared.budget,token_ceiling:1}}),code('INVALID'));
  f.setArchitecture();await assert.rejects(f.seed(),code('CONFLICT'));assert.equal(f.state.run,null);
});
test('owner, advisory, fresh auth/source/runtime/inventory fail closed',async()=>{
  const wrong=fixture();await assert.rejects(wrong.repo.admitRun({...target,userId:uuid(99)},prepared),code('NOT_FOUND'));
  for(const [change,expected] of [
    [(f:ReturnType<typeof fixture>)=>f.setAdvisory(),'CONFLICT'],[(f:ReturnType<typeof fixture>)=>f.setPermission(false),'FORBIDDEN'],
    [(f:ReturnType<typeof fixture>)=>f.setSource(R),'SOURCE_CHANGED'],[(f:ReturnType<typeof fixture>)=>f.setRuntime(H),'RUNTIME_CHANGED'],
    [(f:ReturnType<typeof fixture>)=>f.setInventory(R),'INVENTORY_CHANGED']] as const){const f=fixture();change(f);await assert.rejects(f.seed(),code(expected));assert.equal(f.state.run,null);}
});
test('claim persists token-bound real lease with exact reservation, input hash, and DB deadline before return',async()=>{
  const f=fixture();await f.seed();const r=await f.repo.claimNext(target,request),a=f.state.items[0];
  assert.equal(a.id,r.lease.workItemId);assert.equal(a.lease_token,r.lease.leaseToken);assert.equal(a.input_context_hash,I);
  assert.equal(a.reserved_tokens,245);assert.equal(a.max_output_tokens,20);assert.equal(a.max_provider_attempts,2);
  assert.equal(r.deadline_at,new Date(now+600000).toISOString());assert.equal(f.grants,1);assert.equal(f.contexts,2);
  assert.equal(f.log.at(-1),'commit');assert.equal(f.state.reservations[0].budget_metadata.workspace_work_item_id,a.id);
  assert.ok(f.log.indexOf('grant')<f.log.indexOf('reservation_read'));assert.ok(f.log.indexOf('reservation_read')<f.log.indexOf('insert_item'));
});
test('same claimed ordinal cannot replay or consume another quota reservation',async()=>{
  const f=fixture();await f.seed();await f.repo.claimNext(target,request);
  await assert.rejects(f.repo.claimNext(target,request),code('CONFLICT'));assert.equal(f.grants,1);assert.equal(f.state.items.length,1);
});
test('quota now()+600s and claim transaction tick agree after admission delay; expired remaining envelope rolls back',async()=>{
  const f=fixture();await f.seed();f.setElapsed(30000);const r=await f.repo.claimNext(target,request);
  assert.equal(r.deadline_at,new Date(now+600000).toISOString());assert.equal(f.state.reservations[0].expires_at,r.deadline_at);
  assert.equal(Date.parse(r.deadline_at)-(now+30000),570000);
  const expired=fixture();await expired.seed();expired.setElapsed(600000);
  await assert.rejects(expired.repo.claimNext(target,request),code('GRANT_INVALID'));assert.equal(expired.state.reservations.length,0);
});
test('failed/unknown/timed out/canceled/running prior blocks next, including expired undispatched',async()=>{
  for(const status of ['failed','outcome_unknown','timed_out','canceled','running']){
    const f=fixture();await f.seed();f.success(0);f.state.items[0].status=status;
    await assert.rejects(f.repo.claimNext(target,{...request,expectedOrdinal:1}),code('CONFLICT'));assert.equal(f.grants,0);
  }
});
test('known content success with held usage permits final validation zero output/attempt grant',async()=>{
  const f=fixture();await f.seed();f.success(0,true);
  const r=await f.repo.claimNext(target,{...request,expectedOrdinal:1});assert.equal(r.kind,'validate_chapter');
  const a=f.state.items[1];assert.equal(a.max_output_tokens,0);assert.equal(a.max_provider_attempts,0);assert.equal(a.reserved_tokens,105);
  assert.equal(f.state.items[0].accounting_state,'pending_reconciliation');
});
test('stale expected ordinal, reused idempotency and exhausted manifest do not grant',async()=>{
  const f=fixture();await f.seed();f.success(0);
  await assert.rejects(f.repo.claimNext(target,request),code('CONFLICT'));
  await assert.rejects(f.repo.claimNext(target,{expectedOrdinal:1,idempotencyKey:uuid(60)}),code('CONFLICT'));
  f.success(1);await assert.rejects(f.repo.claimNext(target,{...request,expectedOrdinal:2}),code('CONFLICT'));assert.equal(f.grants,0);
});
test('actual partial/wrong-owner/non-durable/expired reservation rolls back grant and item',async()=>{
  for(const corrupt of [(r:Row)=>r.estimated_tokens--,(r:Row)=>r.user_id=uuid(99),(r:Row)=>r.budget_metadata.durable_generation=false,
    (r:Row)=>r.budget_metadata.workspace_work_item_id=uuid(99),(r:Row)=>r.max_output_tokens=1,
    (r:Row)=>r.budget_embedding_tokens=0,(r:Row)=>r.expires_at=new Date(now),(r:Row)=>r.status='released']){
    const f=fixture();await f.seed();f.setCorruptGrant(corrupt);await assert.rejects(f.repo.claimNext(target,request),code('GRANT_INVALID'));
    assert.equal(f.state.reservations.length,0);assert.equal(f.state.items.length,0);
  }
});
test('source drift or exact context drift during grant rolls everything back',async()=>{
  for(const drift of ['source','input']){const f=fixture();await f.seed();if(drift==='source')f.setDrift();else f.setInputDrift();
    await assert.rejects(f.repo.claimNext(target,request),code(drift==='source'?'SOURCE_CHANGED':'CONFLICT'));
    assert.equal(f.state.items.length,0);assert.equal(f.state.reservations.length,0);}
});
test('invalid real context fails before grant, bad item receipt and deferred commit failure roll back',async()=>{
  const invalid=fixture();await invalid.seed();invalid.setInput('bad');await assert.rejects(invalid.repo.claimNext(target,request),code('INVALID'));assert.equal(invalid.grants,0);
  for(const deferred of [false,true]){const f=fixture();await f.seed();if(deferred)f.setCommitFailure();else f.setBadReadback();
    await assert.rejects(f.repo.claimNext(target,request),code(deferred?'UNAVAILABLE':'READBACK_INVALID'));
    assert.equal(f.state.items.length,0);assert.equal(f.state.reservations.length,0);assert.equal(f.diagnostics.at(-1)?.status,'FAIL');}
});
test('completion requires all succeeded items and content-ready inventory, never fabricates validation',async()=>{
  const f=fixture();await f.seed();f.success(0);await assert.rejects(f.repo.completeRun(target),code('CONFLICT'));
  f.success(1);f.setMissing();await assert.rejects(f.repo.completeRun(target),code('CONFLICT'));assert.equal(f.state.status,'drafting');assert.equal(f.state.events.length,0);
});
test('complete run updates status, inserts real guarded event and verifies exact cursor; repeat reads receipt',async()=>{
  const f=fixture();await f.seed();f.success(0,true);f.success(1);
  const r=await f.repo.completeRun(target);assert.equal(r.run_ready_sequence,42);assert.equal(r.replayed,false);assert.equal(f.state.status,'ready');
  assert.equal((await f.repo.completeRun(target)).replayed,true);assert.equal(f.state.events.length,1);assert.equal(f.grants,0);
  assert.equal(f.state.items[0].accounting_state,'pending_reconciliation');
});
test('completion CAS/readback/deferred failure rolls back ready event and state',async()=>{
  for(const mode of ['cas','readback','deferred']){const f=fixture();await f.seed();f.success(0);f.success(1);
    if(mode==='cas')f.setFailCas();else if(mode==='readback')f.setBadReadback();else f.setCommitFailure();
    await assert.rejects(f.repo.completeRun(target),code(mode==='cas'?'CONFLICT':mode==='readback'?'READBACK_INVALID':'UNAVAILABLE'));
    assert.equal(f.state.status,'drafting');assert.equal(f.state.events.length,0);}
});
test('safe root-correlated diagnostic retains typed callback code but no content/error message',async()=>{
  const f=fixture();await f.seed();f.setGrantFailure(Object.assign(new Error('private content / secret'),{code:'QUOTA_CAPACITY_EXCEEDED'}));
  await assert.rejects(f.repo.claimNext(target,request),code('UNAVAILABLE'));const event=f.diagnostics.at(-1)!;
  assert.equal(event.internal_failure_code,'QUOTA_CAPACITY_EXCEEDED');assert.equal(event.correlation_id,uuid(13));assert.ok(event.work_item_id);
  assert.doesNotMatch(JSON.stringify(event),/private|secret|input_tokens|test-model/);assert.ok(event.duration_ms>=0);
});
test('telemetry failure cannot erase committed admission/claim',async()=>{
  const f=fixture();f.setReportFailure();await f.seed();await f.repo.claimNext(target,request);assert.equal(f.state.items.length,1);
});
