import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceLaunchHandlers, type WorkspaceLaunchInput, type WorkspaceLaunchResult } from './lesson-author-workspace-launch.controller.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user:AuthUser={id:id(1),tenantId:id(2),role:'staff',username:'fixture',sessionMode:'normal'};
const params={courseId:'course-v1:TEST+WORKSPACE+2026',conversationId:id(3)};
const body={operation_id:id(4),source_document_ids:[id(5)],content_locale:'vi'};
const dto:WorkspaceLaunchResult={workspace_id:id(6),conversation_id:id(3),correlation_id:id(7),content_locale:'vi',status:'designing'};
function fixture(){
  const state={read:true,execution:true,edit:true,allowed:true,empty:false,invalid:false,throwCreate:false,logThrows:false,transactions:0};
  const logs:Record<string,unknown>[]=[],creates:WorkspaceLaunchInput[]=[],sqlCalls:{sql:string;params:unknown[]}[]=[];
  const operations=new Set<string>();
  const tx:GenerationJobSql={async query<T extends Record<string,unknown>>(sql:string,p:unknown[]=[]){
    sqlCalls.push({sql,params:p});let rows:Record<string,unknown>[];
    if(sql.includes('FROM users u'))rows=[{role:user.role,tenant_id:user.tenantId,is_active:true,tenant_active:true}];
    else if(sql.includes('FROM user_permission_groups'))rows=[{can_edit:state.allowed}];
    else if(sql.includes('FROM lesson_author_workspaces w'))rows=state.empty?[]:[{...dto,...(state.invalid?{correlation_id:'invalid'}:{})}];
    else throw new Error('Unexpected fixture query');
    return{rows:rows as T[],rowCount:rows.length};
  }};
  const handlers=createWorkspaceLaunchHandlers({readEnabled:()=>state.read,executionReady:()=>state.execution,editEnabled:()=>state.edit,
    db:{async transaction(work){state.transactions++;return work(tx);}},report:e=>{logs.push(e);if(state.logThrows)throw new Error('logger');},
    create:async(actor,input)=>{
      assert.deepEqual(actor,user);creates.push(input);
      if(state.throwCreate)throw Object.assign(new Error('PRIVATE PROVIDER BODY'),{code:'WORKSPACE_ALREADY_ACTIVE'});
      const replayed=operations.has(input.operationId);operations.add(input.operationId);
      return{...dto,replayed,...(state.invalid?{workspace_id:'bad'}:{})};
    }});
  async function invoke(action:'create'|'latest'='create',overrides:Partial<Request>={}){
    let status=200,payload:any;const headers:Record<string,string>={};
    const req={user,params,body,query:{ui_locale:'en'},...overrides} as Request;
    const res={setHeader(k:string,v:string){headers[k]=v;},status(n:number){status=n;return this;},json(v:unknown){payload=v;return this;}} as unknown as Response;
    await handlers[action](req,res);return{status,payload,headers};
  }
  return{state,handlers,logs,creates,sqlCalls,invoke};
}
test('Create returns an immediate safe shell receipt and preserves one operation/root identity on replay',async()=>{
  const f=fixture(),first=await f.invoke(),second=await f.invoke();
  assert.equal(first.status,202);assert.equal(second.status,200);
  assert.deepEqual(f.creates[0],{courseId:params.courseId,conversationId:params.conversationId,operationId:body.operation_id,sourceDocumentIds:body.source_document_ids,locale:'vi'});
  assert.equal(first.payload.data.correlation_id,second.payload.data.correlation_id);
  assert.equal(first.payload.data.can_edit,true);assert.equal(first.headers['Cache-Control'],'no-store');
  assert.notEqual(first.headers['X-Request-ID'],dto.correlation_id);
  assert.equal(f.logs[0].correlation_id,dto.correlation_id);assert.equal(f.state.transactions,0);
});
test('Latest is read-only, actor-owned and does not admit work even when execution is disabled',async()=>{
  const f=fixture();f.state.execution=false;f.state.edit=false;
  const r=await f.invoke('latest');assert.equal(r.status,200);assert.equal(r.payload.data.can_edit,false);assert.equal(f.creates.length,0);
  assert.ok(f.sqlCalls.every(c=>c.sql.trimStart().startsWith('SELECT')));
  const q=f.sqlCalls.find(c=>c.sql.includes('FROM lesson_author_workspaces w'))!;
  assert.deepEqual(q.params,[user.tenantId,params.courseId,user.id]);
  assert.match(q.sql,/c\.user_id=w\.requested_by/);assert.match(q.sql,/tenant_kb_assignments/);assert.match(q.sql,/d\.tenant_id=w\.tenant_id/);
  f.state.empty=true;assert.equal((await f.invoke('latest')).payload.data,null);
});
test('Missing auth, learner, demo and cross-session identity never reach create or SQL',async()=>{
  for(const subject of [undefined,{...user,role:'learner'},{...user,sessionMode:'demo_iframe'},{...user,tenantId:''}]){
    const f=fixture(),r=await f.invoke('create',{user:subject as AuthUser});
    assert.ok([401,403].includes(r.status));assert.equal(f.creates.length,0);assert.equal(f.state.transactions,0);
  }
});
test('Create and read require explicit feature readiness',async()=>{
  for(const field of ['read','execution'] as const){const f=fixture();f.state[field]=false;
    assert.equal((await f.invoke()).status,503);assert.equal(f.creates.length,0);}
  const f=fixture();f.state.read=false;assert.equal((await f.invoke('latest')).status,503);assert.equal(f.state.transactions,0);
});
test('Untrusted identity, prompt, proof, duplicate source, empty selection and invalid locale are rejected before admission',async()=>{
  const cases=[{tenant_id:id(99)},{prompt:'PRIVATE PROMPT'},{checks:{schema:'PASS'}},{source_document_ids:[]},
    {source_document_ids:[id(5),id(5)]},{source_document_ids:[1]},{source_document_ids:Array.from({length:6},(_,n)=>id(n+10))},
    {operation_id:'bad'},{content_locale:'fr'},{content_locale:['vi']}];
  for(const patch of cases){const f=fixture();assert.equal((await f.invoke('create',{body:{...body,...patch}})).status,400);assert.equal(f.creates.length,0);}
  const f=fixture();assert.equal((await f.invoke('create',{query:{ui_locale:['en']}})).status,400);
  assert.equal((await f.invoke('create',{params:{...params,conversationId:'bad'}})).status,400);
  assert.equal((await f.invoke('latest',{query:{user_id:id(99)}})).status,400);
});
test('Fresh authorization denial and malformed persisted receipts fail closed',async()=>{
  const denied=fixture();denied.state.allowed=false;assert.equal((await denied.invoke('latest')).status,403);
  assert.ok(!denied.sqlCalls.some(c=>c.sql.includes('FROM lesson_author_workspaces w')));
  for(const action of ['latest','create'] as const){const f=fixture();f.state.invalid=true;assert.equal((await f.invoke(action)).status,503);}
});
test('Operational failures use safe codes/ENVI messages, never exception or document/provider contents',async()=>{
  const f=fixture();f.state.throwCreate=true;
  const en=await f.invoke(),vi=await f.invoke('create',{query:{ui_locale:'vi'}});
  assert.equal(en.status,409);assert.equal(en.payload.code,'WORKSPACE_ALREADY_ACTIVE');
  assert.notEqual(en.payload.message,vi.payload.message);assert.doesNotMatch(JSON.stringify([en,vi,f.logs]),/PRIVATE|source_document_ids/);
  assert.equal(f.logs[0].failure_stage,'workspace_create');assert.equal(typeof f.logs[0].duration_ms,'number');
});
test('Diagnostic sink failure does not turn a committed create receipt into a retry',async()=>{
  const f=fixture();f.state.logThrows=true;assert.equal((await f.invoke()).status,202);assert.equal(f.creates.length,1);
});
test('Actual Express route handles encoded course ID and returns a JSON shell without SSE/provider execution',async()=>{
  const f=fixture(),app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=user;next();});
  app.post('/courses/:courseId/conversations/:conversationId/workspaces',f.handlers.create);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/courses/${encodeURIComponent(params.courseId)}/conversations/${params.conversationId}/workspaces?ui_locale=en`,
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,202);assert.match(response.headers.get('content-type')??'',/application\/json/);
    assert.equal((await response.json() as any).data.workspace_id,dto.workspace_id);assert.equal(f.creates[0].courseId,params.courseId);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
