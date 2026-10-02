import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runWorkspaceChapter, type WorkspaceChapterExecution, type WorkspaceChapterRunnerDependencies } from './lesson-author-workspace-chapter-runner.js';
import { workspaceChapterValidationUnits } from './lesson-author-workspace-chapter-validation.logic.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { projectBlueprintDraftArchitecture } from './lesson-author-blueprint-draft-architecture.logic.js';
import { componentPlanId } from './lesson-author-capabilities.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { WorkspaceChapterGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { WorkspaceUnitClock } from './lesson-author-workspace-unit-runner.js';
import type { WorkspaceWorkItemReceipt } from './lesson-author-workspace-work-item.repository.js';
import type { RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`, H='a'.repeat(64);
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((y,n)=>{resolve=y;reject=n;});return{promise,resolve,reject};}
async function until(p:()=>boolean){for(let i=0;i<100;i++){if(p())return;await Promise.resolve();}assert.fail('async boundary not reached');}
function timers(){
  let now=Date.parse('2026-09-29T12:00:00Z');const tasks=new Set<{at:number;repeat:number;run:()=>void}>();
  const schedule=(run:()=>void,ms:number,repeat:number)=>{const t={at:now+ms,repeat,run};tasks.add(t);return()=>{tasks.delete(t);};};
  const clock:WorkspaceUnitClock={now:()=>now,timeout:(fn,ms)=>schedule(fn,ms,0),interval:(fn,ms)=>schedule(fn,ms,ms)};
  return{clock,size:()=>tasks.size,advance(ms:number){now+=ms;for(const t of [...tasks])if(t.at<=now){if(t.repeat)t.at=now+t.repeat;else tasks.delete(t);t.run();}}};
}
function fixture(locale:'en'|'vi'='en'){
  const time=timers(),blueprint=workspaceInventoryFixture(1,locale),allowed=new Set<CourseComponentType>(['html']);
  const chapter=blueprint.chapters[0],lesson=chapter.lessons[0],unit=lesson.units[0];
  unit.component_plan[0].component_plan_id=componentPlanId('chapter_1.lesson_1.unit_1','html',['block_1']);
  const inventory=buildWorkspaceInventory(blueprint,allowed),chapterNode=inventory.nodes.find(n=>n.kind==='chapter')!;
  const component={type:'html' as const,title:'Synthetic explanation',data:'<p>The concept describes the relationship between the stated information and its intended meaning. Read the definition carefully, identify its distinguishing characteristics, and compare those characteristics with the explanation provided here. For example, an observation records what is visible, whereas an interpretation explains the significance of that observation. Keep these categories separate when discussing the concept. Explain each distinction in your own words and review the original definition before proceeding to the next topic.</p>',
    metadata:{component_plan_id:unit.component_plan[0].component_plan_id,source_fact_ids:['fact_1'],covered_source_fact_ids:['fact_1'],supporting_evidence_fact_ids:[],learning_objective_refs:['lo_1']}};
  const context:WorkspaceChapterGenerationContext={blueprint,chapterIndex:0,allowed,input_context_hash:H,source_snapshot_hash:H,correlation_id:id(9),
    targetNodes:[{id:id(20),path:'chapter_1',contract_hash:chapterNode.contract_hash}],
    proposal:{summary:'CMS baseline remains unchanged',chapters:[{title:chapter.title,lessons:[{title:lesson.title,units:[{title:unit.title,components:[component]}]}]}]}};
  const execution:WorkspaceChapterExecution={deadline_at:new Date(time.clock.now()+600000),item:{
    target:{tenantId:id(1),userId:id(2),workspaceId:id(3),conversationId:id(4),courseId:'course-v1:TEST+WS+2026',workItemId:id(5),leaseToken:id(6)},
    node_id:id(20),kind:'validate_chapter',ordinal:1,source_snapshot_hash:H,runtime_config_hash:H,inventory_hash:H,manifest_hash:H,
    contract_hash:chapterNode.contract_hash,input_context_hash:H,ai_reservation_id:id(7),reserved_tokens:100,max_output_tokens:0,max_provider_attempts:0,
    correlation_id:id(9),content_locale:locale,dispatched:false}};
  const request:RagChapterCheckpointRequest={tenant_id:id(1),conversation_id:id(4),kb_id:id(8),correlation_id:id(9),
    target:'lesson_author',model:'transport-model',max_output_tokens:30000,max_attempts:2,embedding_model:'transport-embedding',embedding_dimensions:768,
    system_prompt:'PRIVATE_PROMPT_SENTINEL',user_message:'PRIVATE_SOURCE_SENTINEL',history:[],
    source_documents:[{document_id:id(10),kb_id:id(8),name:'synthetic.pdf',type:'pdf',status:'ready'}],
    outline_context:'',target_scope_instruction:'',output_schema_hint:'',operation:'create',target_type:'chapter',generation_mode:'staged',locale,
    blueprint_architecture:projectBlueprintDraftArchitecture(blueprint,0),checkpoint_version:1,checkpoint_action:'validate_chapter',
    checkpoint_units:workspaceChapterValidationUnits(context),remaining_workflow_budget_ms:480000};
  const response={checkpoint_version:1,correlation_id:id(9),status:'ready',proposal:{chapters:[{title:chapter.title,lessons:[{
    title:lesson.title,units:request.checkpoint_units.map(u=>structuredClone(u.unit))}]}]},retrieval:{},
    workflow:{status:'ready',workflow:'lesson_generation',workflow_version:'chapter-checkpoint-1',repair_count:0},
    usage_complete:true,usage_source:'no_generation',usage:{inputTokens:0,outputTokens:0,embeddingTokens:0,totalTokens:0}};
  const receipt:WorkspaceWorkItemReceipt={workspace_id:id(3),work_item_id:id(5),node_id:id(20),status:'running',accounting_state:'reserved',result_hash:null,replayed:false};
  const calls:string[]=[],events:Record<string,unknown>[]=[],completions:unknown[]=[],failures:unknown[]=[];
  const deps:WorkspaceChapterRunnerDependencies={clock:time.clock,prepare:async()=>{calls.push('prepare');return{context,request};},
    markDispatched:async()=>{calls.push('dispatch_commit');return{...receipt};},renew:async()=>{calls.push('renew');return{...receipt};},
    validate:async(r,o)=>{calls.push('validate');assert.equal(r.checkpoint_action,'validate_chapter');assert.equal(r.max_output_tokens,request.max_output_tokens);assert.equal(r.max_attempts,request.max_attempts);
      assert.equal(r.remaining_workflow_budget_ms,o.timeoutMs);return structuredClone(response);},
    completeValidation:async(_,c,u)=>{calls.push('complete_commit');completions.push(c,u);return{...receipt,status:'succeeded',
      accounting_state:u.usage_complete?'settled':'pending_reconciliation',result_hash:c.result_hash};},
    fail:async(_,f,u)=>{calls.push('fail_commit');failures.push(f,u);return{...receipt,status:'failed',accounting_state:'pending_reconciliation'};},
    report:e=>{events.push(e);}};
  return{time,execution,context,component,request,response,receipt,calls,events,completions,failures,deps,run:(signal?:AbortSignal)=>runWorkspaceChapter(execution,deps,signal)};
}

test('EN/VI actual chapter acceptance; zero generation admission, unchanged request policy, no CMS overwrite',async()=>{
  for(const locale of ['en','vi'] as const){const f=fixture(locale),before=hash(f.context.proposal);assert.equal(await f.run(),'chapter_validated');
    assert.deepEqual(f.calls,['prepare','dispatch_commit','validate','complete_commit']);assert.equal(hash(f.context.proposal),before);
    assert.equal(f.execution.item.max_output_tokens,0);assert.equal(f.execution.item.max_provider_attempts,0);assert.equal(f.request.max_output_tokens,30000);
    const c=f.completions[0] as {result_hash:string};assert.equal(c.result_hash,hash({input_context_hash:H,proposal:f.context.proposal,contract:'workspace-chapter-baseline-1'}));
    assert.deepEqual(Object.keys(c).sort(),['input_context_hash','result_hash','validation_contract']);assert.equal(f.time.size(),0);}
});
test('existing runtime token and attempt policy passes through without artificial 1/1 substitution',async()=>{
  for(const [output,attempts] of [[128,1],[30000,2],[65536,2]]){
    const f=fixture();f.request.max_output_tokens=output;f.request.max_attempts=attempts;
    assert.equal(await f.run(),'chapter_validated');
    assert.equal(f.execution.item.max_output_tokens,0);assert.equal(f.execution.item.max_provider_attempts,0);
  }
});
test('retrieval usage settles actual observations; missing usage remains held with valid content',async()=>{
  const billed=fixture();billed.response.usage_source='provider';billed.response.usage={inputTokens:10,outputTokens:0,embeddingTokens:3,totalTokens:13};
  assert.equal(await billed.run(),'chapter_validated');assert.deepEqual((billed.completions[1] as {usage:unknown}).usage,billed.response.usage);
  const held=fixture();held.response.usage_complete=false;held.response.usage_source='mixed_or_unavailable';
  assert.equal(await held.run(),'chapter_validated');assert.equal((held.completions[1] as {usage_complete:boolean}).usage_complete,false);
});
test('Python changed unit content fails actual acceptance and preserves original CMS baseline',async()=>{
  const f=fixture(),before=hash(f.context.proposal);f.response.proposal.chapters[0].lessons[0].units[0].title='Unapproved change';
  assert.equal(await f.run(),'needs_action');assert.equal(f.completions.length,0);assert.equal(hash(f.context.proposal),before);
  assert.ok(f.events.some(e=>e.internal_failure_code==='WORKSPACE_CHAPTER_RESPONSE_CHANGED'));assert.equal((f.failures[1] as {usage_complete:boolean}).usage_complete,true);
});
test('real Node chapter gates run before dispatch, not a callback that can fabricate acceptance',async()=>{
  const f=fixture();f.component.metadata.covered_source_fact_ids=[];
  assert.equal(await f.run(),'needs_action');assert.deepEqual(f.calls,['prepare','fail_commit']);
});
test('identity/context/action/unit-projection drift cannot dispatch validation',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.request.correlation_id=id(99);},(f:ReturnType<typeof fixture>)=>{f.request.locale='vi';},
    (f:ReturnType<typeof fixture>)=>{f.context.input_context_hash='b'.repeat(64);},(f:ReturnType<typeof fixture>)=>{f.context.targetNodes[0].id=id(99);},
    (f:ReturnType<typeof fixture>)=>{if(f.request.checkpoint_action==='validate_chapter')f.request.checkpoint_units[0].unit.title='wrong';},
    (f:ReturnType<typeof fixture>)=>{Object.assign(f.request,{checkpoint_action:'generate_unit',checkpoint_unit_index:0,checkpoint_units:undefined});}]){
    const f=fixture();change(f);assert.equal(await f.run(),'needs_action');assert.ok(!f.calls.includes('dispatch_commit'));}
});
test('generation work, already dispatched work and positive reserved generation limits fail without side effects',async()=>{
  for(const patch of [{kind:'generate_unit' as const},{dispatched:true},{max_output_tokens:1},{max_provider_attempts:1}]){
    const f=fixture();f.execution.item={...f.execution.item,...patch};await assert.rejects(f.run,/WORKSPACE_CHAPTER_RUN_INVALID/);assert.equal(f.calls.length,0);assert.equal(f.time.size(),0);}
});
test('dispatch transaction not raced against timeout; no Python before confirmed commit',async()=>{
  const f=fixture(),d=deferred<WorkspaceWorkItemReceipt>();f.deps.markDispatched=()=>{f.calls.push('dispatch_pending');return d.promise;};
  const run=f.run();await until(()=>f.calls.includes('dispatch_pending'));f.time.advance(480000);await Promise.resolve();assert.equal(f.failures.length,0);
  d.resolve(f.receipt);assert.equal(await run,'needs_action');assert.ok(!f.calls.includes('validate'));assert.equal((f.failures[0] as {outcome:string}).outcome,'uncertain');
});
test('ambiguous dispatch never validates or terminalizes',async()=>{
  const f=fixture();f.deps.markDispatched=async()=>{throw new Error('lost commit');};assert.equal(await f.run(),'reconciliation_required');
  assert.equal(f.failures.length,0);assert.equal(f.completions.length,0);assert.ok(!f.calls.includes('validate'));
});
test('single timed-out validation holds unknown retrieval usage; late response ignored, no retry',async()=>{
  const f=fixture(),d=deferred<unknown>();let count=0;f.deps.validate=()=>{count++;return d.promise;};
  const run=f.run();await until(()=>count===1);f.time.advance(480000);assert.equal(await run,'needs_action');
  assert.equal((f.failures[0] as {outcome:string}).outcome,'uncertain');assert.equal((f.failures[1] as {usage_complete:boolean}).usage_complete,false);
  d.resolve(f.response);await Promise.resolve();assert.equal(count,1);assert.equal(f.completions.length,0);assert.equal(f.time.size(),0);
});
test('existing 480s workflow and heartbeat permit slow validation beyond 60s',async()=>{
  const f=fixture(),d=deferred<unknown>();let waiting=false;f.deps.validate=()=>{waiting=true;return d.promise;};
  const run=f.run();await until(()=>waiting);f.time.advance(90000);await until(()=>f.calls.includes('renew'));d.resolve(f.response);assert.equal(await run,'chapter_validated');
});
test('heartbeat lost lease suppresses completion and terminal writes',async()=>{
  const f=fixture(),d=deferred<unknown>();let waiting=false;f.deps.validate=()=>{waiting=true;return d.promise;};f.deps.renew=async()=>{throw new Error('revoked');};
  const run=f.run();await until(()=>waiting);f.time.advance(15000);assert.equal(await run,'reconciliation_required');d.resolve(f.response);
  assert.equal(f.completions.length,0);assert.equal(f.failures.length,0);
});
test('shutdown before start/in flight never releases reservation',async()=>{
  const before=fixture(),s=new AbortController();s.abort();assert.equal(await before.run(s.signal),'reconciliation_required');assert.equal(before.calls.length,0);
  const f=fixture(),stop=new AbortController(),d=deferred<unknown>();let waiting=false;f.deps.validate=()=>{waiting=true;return d.promise;};
  const run=f.run(stop.signal);await until(()=>waiting);stop.abort();assert.equal(await run,'reconciliation_required');assert.equal(f.failures.length,0);d.resolve(f.response);
});
test('confirmed completion remains success through shutdown; ambiguous commit is never overwritten',async()=>{
  const f=fixture(),d=deferred<WorkspaceWorkItemReceipt>(),stop=new AbortController();let result='';
  f.deps.completeValidation=(_,c)=>{result=c.result_hash;return d.promise;};const run=f.run(stop.signal);await until(()=>!!result);stop.abort();
  d.resolve({...f.receipt,status:'succeeded',accounting_state:'settled',result_hash:result});assert.equal(await run,'chapter_validated');assert.equal(f.failures.length,0);
  const lost=fixture();lost.deps.completeValidation=async()=>{throw new Error('lost commit');};assert.equal(await lost.run(),'reconciliation_required');
  assert.equal(lost.failures.length,0);assert.equal(lost.calls.filter(c=>c==='validate').length,1);
});
test('exact completion hash and pending hold required in receipt',async()=>{
  const wrong=fixture();wrong.deps.completeValidation=async()=>({...wrong.receipt,status:'succeeded',accounting_state:'settled',result_hash:H});
  assert.equal(await wrong.run(),'reconciliation_required');assert.equal(wrong.failures.length,0);
  const held=fixture();held.response.usage_complete=false;held.response.usage_source='mixed_or_unavailable';
  held.deps.completeValidation=async(_,c)=>({...held.receipt,status:'succeeded',accounting_state:'settled',result_hash:c.result_hash});
  assert.equal(await held.run(),'reconciliation_required');assert.equal(held.failures.length,0);
});
test('unexpected generation usage cannot complete, but actual provider usage remains available for accounting',async()=>{
  const f=fixture();f.response.usage_source='provider';f.response.usage={inputTokens:2,outputTokens:5,embeddingTokens:0,totalTokens:7};
  assert.equal(await f.run(),'needs_action');assert.equal(f.completions.length,0);assert.equal((f.failures[1] as {usage:{outputTokens:number}}).usage.outputTokens,5);
  assert.ok(f.events.some(e=>e.internal_failure_code==='WORKSPACE_CHAPTER_UNEXPECTED_GENERATION_USAGE'));
});
test('diagnostics content-free and root-correlated; reporting cannot change outcome',async()=>{
  const f=fixture();assert.equal(await f.run(),'chapter_validated');assert.ok(f.events.every(e=>e.correlation_id===id(9)));
  assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_|Synthetic explanation|The concept describes|CMS baseline/);
  const broken=fixture();broken.deps.report=()=>{throw new Error('offline');};assert.equal(await broken.run(),'chapter_validated');
});
test('module has no DB/provider imports, baseline publication or Apply path; acceptance is concrete',()=>{
  const source=readFileSync(new URL('./lesson-author-workspace-chapter-runner.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/from ['"].*(?:config\/|database\/|gemini|chat\.service|ai-rag-client\.service)/);
  assert.doesNotMatch(source,/deps\.publish|INSERT INTO|UPDATE lesson_author|normalizeProposal/);
  assert.match(source,/acceptWorkspaceChapterValidation\(prepared.context,request,raw\)/);
});
