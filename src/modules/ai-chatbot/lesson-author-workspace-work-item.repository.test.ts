import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceWorkItemRepository, WorkspaceWorkItemError, type WorkspaceWorkItemLease,
  type WorkspaceUnitPublication, type WorkspaceWorkItemAccounting, type WorkspaceWorkItemDiagnostic } from './lesson-author-workspace-work-item.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const target: WorkspaceWorkItemLease = { tenantId: uuid(1), userId: uuid(2), conversationId: uuid(3),
  workspaceId: uuid(4), workItemId: uuid(5), leaseToken: uuid(6), courseId: 'course-v1:TEST+WORK+2026' };
const H = 'a'.repeat(64), R = 'b'.repeat(64), C = 'c'.repeat(64), P = 'd'.repeat(64);
const now = Date.parse('2026-09-29T12:00:00Z');
const content = { title: 'Synthetic baseline', purpose: null, data: {}, implementation_notes: null };
const publication: WorkspaceUnitPublication = { validation_contract: 'workspace-unit-baseline-1', input_context_hash: P,
  result_hash: H, baselines: [7,8].map(n => ({ node_id: uuid(n), contract_hash: C, content: structuredClone(content), content_hash: hash(content) })) };
const known: WorkspaceWorkItemAccounting = { state: 'settled', usage_complete: true,
  observed_usage: { inputTokens: 10, outputTokens: 20, embeddingTokens: 0, totalTokens: 30, usage_source: 'provider' } };
const held: WorkspaceWorkItemAccounting = { state: 'pending_reconciliation', usage_complete: false,
  observed_usage: { inputTokens: 10, usage_source: 'mixed_or_unavailable' } };
const code = (expected: string) => (e: unknown) => e instanceof WorkspaceWorkItemError && e.code === expected;
type Row = Record<string, any>;

