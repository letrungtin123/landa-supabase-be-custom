import assert from 'node:assert/strict';
import test from 'node:test';
import { runChapterCheckpoint, ChapterWorkflowTimeout, chapterExternalFailureCode, chapterFailureMessage, type ChapterRunDependencies, type ChapterUsageLedger } from './lesson-author-chapter-runner.logic.js';
import { ChapterCheckpointError, type ChapterDraftRow, type ChapterAttemptRow, type ChapterUnitRow } from './lesson-author-chapter-checkpoint.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { RagChapterFinalResponse, RagChapterUnitResponse } from './lesson-author-chapter-rag-contract.logic.js';

const start=Date.UTC(2026,8,26);
test('provider rejection is not reclassified as a lesson quality failure; safe VI/EN copy', () => {
  assert.equal(chapterExternalFailureCode('PROVIDER_ERROR',false),'PROVIDER_ERROR');
  assert.equal(chapterExternalFailureCode(undefined,true),'PROVIDER_ERROR');
  for (const code of [undefined,'LESSON_VALIDATION_FAILED','PRIVATE_PROVIDER_TEXT',{}]) {
    assert.equal(chapterExternalFailureCode(code,false),'LESSON_VALIDATION_FAILED');
  }
  assert.match(chapterFailureMessage('en',false,'PROVIDER_ERROR'),/AI service/);
  assert.match(chapterFailureMessage('vi',false,'PROVIDER_ERROR'),/Dịch vụ AI/);
  assert.doesNotMatch(chapterFailureMessage('en',false,'PROVIDER_ERROR'),/did not pass validation|continue/);
  assert.match(chapterFailureMessage('en',false,'LESSON_VALIDATION_FAILED'),/did not pass validation/);
  assert.match(chapterFailureMessage('vi',true,'PROVIDER_ERROR'),/có thể tiếp tục/);
});
const snapshot={request_hash:hash('request'),blueprint_hash:hash('blueprint'),source_snapshot_hash:hash('source'),course_outline_hash:hash('outline'),runtime_config_hash:hash('runtime')};
const draft:ChapterDraftRow={...snapshot,id:'draft',tenant_id:'tenant',course_id:'course',conversation_id:'conversation',requested_by:'user',
  blueprint_id:'blueprint',chapter_index:2,contract_version:1,total_units:5,status:'open',result_job_id:null,expires_at:new Date(start+604800000),
  unit_contracts:Array.from({length:5},(_,index)=>({index,lesson_index:0,unit_index:index,contract_hash:hash(index),evidence_hash:hash(['fact',index])}))};
const attempt:ChapterAttemptRow={id:'attempt',draft_id:'draft',tenant_id:'tenant',course_id:'course',correlation_id:'same-correlation',
  lease_token:'lease',lease_expires_at:new Date(start+45000),deadline_at:new Date(start+600000),status:'running',dispatch_started_at:null,
  in_flight_unit_index:null,accounting_state:'reserved',external_failure_code:null};
