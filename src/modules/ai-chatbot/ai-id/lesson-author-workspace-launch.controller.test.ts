import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthUser } from '../../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceLaunchHandlers, type WorkspaceLaunchInput, type WorkspaceLaunchResult } from './lesson-author-workspace-launch.controller.js';
import { LAUNCH_BRIEF_ERROR_MESSAGES, LaunchBriefError } from './lesson-author-launch-brief.logic.js';
import { AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE } from '../../ai-credits/ai-credit.logic.js';
import { AppError } from '../../../utils/errors.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user:AuthUser={id:id(1),tenantId:id(2),role:'staff',username:'fixture',sessionMode:'normal'};
const params={courseId:'course-v1:TEST+WORKSPACE+2026',conversationId:id(3)};
const body:Record<string,unknown>={operation_id:id(4),source_document_ids:[id(5)],content_locale:'vi',design_mode:'instructional_design',
  learner_audience:'Nhân viên mới',course_purpose:'Giúp nhân viên mới hiểu công ty trong tuần đầu.'};
const brief={design_mode:'instructional_design',learner_audience:'Nhân viên mới',course_purpose:'Giúp nhân viên mới hiểu công ty trong tuần đầu.'} as const;
const dto:WorkspaceLaunchResult={workspace_id:id(6),conversation_id:id(3),correlation_id:id(7),content_locale:'vi',status:'designing',launch_brief:brief};
function fixture(){
  const state={read:true,execution:true,edit:true,allowed:true,coursesModuleOn:true,empty:false,invalid:false,throwCreate:false,logThrows:false,transactions:0,
    storedBrief:{...brief,version:1} as unknown};
  const logs:Record<string,unknown>[]=[],creates:WorkspaceLaunchInput[]=[],sqlCalls:{sql:string;params:unknown[]}[]=[];
  const operations=new Set<string>();
  const tx:GenerationJobSql={async query<T extends Record<string,unknown>>(sql:string,p:unknown[]=[]){
    sqlCalls.push({sql,params:p});let rows:Record<string,unknown>[];
    if(sql.includes('FROM users u'))rows=[{role:user.role,tenant_id:user.tenantId,is_active:true,tenant_active:true}];
    else if(sql.includes('FROM user_permission_groups'))rows=[{can_edit:state.allowed}];
    else if(sql.includes('FROM modules m WHERE'))rows=[{id:id(50),is_active:true}];
    else if(sql.includes('FROM tenant_modules tm'))rows=[{is_enabled:state.coursesModuleOn}];
    else if(sql.includes('FROM lesson_author_workspaces w'))rows=state.empty?[]:[{...dto,launch_brief:state.storedBrief,...(state.invalid?{correlation_id:'invalid'}:{})}];
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
  assert.deepEqual(f.creates[0],{courseId:params.courseId,conversationId:params.conversationId,operationId:body.operation_id,sourceDocumentIds:body.source_document_ids,locale:'vi',brief});
  assert.deepEqual(first.payload.data.launch_brief,brief);
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
  // QLT-6: the stored brief without its storage version; a workspace from before QLT-6 reads null.
  assert.match(q.sql,/w\.launch_brief/);assert.deepEqual(r.payload.data.launch_brief,brief);
  assert.equal(Object.hasOwn(r.payload.data.launch_brief,'version'),false);
  f.state.storedBrief=null;assert.equal((await f.invoke('latest')).payload.data.launch_brief,null);
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
test('Latest refuses a tenant whose courses module is turned off exactly as the workspace read routes do',async()=>{
  const off=fixture();off.state.coursesModuleOn=false;const r=await off.invoke('latest');
  // The read routes answer canRead=false (decidePermission: module_disabled) with 403 WORKSPACE_READ_FORBIDDEN.
  assert.equal(r.status,403);assert.equal(r.payload.code,'WORKSPACE_READ_FORBIDDEN');
  assert.equal(off.sqlCalls.some(c=>c.sql.includes('FROM lesson_author_workspaces w')),false,'no workspace is read');
  assert.equal((await fixture().invoke('latest')).status,200,'turned on: unchanged');
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

// --- QLT-6: launch brief on the Create request -----------------------------------------------------------
const {design_mode:_mode,learner_audience:_audience,course_purpose:_purpose,...baseBody}=body;
test('QLT-6: each launch brief problem is a 400 with its own code and plain VI/EN message, before anything is created',async()=>{
  const cases:[Record<string,unknown>,string][]=[
    [{...baseBody},'LESSON_AUTHOR_LAUNCH_MODE_INVALID'],
    [{...body,design_mode:'verbatim'},'LESSON_AUTHOR_LAUNCH_MODE_INVALID'],
    [{...body,design_mode:null},'LESSON_AUTHOR_LAUNCH_MODE_INVALID'],
    [{...body,learner_audience:undefined},'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'],
    [{...baseBody,design_mode:'instructional_design',course_purpose:'Mục đích khoá học.'},'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'],
    [{...body,learner_audience:'   '},'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'],
    [{...body,learner_audience:'<p>&nbsp;</p>'},'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'],
    [{...body,learner_audience:42},'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'],
    [{...body,course_purpose:null},'LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED'],
    [{...baseBody,design_mode:'instructional_design',learner_audience:'Nhân viên mới'},'LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED'],
    [{...body,learner_audience:'a'.repeat(301)},'LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG'],
    [{...body,course_purpose:'b'.repeat(501)},'LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG'],
    [{...baseBody,design_mode:'preserve_source',learner_audience:'Nhân viên mới'},'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED'],
    [{...baseBody,design_mode:'preserve_source',course_purpose:null},'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED'],
    [{...baseBody,design_mode:'preserve_source',learner_audience:''},'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED'],
  ];
  for(const [patch,code] of cases){
    const payload=Object.fromEntries(Object.entries(patch).filter(([,value])=>value!==undefined));
    const f=fixture(),en=await f.invoke('create',{body:payload}),vi=await f.invoke('create',{body:payload,query:{ui_locale:'vi'}});
    assert.equal(en.status,400,code);assert.equal(en.payload.code,code);assert.equal(vi.payload.code,code);
    assert.equal(f.creates.length,0,code);assert.equal(f.state.transactions,0);
    assert.notEqual(en.payload.message,vi.payload.message);
    assert.doesNotMatch(`${en.payload.message} ${vi.payload.message}`,/LESSON_AUTHOR|_|undefined/);
    assert.equal(f.logs.at(-1)?.external_failure_code,code);
  }
  // Unknown keys stay a generic input error (never accepted as a brief field).
  const f=fixture();assert.equal((await f.invoke('create',{body:{...body,learner_level:'beginner'}})).payload.code,'WORKSPACE_CREATE_INPUT_INVALID');
});
test('QLT-6: the brief is cleaned like the author intent and bounded on the trimmed text the panel counts',async()=>{
  const f=fixture();
  const r=await f.invoke('create',{body:{...body,learner_audience:'  <b>Nhân viên</b>\u0000\n mới  ',
    course_purpose:`  ${'Mục đích '.repeat(55).trim()}  `}});
  assert.equal(r.status,202);
  assert.equal(f.creates[0]!.brief.learner_audience,'Nhân viên mới');
  assert.equal(f.creates[0]!.brief.course_purpose,'Mục đích '.repeat(55).trim());
  // 300 / 500 code points after trim are accepted; one more is rejected.
  const edge=fixture();
  assert.equal((await edge.invoke('create',{body:{...body,learner_audience:` ${'a'.repeat(300)} `,course_purpose:'ư'.repeat(500)}})).status,202);
  assert.equal(edge.creates[0]!.brief.learner_audience,'a'.repeat(300));
  const preserve=fixture();
  const kept=await preserve.invoke('create',{body:{...baseBody,design_mode:'preserve_source'}});
  assert.equal(kept.status,202);
  assert.deepEqual(preserve.creates[0]!.brief,{design_mode:'preserve_source',learner_audience:null,course_purpose:null});
});
test('QLT-6: a service-level brief rejection keeps its 400 code; a malformed stored brief fails closed on read',async()=>{
  const f=fixture();f.state.throwCreate=false;
  const rejecting=createWorkspaceLaunchHandlers({readEnabled:()=>true,executionReady:()=>true,db:{async transaction(work){return work({query:async()=>({rows:[],rowCount:0})} as GenerationJobSql);}},
    report:()=>undefined,create:async()=>{throw Object.assign(new Error('x'),{code:'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED'});}});
  let status=0,payload:any;
  await rejecting.create({user,params,body,query:{ui_locale:'en'}} as unknown as Request,
    {setHeader(){},status(n:number){status=n;return this;},json(v:unknown){payload=v;return this;}} as unknown as Response);
  assert.equal(status,400);assert.equal(payload.code,'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED');
  // QLT-6 part 2: a kept-document launch on a pipeline that cannot keep it is a 400 with a plain message too.
  const unavailable=createWorkspaceLaunchHandlers({readEnabled:()=>true,executionReady:()=>true,db:{async transaction(work){return work({query:async()=>({rows:[],rowCount:0})} as GenerationJobSql);}},
    report:()=>undefined,create:async()=>{throw new LaunchBriefError('LESSON_AUTHOR_LAUNCH_MODE_UNAVAILABLE');}});
  for(const ui of ['en','vi']){
    await unavailable.create({user,params,body:{...baseBody,design_mode:'preserve_source'},query:{ui_locale:ui}} as unknown as Request,
      {setHeader(){},status(n:number){status=n;return this;},json(v:unknown){payload=v;return this;}} as unknown as Response);
    assert.equal(status,400);assert.equal(payload.code,'LESSON_AUTHOR_LAUNCH_MODE_UNAVAILABLE');
    assert.equal(payload.message,LAUNCH_BRIEF_ERROR_MESSAGES.LESSON_AUTHOR_LAUNCH_MODE_UNAVAILABLE[ui==='en'?1:0]);
  }
  for(const stored of [{...brief},{...brief,version:2},{...brief,version:1,learner_audience:''},'brief',
    {design_mode:'preserve_source',learner_audience:'',course_purpose:null,version:1}]){
    f.state.storedBrief=stored;const r=await f.invoke('latest');
    assert.equal(r.status,503);assert.equal(r.payload.code,'WORKSPACE_RUNTIME_UNAVAILABLE');
    assert.equal(f.logs.at(-1)?.internal_failure_code,'LESSON_AUTHOR_LAUNCH_BRIEF_STORED_INVALID');
  }
});

// --- AI points: a run the points left cannot cover --------------------------------------------------------
test('AI points: the "not enough AI points" refusal keeps its 429, code and message; other errors keep their mapping',async()=>{
  const creditMessage='Không đủ điểm AI để tạo khoá học. Liên hệ quản trị viên để mua thêm điểm.';
  let thrown:unknown=null;const logs:Record<string,unknown>[]=[];
  const handlers=createWorkspaceLaunchHandlers({readEnabled:()=>true,executionReady:()=>true,
    db:{async transaction(work){return work({query:async()=>({rows:[],rowCount:0})} as GenerationJobSql);}},
    report:e=>{logs.push(e);},create:async()=>{throw thrown;}});
  async function create(ui:'en'|'vi'){
    let status=0,payload:Record<string,unknown>={};
    await handlers.create({user,params,body,query:{ui_locale:ui}} as unknown as Request,
      {setHeader(){},status(n:number){status=n;return this;},json(v:Record<string,unknown>){payload=v;return this;}} as unknown as Response);
    return{status,payload};
  }
  for(const ui of ['en','vi'] as const){
    thrown=new AppError(creditMessage,429,AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE);
    const r=await create(ui);
    assert.equal(r.status,429);assert.equal(r.payload.success,false);
    assert.equal(r.payload.code,'AI_CREDIT_INSUFFICIENT_FOR_RUN');assert.equal(r.payload.message,creditMessage);
    assert.match(String(r.payload.request_id),/^[0-9a-f-]{36}$/);
    assert.equal(logs.at(-1)?.http_status,429);assert.equal(logs.at(-1)?.internal_failure_code,'AI_CREDIT_INSUFFICIENT_FOR_RUN');
  }
  // The same code on an error that was not raised for the client is still an unconfirmed runtime failure.
  thrown=Object.assign(new Error('PRIVATE PROVIDER BODY'),{code:AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE});
  const plain=await create('en');
  assert.equal(plain.status,503);assert.equal(plain.payload.code,'WORKSPACE_RUNTIME_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(plain.payload),/PRIVATE/);
  // Every other mapping is unchanged.
  const cases:[unknown,number,string][]=[
    [new AppError('x',403,'WORKSPACE_RUNTIME_FORBIDDEN'),403,'WORKSPACE_READ_FORBIDDEN'],
    [new AppError('x',409,'WORKSPACE_CREATE_CONFLICT'),409,'WORKSPACE_CREATE_CONFLICT'],
    [new AppError('x',409,'WORKSPACE_ALREADY_ACTIVE'),409,'WORKSPACE_ALREADY_ACTIVE'],
    [new AppError('x',400,'LESSON_AUTHOR_LAUNCH_MODE_UNAVAILABLE'),400,'LESSON_AUTHOR_LAUNCH_MODE_UNAVAILABLE'],
    [new AppError('Đã dùng hết điểm AI của tháng này.',429,'AI_CREDIT_LIMIT_REACHED'),503,'WORKSPACE_RUNTIME_UNAVAILABLE'],
    [new AppError('x',400,'GENERATION_INPUT_REJECTED'),503,'WORKSPACE_RUNTIME_UNAVAILABLE'],
    [new Error('boom'),503,'WORKSPACE_RUNTIME_UNAVAILABLE'],
  ];
  for(const [error,status,code] of cases){
    thrown=error;const r=await create('en');
    assert.equal(r.status,status,code);assert.equal(r.payload.code,code);assert.notEqual(r.payload.message,'x');
  }
});
