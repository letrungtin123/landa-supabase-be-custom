import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import { runWorkspaceUnit, type WorkspaceUnitClock, type WorkspaceUnitExecution,
  type WorkspaceUnitRunnerDependencies } from './lesson-author-workspace-unit-runner.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { projectBlueprintDraftArchitecture } from './lesson-author-blueprint-draft-architecture.logic.js';
import { componentPlanId } from './lesson-author-capabilities.logic.js';
import type { WorkspaceGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { WorkspaceWorkItemReceipt } from './lesson-author-workspace-work-item.repository.js';
import type { RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const H='a'.repeat(64);
function deferred<T>() { let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}; }
async function until(predicate:()=>boolean) {
  for(let i=0;i<100;i++) { if(predicate())return;await Promise.resolve(); }
  assert.fail('expected asynchronous boundary was not reached');
}
function timers() {
  let now=Date.parse('2026-09-29T12:00:00Z');
  const tasks=new Set<{at:number;repeat:number;run:()=>void}>();
  const schedule=(run:()=>void,ms:number,repeat:number)=>{
    const task={at:now+ms,repeat,run};tasks.add(task);return()=>{tasks.delete(task);};
  };
  const clock:WorkspaceUnitClock={now:()=>now,timeout:(fn,ms)=>schedule(fn,ms,0),interval:(fn,ms)=>schedule(fn,ms,ms)};
  return{clock,advance(ms:number){now+=ms;for(const t of [...tasks])if(t.at<=now){if(t.repeat)t.at=now+t.repeat;else tasks.delete(t);t.run();}},size:()=>tasks.size};
}
function fixture(locale:'en'|'vi'='en') {
  const time=timers(),blueprint=workspaceInventoryFixture(2,locale),allowed=new Set<CourseComponentType>(['html']);
  blueprint.chapters[0].lessons[0].units.forEach((u,i)=>{
    u.component_plan[0].component_plan_id=componentPlanId(`chapter_1.lesson_1.unit_${i+1}`,'html',[`block_${i+1}`]);
  });
  const inventory=buildWorkspaceInventory(blueprint,allowed),unitPath='chapter_1.lesson_1.unit_1';
  const nodes=inventory.nodes.filter(n=>n.canonical_path===unitPath||n.kind==='component'&&n.parent_path===unitPath)
    .map((n,i)=>({id:id(20+i),path:n.canonical_path,contract_hash:n.contract_hash}));
  const context:WorkspaceGenerationContext={blueprint,unitPath,previous:new Map(),allowed,input_context_hash:H,
    source_snapshot_hash:H,correlation_id:id(9),targetNodes:nodes};
  const execution:WorkspaceUnitExecution={deadline_at:new Date(time.clock.now()+600_000),item:{
    target:{tenantId:id(1),userId:id(2),workspaceId:id(3),conversationId:id(4),courseId:'course-v1:TEST+WS+2026',workItemId:id(5),leaseToken:id(6)},
    node_id:nodes[0].id,kind:'generate_unit',ordinal:0,source_snapshot_hash:H,runtime_config_hash:H,inventory_hash:H,manifest_hash:H,
    contract_hash:nodes[0].contract_hash,input_context_hash:H,ai_reservation_id:id(7),reserved_tokens:100_000,
    max_output_tokens:30_000,max_provider_attempts:2,correlation_id:id(9),content_locale:locale,dispatched:false,
  }};
  const request:RagChapterCheckpointRequest={tenant_id:id(1),conversation_id:id(4),kb_id:id(8),correlation_id:id(9),
    target:'lesson_author',model:'unchanged-model',max_output_tokens:30_000,max_attempts:2,
    embedding_model:'unchanged-embedding',embedding_dimensions:768,system_prompt:'PRIVATE_PROMPT_SENTINEL',user_message:'PRIVATE_SOURCE_SENTINEL',
    history:[],source_documents:[{document_id:id(10),kb_id:id(8),name:'synthetic.pdf',type:'pdf',status:'ready'}],
    outline_context:'',target_scope_instruction:'',output_schema_hint:'',operation:'create',target_type:'chapter',generation_mode:'staged',locale,
    blueprint_architecture:structuredClone(projectBlueprintDraftArchitecture(blueprint,0)),
    checkpoint_version:1,checkpoint_action:'generate_unit',checkpoint_unit_index:0,remaining_workflow_budget_ms:480_000};
  const component={type:'html',title:'Synthetic explanation',data:'<p>The concept describes the relationship between the stated information and its intended meaning. Read the definition carefully, identify its distinguishing characteristics, and compare those characteristics with the explanation provided here. For example, an observation records what is visible, whereas an interpretation explains the significance of that observation. Keep these categories separate when discussing the concept. Explain each distinction in your own words and review the original definition before proceeding to the next topic.</p>',
    metadata:{component_plan_id:blueprint.chapters[0].lessons[0].units[0].component_plan[0].component_plan_id,source_fact_ids:['fact_1'],covered_source_fact_ids:['fact_1'],supporting_evidence_fact_ids:[],learning_objective_refs:['lo_1']}};
  const response={checkpoint_version:1,correlation_id:id(9),status:'unit_ready',unit_index:0,unit_path:unitPath,
    unit:{title:blueprint.chapters[0].lessons[0].units[0].title,source_fact_ids:['fact_1'],components:[component]},retrieval:{},
    usage_complete:true,usage_source:'provider',usage:{inputTokens:10,outputTokens:20,embeddingTokens:0,totalTokens:30}};
  const receipt:WorkspaceWorkItemReceipt={workspace_id:id(3),work_item_id:id(5),node_id:nodes[0].id,status:'running',
    accounting_state:'reserved',result_hash:null,replayed:false};
  const calls:string[]=[],events:Record<string,unknown>[]=[],publications:unknown[]=[],failures:unknown[]=[];
  const deps:WorkspaceUnitRunnerDependencies={clock:time.clock,
    // Most fault-injection cases start with synthetic already-normalized CMS data.
    // The wire-format test below uses the real existing service normalizer.
    normalizeProposal:raw=>raw as LessonAuthorProposal,
    prepare:async()=>{calls.push('prepare');return{context,request};},
    markDispatched:async()=>{calls.push('dispatch_commit');return{...receipt};},
    renew:async()=>{calls.push('renew');return{...receipt};},
    generate:async(r,o)=>{calls.push('generate');assert.equal(r.max_output_tokens,30_000);assert.equal(r.max_attempts,2);
      assert.equal(r.correlation_id,id(9));assert.equal(r.remaining_workflow_budget_ms,o.timeoutMs);return structuredClone(response);},
    publish:async(_,p,u)=>{calls.push('publish_commit');publications.push(p,u);return{...receipt,status:'succeeded',accounting_state:u.usage_complete?'settled':'pending_reconciliation',result_hash:p.result_hash,unit_ready_sequence:7};},
    fail:async(_,f,u)=>{calls.push('fail_commit');failures.push(f,u);return{...receipt,status:'failed',accounting_state:'pending_reconciliation'};},
    report:e=>{events.push(e);},
  };
  return{time,execution,context,request,component,response,receipt,calls,events,publications,failures,deps,run:(signal?:AbortSignal)=>runWorkspaceUnit(execution,deps,signal)};
}

test('EN/VI real Python envelope → real Node coverage/pedagogy → baseline publication; no Apply',async()=>{
  for(const locale of ['vi','en'] as const){
    const f=fixture(locale);assert.equal(await f.run(),'unit_ready');
    assert.deepEqual(f.calls,['prepare','dispatch_commit','generate','publish_commit']);
    const p=f.publications[0] as {baselines:unknown[]};assert.equal(p.baselines.length,2);
    assert.equal(f.events.at(-1)!.apply_ready,false);assert.equal(f.events.at(-1)!.chapter_scope_complete,false);
    assert.equal(f.time.size(),0);
  }
});
test('incomplete observed usage preserves valid content but remains pending reconciliation',async()=>{
  const f=fixture();f.response.usage_complete=false;f.response.usage_source='mixed_or_unavailable';
  assert.equal(await f.run(),'unit_ready');assert.equal((f.publications[1] as {usage_complete:boolean}).usage_complete,false);
});
test('lost generated fact coverage cannot be manufactured by plan hydration',async()=>{
  const f=fixture();f.component.metadata.covered_source_fact_ids=[];
  assert.equal(await f.run(),'needs_action');assert.equal(f.publications.length,0);
  assert.equal((f.failures[0] as {outcome:string}).outcome,'known_failure');
  assert.equal((f.failures[1] as {usage_complete:boolean}).usage_complete,true);
  assert.ok(f.events.some(e=>e.internal_failure_code==='WORKSPACE_BASELINE_VALIDATION_FAILED'));
});
test('correlation/topology/identity/locale/budget drift fails before any provider invocation',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.request.correlation_id=id(99);},
    (f:ReturnType<typeof fixture>)=>{f.request.locale='vi';},
    (f:ReturnType<typeof fixture>)=>{f.request.max_output_tokens=60_000;},
    (f:ReturnType<typeof fixture>)=>{f.request.max_attempts=1;},
    (f:ReturnType<typeof fixture>)=>{f.context.input_context_hash='b'.repeat(64);},
    (f:ReturnType<typeof fixture>)=>{f.request.checkpoint_unit_index=1;},
    (f:ReturnType<typeof fixture>)=>{f.request.blueprint_architecture!.lessons[0].units[0].component_plan=[];}]){
    const f=fixture();change(f);assert.equal(await f.run(),'needs_action');assert.ok(!f.calls.includes('generate'));
  }
});
test('dispatch transaction must definitively commit before Python; no race against cancellation',async()=>{
  const f=fixture(),dispatch=deferred<WorkspaceWorkItemReceipt>();
  f.deps.markDispatched=()=>{f.calls.push('dispatch_pending');return dispatch.promise;};
  const run=f.run();await until(()=>f.calls.includes('dispatch_pending'));f.time.advance(480_000);
  await Promise.resolve();assert.ok(!f.calls.includes('fail_commit'));assert.ok(!f.calls.includes('generate'));
  dispatch.resolve(f.receipt);assert.equal(await run,'needs_action');assert.ok(!f.calls.includes('generate'));
  assert.equal((f.failures[0] as {outcome:string}).outcome,'uncertain');
});
test('ambiguous dispatch commit never dispatches, releases or attempts terminal mutation',async()=>{
  const f=fixture();f.deps.markDispatched=async()=>{throw new Error('private connection detail');};
  assert.equal(await f.run(),'reconciliation_required');assert.equal(f.failures.length,0);assert.ok(!f.calls.includes('generate'));
});
test('timeout: one invocation, hold unknown outcome, ignore late success and clean timers',async()=>{
  const f=fixture(),provider=deferred<unknown>();let count=0;
  f.deps.generate=async()=>{count++;return provider.promise;};
  const run=f.run();await until(()=>count===1);f.time.advance(480_000);
  assert.equal(await run,'needs_action');assert.equal((f.failures[0] as {outcome:string}).outcome,'uncertain');
  assert.equal((f.failures[1] as {usage_source:string}).usage_source,'unavailable');
  provider.resolve(f.response);await Promise.resolve();assert.equal(f.publications.length,0);assert.equal(count,1);assert.equal(f.time.size(),0);
});
test('slow valid content within existing 480s workflow does not inherit a 60s runner timeout',async()=>{
  const f=fixture(),provider=deferred<unknown>();let started=false;
  f.deps.generate=async()=>{started=true;return provider.promise;};
  const run=f.run();await until(()=>started);f.time.advance(90_000);await until(()=>f.calls.includes('renew'));
  provider.resolve(f.response);assert.equal(await run,'unit_ready');
});
test('lease renewal failure suppresses late publication and leaves recovery to fenced repository',async()=>{
  const f=fixture(),provider=deferred<unknown>();let started=false;
  f.deps.generate=async()=>{started=true;return provider.promise;};f.deps.renew=async()=>{throw new Error('revoked');};
  const run=f.run();await until(()=>started);f.time.advance(15_000);
  assert.equal(await run,'reconciliation_required');provider.resolve(f.response);await Promise.resolve();
  assert.equal(f.publications.length,0);assert.equal(f.failures.length,0);
});
test('shutdown before start causes no call; shutdown in flight does not release reserved usage',async()=>{
  const before=fixture(),stop=new AbortController();stop.abort();assert.equal(await before.run(stop.signal),'reconciliation_required');assert.equal(before.calls.length,0);
  const f=fixture(),shutdown=new AbortController(),provider=deferred<unknown>();let started=false;
  f.deps.generate=async()=>{started=true;return provider.promise;};const run=f.run(shutdown.signal);await until(()=>started);shutdown.abort();
  assert.equal(await run,'reconciliation_required');assert.equal(f.failures.length,0);provider.resolve(f.response);
});
test('publication commit is not raced: a confirmed result remains success even after shutdown',async()=>{
  const f=fixture(),publication=deferred<WorkspaceWorkItemReceipt>(),shutdown=new AbortController();let resultHash='';
  f.deps.publish=async(_,p)=>{resultHash=p.result_hash;return publication.promise;};
  const run=f.run(shutdown.signal);await until(()=>!!resultHash);shutdown.abort();
  publication.resolve({...f.receipt,status:'succeeded',accounting_state:'settled',result_hash:resultHash,unit_ready_sequence:7});
  assert.equal(await run,'unit_ready');assert.equal(f.failures.length,0);
});
test('unknown publication outcome must not be overwritten by a failure write or provider replay',async()=>{
  const f=fixture();f.deps.publish=async()=>{throw new Error('commit connection lost');};
  assert.equal(await f.run(),'reconciliation_required');assert.equal(f.calls.filter(c=>c==='generate').length,1);assert.equal(f.failures.length,0);
});
test('invalid publication receipt is not success and cannot authorize a retry',async()=>{
  const f=fixture();f.deps.publish=async()=>({...f.receipt,status:'succeeded',result_hash:H,unit_ready_sequence:7});
  assert.equal(await f.run(),'reconciliation_required');assert.equal(f.failures.length,0);
});
test('invalid or already-dispatched admission fails without side effects',async()=>{
  const f=fixture();f.execution.item={...f.execution.item,dispatched:true};
  await assert.rejects(f.run,/WORKSPACE_UNIT_RUN_INVALID/);assert.equal(f.calls.length,0);assert.equal(f.time.size(),0);
});
test('invalid response/usage cannot claim provider usage or bypass Node validation',async()=>{
  const f=fixture();f.response.usage_source='local_estimate';
  assert.equal(await f.run(),'needs_action');assert.equal(f.publications.length,0);
  assert.equal((f.failures[1] as {usage_source:string}).usage_source,'unavailable');
});
test('diagnostics are safe metadata only; logging failure cannot change a committed outcome',async()=>{
  const f=fixture();assert.equal(await f.run(),'unit_ready');
  assert.ok(f.events.every(e=>e.correlation_id===id(9)));
  assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_|The concept describes|Synthetic explanation/);
  const telemetry=f.events.find(e=>e.event==='workspace_unit_python_accepted')!;
  assert.equal(telemetry.provider_finish_reason,null);assert.equal(telemetry.provider_finish_reason_available,false);
  const broken=fixture();broken.deps.report=()=>{throw new Error('logging offline');};assert.equal(await broken.run(),'unit_ready');
});