const usage={inputTokens:10,outputTokens:20,embeddingTokens:0,totalTokens:30};
function unit(index:number):ChapterUnitRow {
  const payload={title:`Unit ${index}`,source_fact_ids:[`fact-${index}`],components:[{type:'html',html:`<p>Fixture ${index}</p>`}]};
  return {draft_id:draft.id,tenant_id:draft.tenant_id,course_id:draft.course_id,unit_index:index,attempt_id:'previous',
    contract_hash:draft.unit_contracts[index].contract_hash,evidence_hash:draft.unit_contracts[index].evidence_hash,
    validation_contract:'fixture-1',payload,payload_hash:hash(payload)};
}
function fixture(overrides:Partial<ChapterRunDependencies>={}) {
  const events:string[]=[]; const logs:Record<string,unknown>[]=[]; const units:ChapterUnitRow[]=[];
  let accounting:ChapterUsageLedger|undefined;let time=start;
  const deps:ChapterRunDependencies={
    now:()=>time,revalidate:async()=>{events.push('revalidate');},renew:async()=>{},
    validateUnit:async(_payload,i)=>{events.push(`accept:${i}`);},
    markDispatched:async i=>{events.push(`mark:${i}`);},markFinalValidation:async()=>{events.push('mark:final');},
    generate:async i=>{events.push(`generate:${i}`);return {checkpoint_version:1,correlation_id:attempt.correlation_id,status:'unit_ready',
      unit_index:i,unit_path:`chapter_1.lesson_1.unit_${i+1}`,unit:unit(i).payload,usage,usage_complete:true,usage_source:'provider',retrieval:{}} as RagChapterUnitResponse;},
    commit:async i=>{events.push(`commit:${i}`);units.push(unit(i));},
    validateChapter:async completed=>{assert.deepEqual(completed.map(u=>u.unit_index),[0,1,2,3,4]);events.push('final-validation');
      return {status:'ready',usage:{inputTokens:0,outputTokens:0,embeddingTokens:0,totalTokens:0},usage_complete:true,usage_source:'no_generation'} as RagChapterFinalResponse;},
    publish:async(_result,ledger)=>{events.push('publish');accounting={...ledger};},
    interrupt:async(_failure,timeout,ledger)=>{events.push(timeout?'timeout':'failed');accounting={...ledger};},
    classify:error=>({stage:'test',internalCode:error instanceof ChapterCheckpointError?error.code:'TEST_FAILURE',externalCode:'PROVIDER_ERROR',
      timeout:error instanceof ChapterWorkflowTimeout,leaseLost:error instanceof ChapterCheckpointError && error.code==='CHAPTER_CHECKPOINT_LEASE_LOST'}),
    report:event=>logs.push(event),...overrides,
  };
  return {deps,events,logs,units,accounting:()=>accounting,advance:(ms:number)=>{time+=ms;}};
}
test('5-unit attempt: unit4 timeout retains committed1-3; explicit attempt only generates4-5 and publishes after full validation',async()=>{
  const f=fixture();const generate=f.deps.generate;
  f.deps.generate=async(i,s,b)=>{if(i===3){f.events.push('generate:3');throw new ChapterWorkflowTimeout();}return generate(i,s,b);};
  assert.equal(await runChapterCheckpoint(draft,attempt,[],f.deps),'interrupted');
  assert.deepEqual(f.units.map(u=>u.unit_index),[0,1,2]);
  assert.deepEqual(f.events.filter(e=>e.startsWith('generate:')),['generate:0','generate:1','generate:2','generate:3']);
  assert.equal(f.accounting()?.complete,false);assert.equal(f.events.includes('publish'),false);
  const next=fixture();
  assert.equal(await runChapterCheckpoint(draft,{...attempt,id:'new-attempt',correlation_id:'new-correlation'},f.units,next.deps),'ready');
  assert.deepEqual(next.events.filter(e=>e.startsWith('generate:')),['generate:3','generate:4']);
  assert.deepEqual(next.events.filter(e=>e.startsWith('commit:')),['commit:3','commit:4']);
  assert.ok(next.events.indexOf('final-validation')<next.events.indexOf('publish'));
  assert.equal(next.accounting()?.totalTokens,60,'completed units not charged to new attempt');
});
test('each paid dispatch follows committed marker and each next unit follows committed checkpoint',async()=>{
  const f=fixture();await runChapterCheckpoint(draft,attempt,[],f.deps);
  for(let i=0;i<5;i++){
    assert.ok(f.events.indexOf(`mark:${i}`)<f.events.indexOf(`generate:${i}`));
    assert.ok(f.events.indexOf(`accept:${i}`)<f.events.indexOf(`commit:${i}`));
    if(i<4)assert.ok(f.events.indexOf(`commit:${i}`)<f.events.indexOf(`mark:${i+1}`));
  }
});
test('total deadline does not reset after every successful unit',async()=>{
  const f=fixture();const generate=f.deps.generate;const budgets:number[]=[];
  f.deps.generate=async(i,s,b)=>{budgets.push(b);const r=await generate(i,s,b);f.advance(170000);return r;};
  assert.equal(await runChapterCheckpoint(draft,attempt,[],f.deps),'interrupted');
  assert.deepEqual(budgets,[480000,310000,140000]);
  assert.equal(f.events.includes('generate:3'),false);assert.equal(f.events.includes('publish'),false);
});
test('snapshot or permission change fails before any dispatch and cached units are revalidated',async()=>{
  const stale=fixture({revalidate:async()=>{throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');}});
  assert.equal(await runChapterCheckpoint(draft,attempt,[unit(0)],stale.deps),'failed');
  assert.ok(!stale.events.some(e=>e.startsWith('generate')));
  const rejected=fixture({validateUnit:async()=>{throw new Error('TENANT_COMPONENT_DISABLED');}});
  assert.equal(await runChapterCheckpoint(draft,attempt,[unit(0)],rejected.deps),'failed');
  assert.ok(!rejected.events.some(e=>e.startsWith('generate')));
});
test('source hash / corrupted persisted payload rejects before reuse',async()=>{
  for(const row of [{...unit(0),evidence_hash:hash('other')},{...unit(0),payload_hash:hash('other')},{...unit(0),tenant_id:'other'}]){
    const f=fixture();assert.equal(await runChapterCheckpoint(draft,attempt,[row],f.deps),'failed');
    assert.equal(f.events.includes('revalidate'),false);
  }
});
test('unit acceptance failure cannot commit or continue',async()=>{
  const f=fixture({validateUnit:async()=>{throw new Error('SOURCE_MISMATCH');}});
  assert.equal(await runChapterCheckpoint(draft,attempt,[],f.deps),'failed');
  assert.equal(f.units.length,0);assert.equal(f.events.includes('generate:1'),false);
});
test('commit failure cannot dispatch next unit or publish',async()=>{
  const f=fixture({commit:async()=>{throw new Error('COMMIT_FAILURE');}});
  assert.equal(await runChapterCheckpoint(draft,attempt,[],f.deps),'failed');
  assert.equal(f.events.includes('generate:1'),false);assert.equal(f.events.includes('publish'),false);
});
test('all cached units go through marked final validation without regeneration',async()=>{
  const f=fixture();assert.equal(await runChapterCheckpoint(draft,attempt,[0,1,2,3,4].map(unit),f.deps),'ready');
  assert.ok(!f.events.some(e=>e.startsWith('generate:')));assert.ok(f.events.includes('mark:final'));
  assert.equal(f.accounting()?.dispatched,true);
});
test('final quality failure produces no proposal; timeout at final preserves all checkpoints',async()=>{
  for(const error of [new Error('PEDAGOGICAL_FAILURE'),new ChapterWorkflowTimeout()]){
    const f=fixture({validateChapter:async()=>{throw error;}});
    assert.equal(await runChapterCheckpoint(draft,attempt,[0,1,2,3,4].map(unit),f.deps),error instanceof ChapterWorkflowTimeout?'interrupted':'failed');
    assert.equal(f.events.includes('publish'),false);assert.equal(f.accounting()?.complete,false);
  }
});
test('publication failure is terminal, not a ready response',async()=>{
  const f=fixture({publish:async()=>{throw new Error('TRANSACTION_ROLLBACK');}});
  assert.equal(await runChapterCheckpoint(draft,attempt,[0,1,2,3,4].map(unit),f.deps),'failed');
  assert.ok(!f.logs.some(e=>e.event==='chapter_checkpoint_ready'));
});
test('mixed/partial usage retains uncertainty through successful content completion',async()=>{
  const f=fixture();const generate=f.deps.generate;
  f.deps.generate=async(i,s,b)=>({...await generate(i,s,b),usage_complete:false,usage_source:'mixed_or_unavailable'});
  assert.equal(await runChapterCheckpoint(draft,attempt,[],f.deps),'ready');assert.equal(f.accounting()?.complete,false);
});
test('heartbeat lease loss fences late provider result, no terminal overwrite or automatic replay',async()=>{
  let resolve!:(value:RagChapterUnitResponse)=>void;
  const f=fixture({heartbeatMs:2,renew:async()=>{throw new Error('LEASE_LOST');},generate:()=>new Promise(r=>{resolve=r;})});
  assert.equal(await runChapterCheckpoint(draft,attempt,[],f.deps),'interrupted');
  resolve({unit:unit(0).payload} as RagChapterUnitResponse);await new Promise(r=>setTimeout(r,5));
  assert.equal(f.units.length,0);assert.equal(f.events.includes('failed'),false);assert.equal(f.events.includes('publish'),false);
});
test('safe logs correlate a whole attempt without source/payload or lease token',async()=>{
  const f=fixture();await runChapterCheckpoint(draft,attempt,[],f.deps);
  assert.ok(f.logs.every(e=>e.correlation_id==='same-correlation' && e.attempt_id===attempt.id));
  assert.doesNotMatch(JSON.stringify(f.logs),/<p>|Fixture|source_fact_ids|lease_token|prompt/);
});