/** In-memory transaction/trigger simulation only; never PostgreSQL concurrency proof. */
function fixture() {
  let item: Row = { id: target.workItemId, workspace_id: target.workspaceId, tenant_id: target.tenantId, course_id: target.courseId,
    lease_token: target.leaseToken, node_id: uuid(7), ordinal: 0, kind: 'generate_unit', ai_reservation_id: uuid(9),
    contract_hash: C, input_context_hash: P, reserved_tokens: '100', max_output_tokens: 20, max_provider_attempts: 2,
    status: 'running', accounting_state: 'reserved', observed_usage: {}, usage_complete: false, result_hash: null,
    validation_contract: null, failure_code: null, dispatch_started_at: null,
    lease_expires_at: new Date(now+45_000), deadline_at: new Date(now+600_000), database_now: new Date(now) };
  let ws = 'drafting', permission = true, source = H, runtime = R, expiry = now, reservationState = 'reserved';
  let saved: Row[] = [], events: Row[] = [], accountResult = structuredClone(known);
  let failCas = false, badFunctionId = false, corruptReadback = false, commitFailure = false, driftOnAccount = false, permissionAfterAccount = true;
  let accountingFailure: unknown = null, reportFailure = false;
  let contextRows: ((sql: string) => Row[] | null) | null = null;
  const diagnostics: WorkspaceWorkItemDiagnostic[] = [];
  const queries: Array<{sql: string; params: unknown[]}> = [], stages: string[] = [], modes: string[] = [];
  let activeTx: GenerationJobSql | null = null;
  const db: GenerationJobDatabase = { async transaction<T>(work: (tx: GenerationJobSql) => Promise<T>) {
    stages.push('begin');
    const before = structuredClone({ item,ws,reservationState,saved,events });
    const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({sql,params}); let rows: Row[] = [];
      const materialized = contextRows?.(sql);
      if (materialized) return {rows:structuredClone(materialized) as T[],rowCount:materialized.length};
      if (sql.startsWith('SET LOCAL')) stages.push('lock_timeout');
      else if (sql.includes('pg_try_advisory_xact_lock')) { stages.push('advisory'); rows=[{acquired:true}]; }
      else if (sql.startsWith('SELECT id FROM courses')) { stages.push('course'); rows=[{id:target.courseId}]; }
      else if (sql.includes('FROM lesson_author_workspaces w')) {
        stages.push('workspace');
        rows=params[4]===target.userId ? [{id:target.workspaceId,status:ws,source_snapshot_hash:H,correlation_id:uuid(10),content_locale:'en'}] : [];
      } else if (sql.includes('FROM lesson_author_workspace_runs')) {
        stages.push('run'); rows=[{runtime_config_hash:R,inventory_hash:H,manifest_hash:P}];
      } else if (sql.startsWith('SELECT *,clock_timestamp()')) {
        stages.push(sql.includes('FOR UPDATE')?'item_lock':'item_readback');
        rows=params[4]===item.lease_token ? [{...item,database_now:new Date(expiry)}] : [];
        if (!sql.includes('FOR UPDATE') && corruptReadback && rows.length) rows[0].result_hash='e'.repeat(64);
      } else if (sql.startsWith('WITH tick AS MATERIALIZED')) {
        stages.push('renew');
        if (!failCas) { item.heartbeat_at=new Date(expiry); item.lease_expires_at=new Date(expiry+45_000); rows=[{id:item.id}]; }
      } else if (sql.startsWith('UPDATE lesson_author_workspace_work_items SET dispatch_started_at')) {
        stages.push('dispatch');
        if (!failCas) { item.dispatch_started_at=new Date(expiry); rows=[{id:item.id}]; }
      } else if (sql.includes('SELECT public.publish_lesson_author_workspace_unit')) {
        stages.push('publish_function');
        if (failCas) throw new Error('simulated SQL final lease CAS rejection');
        const baselines = JSON.parse(String(params[3])) as Row[];
        saved=baselines.map(n=>({id:n.node_id,contract_hash:C,content_state:'content_ready',current_revision:0,
          content:n.content,content_hash:n.content_hash,operation_id:item.id}));
        item={...item,status:'succeeded',result_hash:params[4],validation_contract:'workspace-unit-baseline-1',
          accounting_state:params[5],usage_complete:params[6],observed_usage:JSON.parse(String(params[7]))};
        events.push({sequence:1,event_kind:'unit_ready'});
        rows=[{work_item_id:badFunctionId?uuid(99):item.id}];
      } else if (sql.startsWith('SELECT n.id,n.contract_hash')) {
        stages.push('baseline_readback'); rows=saved;
      } else if (sql.startsWith('SELECT sequence FROM lesson_author_workspace_events')) {
        rows=events.filter(e=>e.event_kind==='unit_ready');
      } else if (sql.startsWith("UPDATE lesson_author_workspace_work_items SET status='succeeded'")) {
        stages.push('complete_validation');
        if (!failCas) {
          item={...item,status:'succeeded',result_hash:params[5],validation_contract:'workspace-chapter-baseline-1',
            accounting_state:params[6],usage_complete:params[7],observed_usage:JSON.parse(String(params[8]))}; rows=[{id:item.id}];
        }
      } else if (sql.startsWith('UPDATE lesson_author_workspace_work_items SET status=$6')) {
        stages.push('terminal');
        if (!failCas) {
          item={...item,status:params[5],failure_code:params[6],accounting_state:params[7],usage_complete:params[8],
            observed_usage:JSON.parse(String(params[9]))}; rows=[{id:item.id}];
        }
      } else if (sql.startsWith('UPDATE lesson_author_workspaces SET status=$4')) {
        stages.push('stop'); ws=String(params[3]); rows=[{id:target.workspaceId}];
      } else if (sql.startsWith('INSERT INTO lesson_author_workspace_events')) {
        stages.push('event'); const event={sequence:events.length+1,event_kind:params[3]}; events.push(event); rows=[event];
      } else throw new Error('unexpected mock SQL: '+sql);
      return {rows:structuredClone(rows) as T[],rowCount:rows.length};
    } };
    activeTx=tx;
    try { const result=await work(tx); if(commitFailure)throw new Error('simulated deferred constraint'); stages.push('commit'); return result; }
    catch(e) { ({item,ws,reservationState,saved,events}=before); stages.push('rollback'); throw e; }
    finally {activeTx=null;}
  } };
  const repo=createWorkspaceWorkItemRepository({db,
    freshAuthority:async(tx,ctx)=>{ assert.equal(tx,activeTx); assert.ok(Object.isFrozen(ctx)); stages.push('authority'); return permission; },
    currentSourceHash:async(tx,ctx)=>{ assert.equal(tx,activeTx); assert.equal(ctx.target.workspaceId,target.workspaceId); stages.push('source'); return source; },
    currentRuntimeHash:async(tx)=>{ assert.equal(tx,activeTx); stages.push('runtime'); return runtime; },
    account:async(tx,ctx,mode)=>{
      assert.equal(tx,activeTx); assert.equal(ctx.ai_reservation_id,uuid(9)); stages.push('account'); modes.push(mode);
      if(accountingFailure)throw accountingFailure;
      if(driftOnAccount)source='f'.repeat(64);
      permission=permissionAfterAccount;
      reservationState=mode==='release_undispatched'?'released':accountResult.state==='settled'?'finalized':'reserved';
      return structuredClone(accountResult);
    },
    report:event=>{diagnostics.push(event);if(reportFailure)throw new Error('telemetry unavailable');},
  });
  return {repo,queries,stages,modes,diagnostics,item:()=>item,workspace:()=>ws,reservation:()=>reservationState,saved:()=>saved,
    dispatched:()=>{item.dispatch_started_at=new Date(now);}, expired:()=>{expiry=now+46_000;},
    denied:()=>{permission=false;}, wrongSource:()=>{source='f'.repeat(64);}, wrongRuntime:()=>{runtime='f'.repeat(64);},
    kindValidation:()=>{item.kind='validate_chapter';item.max_output_tokens=0;item.max_provider_attempts=0;},
    accounting:(a:WorkspaceWorkItemAccounting)=>{accountResult=structuredClone(a);},
    failCas:()=>{failCas=true;}, badFunctionId:()=>{badFunctionId=true;}, corruptReadback:()=>{corruptReadback=true;},
    commitFailure:()=>{commitFailure=true;}, driftOnAccount:()=>{driftOnAccount=true;}, revokeOnAccount:()=>{permissionAfterAccount=false;},
    accountingFailure:(e:unknown)=>{accountingFailure=e;}, reportFailure:()=>{reportFailure=true;},
    preparation:()=>{
      const allowed=new Set<CourseComponentType>(['html']),blueprint=workspaceInventoryFixture(1),inventory=buildWorkspaceInventory(blueprint,allowed);
      const unitPath='chapter_1.lesson_1.unit_1';
      const ids=new Map(inventory.nodes.map((n,i)=>[n.canonical_path,
        n.canonical_path===unitPath?uuid(7):n.kind==='component'?uuid(8):uuid(100+i)]));
      const nodes=inventory.nodes.filter(n=>n.kind!=='course').map(n=>({id:ids.get(n.canonical_path),parent_id:ids.get(n.parent_path!),
        kind:n.kind,canonical_path:n.canonical_path,sort_order:n.sort_order,protected_contract:n.protected_contract,contract_hash:n.contract_hash,
        current_revision:n.baseline?0:null,content_state:n.baseline?'content_ready':'planned',baseline_content:n.baseline,
        baseline_hash:n.baseline?hash(n.baseline):null,baseline_origin:n.baseline?'ai_baseline':null,baseline_modified:n.baseline?false:null}));
      const targetNodes=nodes.filter(n=>n.kind==='unit'||n.kind==='component').map(n=>({id:n.id,path:n.canonical_path,contract_hash:n.contract_hash}));
      item.contract_hash=targetNodes[0].contract_hash;
      item.input_context_hash=hash({workspace_id:target.workspaceId,node_id:uuid(7),blueprint,inventory_hash:inventory.inventory_hash,
        content_locale:'en',source_snapshot_hash:H,previous:[],targetNodes,allowed:['html']});
      contextRows=sql=>sql.startsWith('SELECT n.canonical_path')
        ? [{canonical_path:unitPath,source_snapshot_hash:H,correlation_id:uuid(10),content_locale:'en',blueprint}]
        : sql.startsWith('SELECT count(*)') ? [{node_count:String(nodes.length),bytes:'10000'}]
        : sql.startsWith('SELECT n.id,n.parent_id') ? nodes : null;
      return {allowed,nodes,blueprint};
    },
  };
}

