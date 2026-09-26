import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runChapterCheckpoint, ChapterWorkflowTimeout, type ChapterRunDependencies } from './lesson-author-chapter-runner.logic.js';
import { readRagChapterCheckpointResponse, type RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { ChapterDraftRow, ChapterAttemptRow, ChapterUnitRow } from './lesson-author-chapter-checkpoint.logic.js';
import { assertLessonAuthorProposalComponentsValid } from './lesson-author-component-registry.logic.js';
import { assertLessonAuthorPedagogicalQuality } from './lesson-author-pedagogical-validator.logic.js';
import { COURSE_COMPONENT_TYPES } from '../tenants/tenant-course-components.constants.js';

test('offline Node→Python unit contract→timeout→explicit resume→Python whole validation→Node acceptance→mock publication',async t=>{
  const pg=await import('pg');
  t.mock.method(pg.default.Pool.prototype,'query',()=>{throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN');});
  t.mock.method(pg.default.Pool.prototype,'connect',()=>{throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN');});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('TEST_HTTP_ACCESS_FORBIDDEN');});
  const nativeInterval=globalThis.setInterval;
  t.mock.method(globalThis,'setInterval',(...args:Parameters<typeof setInterval>)=>{
    const timer=nativeInterval(...args);timer.unref();t.after(()=>clearInterval(timer));return timer;
  });
  const {normalizeLessonAuthorProposal,lockProposalToBlueprintChapter}=await import('./chat.service.js');
  const root=fileURLToPath(new URL('../../../../landa-ai-rag/',import.meta.url));
  const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const call=(input:unknown)=>{
    const out=spawnSync(python,['-X','utf8','-B','-m','tests.chapter_checkpoint_bridge'],{
      cwd:root,input:JSON.stringify(input),encoding:'utf8',timeout:20000,maxBuffer:4000000});
    assert.equal(out.status,0,out.error?.message ?? out.stderr);return JSON.parse(out.stdout);
  };
  const {request:base}=call({action:'fixture'});
  const architecture=base.blueprint_architecture;
  const chapter={title:architecture.chapter_title,objective:'Apply the supplied procedures safely.',lessons:architecture.lessons};
  const context={chapterIndex:0,blueprint:{architecture_contract_version:5,content_contract_version:1,chapters:[chapter]}} as Parameters<typeof lockProposalToBlueprintChapter>[1];
  const contracts=architecture.lessons.flatMap((l:any,li:number)=>l.units.map((u:any,ui:number)=>({
    index:0,lesson_index:li,unit_index:ui,contract_hash:hash(u),evidence_hash:hash(u.source_fact_ids)})))
    .map((u:any,index:number)=>({...u,index}));
  const owner={id:'draft',tenant_id:'tenant',course_id:'course',conversation_id:'conversation',requested_by:'user'};
  const draft:ChapterDraftRow={...owner,request_hash:hash('request'),blueprint_hash:hash(architecture),source_snapshot_hash:hash('source'),
    course_outline_hash:hash('outline'),runtime_config_hash:hash('runtime'),blueprint_id:'blueprint',chapter_index:2,
    contract_version:1,total_units:5,unit_contracts:contracts,status:'open',result_job_id:null,expires_at:new Date(Date.now()+604800000)};
  const attempt:ChapterAttemptRow={id:'first',draft_id:draft.id,tenant_id:draft.tenant_id,course_id:draft.course_id,
    correlation_id:base.correlation_id,lease_token:'lease',lease_expires_at:new Date(Date.now()+45000),deadline_at:new Date(Date.now()+600000),
    status:'running',dispatch_started_at:null,in_flight_unit_index:null,accounting_state:'reserved',external_failure_code:null};
  const saved:ChapterUnitRow[]=[]; const calls:number[]=[];let interrupted=true;let published=false;
  const allowed=new Set(COURSE_COMPONENT_TYPES);
  const deps:ChapterRunDependencies={revalidate:async()=>{},renew:async()=>{},markDispatched:async()=>{},markFinalValidation:async()=>{},
    validateUnit:async(payload,i)=>{
      const c=contracts[i];const lesson=chapter.lessons[c.lesson_index];
      const normalized=normalizeLessonAuthorProposal({chapters:[{title:chapter.title,lessons:[{title:lesson.title,units:[payload]}]}]});
      const mini={...context,blueprint:{...context.blueprint,chapters:[{...chapter,lessons:[{...lesson,units:[lesson.units[c.unit_index]]}]}]}};
      const locked=lockProposalToBlueprintChapter(normalized,mini);
      assertLessonAuthorProposalComponentsValid(locked,allowed);
    },
    generate:async(index,_signal,remaining)=>{
      calls.push(index);if(interrupted && index===3)throw new ChapterWorkflowTimeout();
      const request:RagChapterCheckpointRequest={...base,checkpoint_action:'generate_unit',checkpoint_unit_index:index,
        checkpoint_units:undefined,remaining_workflow_budget_ms:remaining};
      const response=call({action:'execute',request});assert.equal(response.provider_calls,1);
      const validated=readRagChapterCheckpointResponse(response.result,request);
      assert.equal(validated.status,'unit_ready');if(validated.status!=='unit_ready')throw new Error();return validated;
    },
    commit:async(index,payload)=>{saved.push({draft_id:draft.id,tenant_id:draft.tenant_id,course_id:draft.course_id,unit_index:index,
      attempt_id:attempt.id,contract_hash:contracts[index].contract_hash,evidence_hash:contracts[index].evidence_hash,
      payload,payload_hash:hash(payload),validation_contract:'cross-language-1'});},
    validateChapter:async(units,_signal,remaining)=>{
      const request:RagChapterCheckpointRequest={...base,checkpoint_action:'validate_chapter',checkpoint_unit_index:undefined,
        checkpoint_units:units,remaining_workflow_budget_ms:remaining};
      const response=call({action:'execute',request});assert.equal(response.provider_calls,0);
      const validated=readRagChapterCheckpointResponse(response.result,request);
      assert.equal(validated.status,'ready');if(validated.status!=='ready')throw new Error();return validated;
    },
    publish:async response=>{
      const proposal=lockProposalToBlueprintChapter(normalizeLessonAuthorProposal(response.proposal),context);
      assertLessonAuthorProposalComponentsValid(proposal,allowed);
      assertLessonAuthorPedagogicalQuality({proposal,blueprint_chapter:chapter});
      assert.equal(proposal.chapters[0].lessons[0].units.length,5);published=true;
    },interrupt:async(_failure,timeout,ledger)=>{assert.ok(timeout);assert.equal(ledger.complete,false);},
    classify:error=>({stage:'test',internalCode:'TEST',externalCode:'PROVIDER_ERROR',timeout:error instanceof ChapterWorkflowTimeout}),report:()=>{},
  };
  assert.equal(await runChapterCheckpoint(draft,attempt,[],deps),'interrupted');assert.equal(saved.length,3);assert.equal(published,false);
  interrupted=false;
  assert.equal(await runChapterCheckpoint(draft,{...attempt,id:'second',deadline_at:new Date(Date.now()+600000)},saved.slice(),deps),'ready');
  assert.deepEqual(calls,[0,1,2,3,3,4]);assert.equal(saved.length,5);assert.ok(published);
});

test('wiring retains legacy paths, four-step UI, safe metadata and explicit rollout gate',()=>{
  const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
  const chat=read('./chat.service.ts');const api=read('./chat.controller.ts');const runtime=read('./lesson-author-chapter-runtime.service.ts');
  assert.ok(chat.indexOf('await executeChapterCheckpoint(ctx,userId,trimmed,options,blueprintDraftContext')<chat.indexOf('const aiReservation = await reserveTenantAiTokens'));
  assert.match(chat,/outcome==='ready' && finishedProposal && finishedJob/);
  assert.match(chat,/if \(replyCommitted && reply\) onChunk\(reply\)/);
  assert.match(chat,/CHAPTER_RESERVATION_CHANGED/);
  assert.match(chat,/expected_pages:evidence.target_source_scope_expected_pages/);
  assert.match(chat,/usage_source:ledger.complete\?'provider':'mixed_or_unavailable'/);
  assert.match(chat,/historyBoundary=String\(first.user_message_id\)/);
  assert.match(api,/chapterResume:\{draftId:chapter_resume.draft_id,previousAttemptId:chapter_resume.previous_attempt_id\}/);
  assert.doesNotMatch(runtime,/generateRag|generate_content|sendRagChat/);
  assert.match(runtime,/DELETE FROM lesson_author_chapter_drafts/);
  assert.doesNotMatch(runtime,/DELETE FROM lesson_author_chapter_units|UPDATE courses|UPDATE course_blocks/);
});

for (const action of ['instance_repair', 'coverage_repair'] as const)
test(`offline ${action}→scoped repair→Python full validation→Node acceptance`,async t=>{
  const pg=await import('pg');
  t.mock.method(pg.default.Pool.prototype,'query',()=>{throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN');});
  t.mock.method(pg.default.Pool.prototype,'connect',()=>{throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN');});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('TEST_HTTP_ACCESS_FORBIDDEN');});
  const nativeInterval=globalThis.setInterval;
  t.mock.method(globalThis,'setInterval',(...args:Parameters<typeof setInterval>)=>{
    const timer=nativeInterval(...args);timer.unref();t.after(()=>clearInterval(timer));return timer;
  });
  const {normalizeLessonAuthorProposal,lockProposalToBlueprintChapter}=await import('./chat.service.js');
  const root=fileURLToPath(new URL('../../../../landa-ai-rag/',import.meta.url));
  const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const out=spawnSync(python,['-X','utf8','-B','-m','tests.chapter_checkpoint_bridge'],{
    cwd:root,input:JSON.stringify({action}),encoding:'utf8',timeout:20000,maxBuffer:4000000});
  assert.equal(out.status,0,out.error?.message ?? out.stderr);
  const response=JSON.parse(out.stdout);assert.equal(response.provider_calls,2);
  const unit=readRagChapterCheckpointResponse(response.unit_result,{...response.request,checkpoint_units:undefined});
  assert.equal(unit.status,'unit_ready');
  const request={...response.request,checkpoint_action:'validate_chapter',checkpoint_unit_index:undefined,
    checkpoint_units:[{unit_index:0,unit:response.unit_result.unit}]} as RagChapterCheckpointRequest;
  const ready=readRagChapterCheckpointResponse(response.result,request);
  assert.equal(ready.status,'ready');if(ready.status!=='ready')throw new Error('NOT_READY');
  const architecture=response.request.blueprint_architecture;
  const chapter={title:architecture.chapter_title,lessons:architecture.lessons};
  const context={chapterIndex:0,blueprint:{architecture_contract_version:5,content_contract_version:1,chapters:[chapter]}} as Parameters<typeof lockProposalToBlueprintChapter>[1];
  const proposal=lockProposalToBlueprintChapter(normalizeLessonAuthorProposal(ready.proposal),context);
  assertLessonAuthorProposalComponentsValid(proposal,new Set(COURSE_COMPONENT_TYPES));
  assertLessonAuthorPedagogicalQuality({proposal,blueprint_chapter:chapter});
  assert.equal(proposal.chapters[0].lessons[0].units[0].components?.length,4);
  if (action === 'coverage_repair') {
    const component = response.unit_result.unit.components[2];
    assert.equal(component.type, 'la_crossword');
    assert.equal(component.covered_source_fact_ids.length, 23);
    assert.deepEqual(component.source_fact_ids, architecture.lessons[0].units[0].component_plan[2].source_fact_ids);
  }
  assert.deepEqual(response.events.filter((e:any)=>e.event==='passed').map((e:any)=>e.stage),[
    'chapter_checkpoint_content_validation','chapter_checkpoint_pedagogical_validation','chapter_checkpoint_duplication_validation']);
});
