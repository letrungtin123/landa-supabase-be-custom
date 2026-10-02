import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceRuntime, type WorkspaceRuntimeDependencies } from './lesson-author-workspace-runtime.service.js';
import { AppError } from '../../middleware/error-handler.js';

function fixture(){
  const scheduled: Array<()=>void>=[],logs:object[]=[];
  const state={schema:0,queries:0,durable:true,blocked:false};
  let release:(()=>void)|undefined;
  const env={LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED:false,LESSON_AUTHOR_WORKSPACE_READ_ENABLED:true,AI_TOKEN_RESERVATION_SECONDS:600};
  const forbidden=()=>{throw new Error('UNEXPECTED_PROVIDER_OR_DATABASE_MUTATION');};
  const deps={env,AppError,query:async(sql:string)=>{state.queries++;assert.match(sql.trimStart(),/^SELECT/);return{rows:[],rowCount:0};},
    transaction:forbidden,prepareDurableBlueprint:forbidden,prepareWorkspaceContentRuntime:forbidden,
    normalizeLessonAuthorProposal:forbidden,withLessonAuthorConversationLock:forbidden,durableBlueprintRepository:{},
    isDurableBlueprintWorkerReady:()=>state.durable,workspaceQuotaAccounting:forbidden,
    generateRagLessonAuthorCheckpoint:forbidden,reserveTenantAiTokens:forbidden,report:(e:object)=>logs.push(e),
    timers:{set:(fn:()=>void)=>{scheduled.push(fn);return scheduled.length;},clear:()=>{}},
    adapters:{verifyWorkspaceSchema:async()=>{state.schema++;if(state.blocked)await new Promise<void>(r=>{release=r;});
      return{status:'CATALOG_VERIFIED',execution:true,table_count:8,guard_count:17,runtime_enabled:false,concurrency_verified:false};}}} as unknown as WorkspaceRuntimeDependencies;
  return{runtime:createWorkspaceRuntime(deps),deps,env,state,scheduled,logs,release:()=>release?.()};
}
test('disabled runtime performs no catalog read, timer, mutation or provider request',async()=>{
  const f=fixture();await f.runtime.startLessonAuthorWorkspaceWorker();assert.equal(f.runtime.isLessonAuthorWorkspaceReady(),false);
  await f.runtime.stopLessonAuthorWorkspaceWorker();assert.equal(f.state.schema,0);assert.equal(f.state.queries,0);assert.equal(f.scheduled.length,0);
});
test('runtime requires existing durable worker, read gate and 600-second reservation lifetime',async()=>{
  for(const mode of ['durable','read','lifetime']){const f=fixture();f.env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED=true;
    if(mode==='durable')f.state.durable=false;if(mode==='read')f.env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED=false;if(mode==='lifetime')f.env.AI_TOKEN_RESERVATION_SECONDS=599;
    await assert.rejects(f.runtime.startLessonAuthorWorkspaceWorker(),{code:'WORKSPACE_RUNTIME_NOT_READY'});
    assert.equal(f.state.schema,0);assert.equal(f.scheduled.length,0);assert.equal(f.runtime.isLessonAuthorWorkspaceReady(),false);
  }
});
test('one startup verifies catalog once and stop fences scheduled work without claiming concurrency verification',async()=>{
  const f=fixture();f.env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED=true;
  await Promise.all([f.runtime.startLessonAuthorWorkspaceWorker(),f.runtime.startLessonAuthorWorkspaceWorker()]);
  assert.equal(f.state.schema,1);assert.equal(f.scheduled.length,1);assert.equal(f.runtime.isLessonAuthorWorkspaceReady(),true);
  assert.equal((f.logs[0] as any).concurrency_verified,false);
  await f.runtime.stopLessonAuthorWorkspaceWorker();f.scheduled[0]();await Promise.resolve();
  assert.equal(f.runtime.isLessonAuthorWorkspaceReady(),false);assert.equal(f.state.queries,0);
});
test('stop during async catalog inspection never revives admission or starts polling',async()=>{
  const f=fixture();f.env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED=true;f.state.blocked=true;
  const starting=f.runtime.startLessonAuthorWorkspaceWorker();await Promise.resolve();const stopping=f.runtime.stopLessonAuthorWorkspaceWorker();
  f.release();await Promise.all([starting,stopping]);assert.equal(f.runtime.isLessonAuthorWorkspaceReady(),false);assert.equal(f.scheduled.length,0);
});
test('create before runtime readiness rejects without preparing a message, quota or provider',async()=>{
  const f=fixture();await assert.rejects(f.runtime.createLessonAuthorWorkspace({} as any,{} as any),{code:'WORKSPACE_EXECUTION_DISABLED'});
  assert.equal(f.state.queries,0);assert.equal(f.state.schema,0);
});