test('actual legacy normalizer converts Python html/provenance wire fields before workspace validation',async t=>{
  t.mock.method(pg.Pool.prototype,'query',()=>{throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN');});
  t.mock.method(pg.Pool.prototype,'connect',()=>{throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN');});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('TEST_HTTP_ACCESS_FORBIDDEN');});
  const nativeInterval=globalThis.setInterval;
  t.mock.method(globalThis,'setInterval',(...args:Parameters<typeof setInterval>)=>{
    const timer=nativeInterval(...args);timer.unref();t.after(()=>clearInterval(timer));return timer;
  });
  const {normalizeLessonAuthorProposal,blueprintDraftArchitecture}=await import('./chat.service.js');
  for(const locale of ['en','vi'] as const){
    const f=fixture(locale);f.deps.normalizeProposal=normalizeLessonAuthorProposal;
    const wire={...f.response,unit:{...f.response.unit,components:[{type:'html',title:f.component.title,
      html:f.component.data,...f.component.metadata}]}};
    // Fail outside the runner if the synthetic wire fixture itself is invalid.
    normalizeLessonAuthorProposal({chapters:[{title:'Chapter',lessons:[{title:'Lesson',units:[wire.unit]}]}]});
    f.deps.generate=async()=>wire;
    assert.equal(await f.run(),'unit_ready',JSON.stringify(f.events.filter(e=>e.event==='workspace_unit_failed')));
    // Shared helper preserves legacy serializer output including all defaults.
    assert.deepEqual(f.request.blueprint_architecture,blueprintDraftArchitecture({blueprint:f.context.blueprint,chapterIndex:0} as Parameters<typeof blueprintDraftArchitecture>[0]));
  }
});

test('normalization cannot silently drop components and still publish a ready node',async()=>{
  const f=fixture();f.deps.normalizeProposal=raw=>{
    const p=structuredClone(raw) as LessonAuthorProposal;p.chapters[0].lessons[0].units[0].components=[];return p;
  };
  assert.equal(await f.run(),'needs_action');assert.equal(f.publications.length,0);
});

test('server objective binding cannot overwrite contradictory generated objective refs or fact ownership',async()=>{
  const objectives=fixture();objectives.component.metadata.learning_objective_refs=['lo_99'];
  assert.equal(await objectives.run(),'needs_action');assert.ok(objectives.events.some(e=>e.internal_failure_code==='WORKSPACE_UNIT_OBJECTIVE_CONFLICT'));
  const facts=fixture();facts.response.unit.source_fact_ids=['fact_999'];
  assert.equal(await facts.run(),'needs_action');assert.equal(facts.publications.length,0);
});