test('imports have no runtime DB/provider/admission or automatic worker effects', () => {
  const source=readFileSync(new URL('./lesson-author-workspace-work-item.repository.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/from ['"][^'"]*(?:config\/database|config\/env|ai-rag-client|ai-token-quota|runtime.service)/);
  assert.doesNotMatch(source,/setInterval\(|setTimeout\(|INSERT INTO lesson_author_workspace_(?:runs|work_items)/);
  assert.match(source,/SELECT public\.publish_lesson_author_workspace_unit/);
});
test('renew locks course/workspace/run/item and uses fresh same-transaction authority plus persisted CAS', async()=>{
  const f=fixture(); const result=await f.repo.renew(target);
  assert.equal(result.status,'running');
  assert.deepEqual(f.stages.slice(0,9),['begin','lock_timeout','advisory','course','workspace','run','item_lock','authority','source']);
  const q=f.queries.find(q=>q.sql.startsWith('WITH tick'))!;
  assert.ok(q.sql.includes("lease_token=$5")&&q.sql.includes("lease_expires_at>clock_timestamp()"));
  assert.deepEqual(q.params,[target.workItemId,target.workspaceId,target.tenantId,target.courseId,target.leaseToken]);
  assert.equal(f.stages.at(-1),'commit'); assert.equal(f.modes.length,0);
});
test('markDispatch resolves after commit, persists a marker once and rejects repeated dispatch', async()=>{
  const f=fixture(); await f.repo.markDispatched(target);
  assert.ok(f.item().dispatch_started_at); assert.equal(f.stages.at(-1),'commit');
  await assert.rejects(f.repo.markDispatched(target),code('WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED'));
  assert.equal(f.queries.filter(q=>q.sql.startsWith('UPDATE lesson_author_workspace_work_items SET dispatch_started_at')).length,1);
});

test('prepareUnit uses actual revision-0 loader under live persisted lease and returns frozen admission binding',async()=>{
  const f=fixture(),p=f.preparation();const prepared=await f.repo.prepareUnit(target,p.allowed);
  assert.equal(prepared.context.input_context_hash,f.item().input_context_hash);
  assert.equal(prepared.context.unitPath,'chapter_1.lesson_1.unit_1');assert.equal(prepared.item.dispatched,false);
  assert.equal(prepared.deadline_at.getTime(),now+600_000);assert.equal(f.modes.length,0);
  assert.equal(f.stages.at(-1),'commit');assert.equal(f.item().dispatch_started_at,null);
  assert.ok(f.queries.every(q=>q.sql.startsWith('SELECT')||q.sql.startsWith('SET LOCAL')));
});
test('prepareUnit refuses paid replay, expired lease and context/capability drift before dispatch',async()=>{
  const replay=fixture(),a=replay.preparation();replay.dispatched();
  await assert.rejects(replay.repo.prepareUnit(target,a.allowed),code('WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED'));
  const expired=fixture(),b=expired.preparation();expired.expired();
  await assert.rejects(expired.repo.prepareUnit(target,b.allowed),code('WORKSPACE_WORK_ITEM_LEASE_LOST'));
  const drift=fixture(),c=drift.preparation();drift.item().input_context_hash='f'.repeat(64);
  await assert.rejects(drift.repo.prepareUnit(target,c.allowed),code('WORKSPACE_WORK_ITEM_CONFLICT'));
  const denied=fixture();denied.preparation();
  await assert.rejects(denied.repo.prepareUnit(target,new Set()),code('WORKSPACE_WORK_ITEM_UNAVAILABLE'));
  for(const f of [replay,expired,drift,denied])assert.equal(f.modes.length,0);
});
test('wrong owner or lease cannot operate on an otherwise valid item',async()=>{
  const f=fixture(); await assert.rejects(f.repo.renew({...target,userId:uuid(77)}),code('WORKSPACE_WORK_ITEM_NOT_FOUND'));
  await assert.rejects(f.repo.renew({...target,leaseToken:uuid(77)}),code('WORKSPACE_WORK_ITEM_LEASE_LOST'));
  assert.equal(f.modes.length,0);
});
test('expired lease and lost CAS cannot renew or dispatch',async()=>{
  const expired=fixture(); expired.expired(); await assert.rejects(expired.repo.markDispatched(target),code('WORKSPACE_WORK_ITEM_LEASE_LOST'));
  const lost=fixture(); lost.failCas(); await assert.rejects(lost.repo.renew(target),code('WORKSPACE_WORK_ITEM_LEASE_LOST'));
  assert.equal(lost.stages.at(-1),'rollback');
});
test('permission, source and runtime freshness each fail before any lifecycle write',async()=>{
  for(const [change,error] of [['denied','WORKSPACE_WORK_ITEM_FORBIDDEN'],['wrongSource','WORKSPACE_WORK_ITEM_SOURCE_CHANGED'],['wrongRuntime','WORKSPACE_WORK_ITEM_RUNTIME_CHANGED']] as const){
    const f=fixture(); f[change](); await assert.rejects(f.repo.markDispatched(target),code(error));
    assert.equal(f.item().dispatch_started_at,null); assert.equal(f.modes.length,0);
  }
});
test('unit publication uses real named SQL API, checks its receipt, item, immutable baselines and event',async()=>{
  const f=fixture(); f.dispatched(); const result=await f.repo.publishUnit(target,publication);
  assert.equal(result.status,'succeeded'); assert.equal(result.unit_ready_sequence,1); assert.equal(result.replayed,false);
  assert.equal(f.reservation(),'finalized'); assert.equal(f.saved().length,2);
  const q=f.queries.find(q=>q.sql.includes('SELECT public.publish_lesson_author_workspace_unit'))!;
  assert.equal(q.params[2],target.leaseToken); assert.deepEqual(JSON.parse(String(q.params[3])).map((n:Row)=>Object.keys(n)),
    [['node_id','content','content_hash'],['node_id','content','content_hash']]);
  assert.ok(f.stages.indexOf('account')<f.stages.indexOf('publish_function'));
  assert.ok(f.stages.indexOf('publish_function')<f.stages.indexOf('baseline_readback'));
  assert.equal(f.stages.at(-1),'commit');
});
test('successful content with incomplete usage stays fully held and repeat returns receipt without accounting twice',async()=>{
  const f=fixture(); f.dispatched(); f.accounting(held);
  const result=await f.repo.publishUnit(target,publication);
  assert.equal(result.accounting_state,'pending_reconciliation'); assert.equal(f.reservation(),'reserved'); assert.equal(f.workspace(),'drafting');
  const replay=await f.repo.publishUnit(target,publication); assert.equal(replay.replayed,true);
  assert.deepEqual(f.modes,['settle_or_hold']);
  assert.equal(f.queries.filter(q=>q.sql.includes('SELECT public.publish_lesson_author_workspace_unit')).length,1);
  await assert.rejects(f.repo.publishUnit(target,{...publication,result_hash:'f'.repeat(64)}),code('WORKSPACE_WORK_ITEM_CONFLICT'));
});
test('corrupt content hash or duplicate baseline identity rejected before entering transaction',async()=>{
  const f=fixture();
  const bad=structuredClone(publication); bad.baselines[0].content.title='tampered';
  await assert.rejects(f.repo.publishUnit(target,bad),code('WORKSPACE_WORK_ITEM_INVALID'));
  await assert.rejects(f.repo.publishUnit(target,{...publication,baselines:[publication.baselines[0],publication.baselines[0]]}),code('WORKSPACE_WORK_ITEM_INVALID'));
  assert.equal(f.stages.length,0);
});
test('wrong function receipt, wrong item readback, final SQL CAS or deferred commit failure rolls back all output/accounting',async()=>{
  for(const flag of ['badFunctionId','corruptReadback','failCas','commitFailure'] as const){
    const f=fixture(); f.dispatched(); f[flag]();
    await assert.rejects(f.repo.publishUnit(target,publication),code(flag==='badFunctionId'||flag==='corruptReadback'?'WORKSPACE_WORK_ITEM_READBACK_INVALID':'WORKSPACE_WORK_ITEM_UNAVAILABLE'));
    assert.equal(f.saved().length,0); assert.equal(f.reservation(),'reserved'); assert.equal(f.item().status,'running'); assert.equal(f.stages.at(-1),'rollback');
  }
});
test('source drift or permission revocation during accounting rolls back before publication',async()=>{
  for(const flag of ['driftOnAccount','revokeOnAccount'] as const){
    const f=fixture(); f.dispatched(); f[flag]();
    await assert.rejects(f.repo.publishUnit(target,publication),code(flag==='driftOnAccount'?'WORKSPACE_WORK_ITEM_SOURCE_CHANGED':'WORKSPACE_WORK_ITEM_FORBIDDEN'));
    assert.ok(!f.stages.includes('publish_function')); assert.equal(f.reservation(),'reserved');
  }
});
test('validation-only zero-output work accepts truthful no_generation zero usage and is idempotent',async()=>{
  const f=fixture(); f.kindValidation(); f.dispatched();
  f.accounting({state:'settled',usage_complete:true,observed_usage:{inputTokens:0,outputTokens:0,embeddingTokens:0,totalTokens:0,usage_source:'no_generation'}});
  const result=await f.repo.completeValidation(target,{input_context_hash:P,result_hash:H});
  assert.equal(result.status,'succeeded'); assert.equal(f.item().validation_contract,'workspace-chapter-baseline-1');
  const replay=await f.repo.completeValidation(target,{input_context_hash:P,result_hash:H}); assert.equal(replay.replayed,true);
  assert.equal(f.modes.length,1); assert.equal(f.saved().length,0);
});
test('unknown expired dispatched work holds reservation, stops run, emits event and is never requeued',async()=>{
  const f=fixture(); f.dispatched(); f.expired(); f.accounting(held);
  const result=await f.repo.recover(target);
  assert.equal(result.status,'outcome_unknown'); assert.equal(result.accounting_state,'pending_reconciliation');
  assert.equal(f.workspace(),'needs_action'); assert.equal(f.reservation(),'reserved'); assert.deepEqual(f.modes,['hold_unknown']);
  const replay=await f.repo.recover(target); assert.equal(replay.replayed,true); assert.equal(f.modes.length,1);
  assert.ok(!f.queries.some(q=>/status='queued'|INSERT INTO lesson_author_workspace_work_items/.test(q.sql)));
});
test('unknown recovery rejects accounting callback that claims settled known usage',async()=>{
  const f=fixture(); f.dispatched(); f.expired();
  await assert.rejects(f.repo.recover(target),code('WORKSPACE_WORK_ITEM_ACCOUNTING_INVALID'));
  assert.equal(f.item().status,'running'); assert.equal(f.reservation(),'reserved');
});
test('undispatched expiry releases explicitly; recovery cannot steal a live lease',async()=>{
  const f=fixture(); await assert.rejects(f.repo.recover(target),code('WORKSPACE_WORK_ITEM_CONFLICT'));
  f.expired(); const result=await f.repo.recover(target);
  assert.equal(result.status,'timed_out'); assert.equal(f.workspace(),'needs_action'); assert.equal(f.reservation(),'released');
  assert.deepEqual(f.modes,['release_undispatched']);
});
test('live uncertain failure records a hold and stops without pretending its HTTP was canceled',async()=>{
  const f=fixture(); f.dispatched(); f.accounting(held);
  const result=await f.repo.fail(target,{code:'WORKSPACE_TRANSPORT_UNCERTAIN',outcome:'uncertain'});
  assert.equal(result.status,'failed'); assert.equal(result.accounting_state,'pending_reconciliation');
  assert.equal(f.workspace(),'needs_action'); assert.deepEqual(f.modes,['hold_unknown']);
});
test('failure CAS loss rolls back quota changes and never emits a stopped event',async()=>{
  const f=fixture(); f.dispatched(); f.failCas();
  await assert.rejects(f.repo.fail(target,{code:'WORKSPACE_CONTENT_REJECTED',outcome:'known_failure'}),code('WORKSPACE_WORK_ITEM_LEASE_LOST'));
  assert.equal(f.reservation(),'reserved'); assert.equal(f.workspace(),'drafting'); assert.ok(!f.stages.includes('event'));
});
test('expired system recovery holds and stops despite revoked actor/source/runtime; normal writes remain forbidden',async()=>{
  const f=fixture(); f.dispatched(); f.expired(); f.denied(); f.wrongSource(); f.wrongRuntime(); f.accounting(held);
  await assert.rejects(f.repo.renew(target),code('WORKSPACE_WORK_ITEM_FORBIDDEN'));
  const from=f.stages.length;
  const result=await f.repo.recover(target);
  assert.equal(result.status,'outcome_unknown'); assert.equal(f.workspace(),'needs_action'); assert.equal(f.reservation(),'reserved');
  assert.deepEqual(f.modes,['hold_unknown']);
  assert.ok(!f.stages.slice(from).some(s=>['authority','source','runtime','dispatch','publish_function'].includes(s)));
  assert.equal(f.diagnostics.at(-1)?.correlation_id,uuid(10));
});
test('system recovery still rejects live leases and wrong persisted owner/token without fresh-authority callbacks',async()=>{
  const f=fixture(); f.denied();
  await assert.rejects(f.repo.recover(target),code('WORKSPACE_WORK_ITEM_CONFLICT'));
  f.expired();
  await assert.rejects(f.repo.recover({...target,userId:uuid(77)}),code('WORKSPACE_WORK_ITEM_NOT_FOUND'));
  await assert.rejects(f.repo.recover({...target,leaseToken:uuid(77)}),code('WORKSPACE_WORK_ITEM_LEASE_LOST'));
  assert.equal(f.modes.length,0);
});
test('safe diagnostics preserve typed materializer error code and root correlation without private message/content',async()=>{
  const f=fixture(); f.dispatched();
  f.accountingFailure(Object.assign(new Error('PRIVATE SOURCE ANSWER CONTENT'),{code:'WORKSPACE_BASELINE_VALIDATION_FAILED'}));
  await assert.rejects(f.repo.publishUnit(target,publication),code('WORKSPACE_WORK_ITEM_UNAVAILABLE'));
  const event=f.diagnostics.at(-1)!;
  assert.equal(event.internal_failure_code,'WORKSPACE_BASELINE_VALIDATION_FAILED'); assert.equal(event.correlation_id,uuid(10));
  assert.equal(event.operation,'publish_unit'); assert.equal(event.baseline_count,2); assert.equal(event.status,'FAIL');
  assert.ok(event.duration_ms>=0); assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE'));
  assert.deepEqual(Object.keys(event).sort(),['event','operation','workspace_id','work_item_id','correlation_id','node_id','status','internal_failure_code','baseline_count','duration_ms'].sort());
});
test('diagnostics emit only after transaction outcome and telemetry failure cannot undo successful commit',async()=>{
  const f=fixture(); f.reportFailure(); await f.repo.markDispatched(target);
  assert.equal(f.stages.at(-1),'commit'); assert.equal(f.diagnostics.at(-1)?.status,'COMMITTED');
  await assert.rejects(f.repo.markDispatched(target),code('WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED'));
  assert.equal(f.diagnostics.at(-1)?.status,'FAIL');
});
