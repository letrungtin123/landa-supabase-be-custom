import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { workspaceComponentValidationWire, workspaceChapterValidationUnits, acceptWorkspaceChapterValidation } from './lesson-author-workspace-chapter-validation.logic.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { projectBlueprintDraftArchitecture } from './lesson-author-blueprint-draft-architecture.logic.js';
import { encodeWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';
import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';
import type { WorkspaceChapterGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { componentPlanId } from './lesson-author-capabilities.logic.js';

const allowed=new Set<CourseComponentType>(['html','problem','la_faq','la_sortable','la_crossword','la_diagram']);
const metadata={component_plan_id:'synthetic',source_fact_ids:['fact_1'],covered_source_fact_ids:['fact_1'],supporting_evidence_fact_ids:[],learning_objective_refs:['lo_1']};
const html='<p>A safety observation records the condition that can be seen, whereas an interpretation explains the meaning of that condition. Check the work area before starting a task, record the specific hazard and review the approved procedure. For example, a damaged cable is an observation. A decision to keep the equipment out of use until inspected follows the procedure. Do not treat a guess about the damage as a verified cause. Describe what is visible and escalate uncertainty through the approved process.</p>';
const wrapped=(type:LessonAuthorComponentProposal['type'],key:string,data:unknown,extra={})=>({type,title:'Synthetic',data:{[key]:JSON.stringify(data),...extra},metadata:{...metadata,[key]:data,...extra}});
function components():LessonAuthorComponentProposal[]{return[
  {type:'html',title:'Observation',data:html,metadata},
  ...(['multiple_choice','multiple_select','dropdown'] as const).map(kind=>({type:'problem' as const,title:'Check',metadata,
    data:encodeWorkspaceProblem({kind,question:'Which statement is an observation?',explanation:'An observation states the visible condition.',choices:[{text:'A cable is damaged.',correct:true},{text:'The cause is confirmed.',correct:false},{text:'The repair is approved.',correct:false}]})})),
  {type:'problem',title:'Count',metadata,data:encodeWorkspaceProblem({kind:'numerical',question:'How many approved steps?',answers:['3'],tolerance:'0',explanation:'There are three.'})},
  {type:'problem',title:'Term',metadata,data:encodeWorkspaceProblem({kind:'short_text',question:'Name the record.',answers:['Observation','Record'],case_sensitive:false,explanation:'Record what can be observed.'})},
  wrapped('la_faq','faq_data',{items:[{id:1,question:'Why record observations?',answer:'To distinguish what is visible from interpretation.'},{id:2,question:'What if the cause is unclear?',answer:'Escalate uncertainty.'}]}),
  wrapped('la_sortable','sortable_data',{items:[{id:1,text:'Inspect'},{id:2,text:'Record'},{id:3,text:'Escalate'}]},{question_text:'Order the procedure.'}),
  wrapped('la_crossword','crossword_data',{words:['OBSERVE','RECORD','ESCALATE'].map((answer,row)=>({id:row+1,answer,clue:`Synthetic term ${row+1}`,hint:'',row,col:0,direction:'across'})),keyword_coordinates:[]}),
  wrapped('la_diagram','diagram_data',{start_diagram_id:'main',diagrams:[{id:'main',name:'Observation process',nodes:[
    {id:'n1',type:'customShape',position:{x:0,y:0},data:{label:'Observe',shape:'rounded'}},
    {id:'n2',type:'customShape',position:{x:320,y:0},data:{label:'Record',shape:'rectangle'}}],edges:[{id:'e1',source:'n1',target:'n2',label:'then'}]}]}),
];}
test('all six CMS adapters satisfy the strict Python wire contract and non-single-choice problems stay rejected, no provider',()=>{
  const originals=components(),before=structuredClone(originals),wire=originals.map(c=>workspaceComponentValidationWire(c,allowed));
  const root=fileURLToPath(new URL('../../../../landa-ai-rag/',import.meta.url));
  const python=resolve(root,process.platform==='win32'?'.venv-dev/Scripts/python.exe':'.venv-dev/bin/python');
  const code=`import json,sys\nfrom app.main import staged_component_payload_code\nprint(json.dumps([staged_component_payload_code(c) for c in json.load(sys.stdin)]))`;
  const result=spawnSync(python,['-X','utf8','-B','-c',code],{cwd:root,input:JSON.stringify(wire),encoding:'utf8',timeout:20000,maxBuffer:1000000});
  assert.equal(result.status,0,result.error?.message??result.stderr);assert.deepEqual(JSON.parse(result.stdout),[
    null,null,'PROBLEM_SINGLE_CHOICE_REQUIRED','PROBLEM_SINGLE_CHOICE_REQUIRED','PROBLEM_SINGLE_CHOICE_REQUIRED','PROBLEM_SINGLE_CHOICE_REQUIRED',null,null,null,null,
  ]);
  assert.deepEqual(originals,before);assert.equal((wire.at(-1) as any).edges[0].source,0);
  for(const c of wire)assert.deepEqual(c.source_fact_ids,['fact_1']);
});
test('unsupported multi-diagram or oversized subtype cannot be silently dropped',()=>{
  const d=components().at(-1)!;const value=structuredClone(d.metadata!.diagram_data as any);value.diagrams.push({...value.diagrams[0],id:'extra'});
  const multi=wrapped('la_diagram','diagram_data',value);
  assert.throws(()=>workspaceComponentValidationWire(multi,allowed),/WORKSPACE_CHAPTER_WIRE_UNSUPPORTED/);
});
function fixture(locale:'en'|'vi'='en'){
  const blueprint=workspaceInventoryFixture(1,locale);const u=blueprint.chapters[0].lessons[0].units[0];
  const context:WorkspaceChapterGenerationContext={blueprint,chapterIndex:0,allowed,correlation_id:'correlation',source_snapshot_hash:'a'.repeat(64),input_context_hash:'b'.repeat(64),targetNodes:[],
    proposal:{summary:'',chapters:[{title:blueprint.chapters[0].title,lessons:[{title:blueprint.chapters[0].lessons[0].title,units:[{title:u.title,
      components:[{type:'html',title:'Observation',data:html,metadata:{...metadata,component_plan_id:u.component_plan[0].component_plan_id}}]}]}]}]}};
  const units=workspaceChapterValidationUnits(context);
  const request={checkpoint_version:1,checkpoint_action:'validate_chapter',checkpoint_units:units,correlation_id:'correlation',
    target:'lesson_author',operation:'create',target_type:'chapter',generation_mode:'staged',remaining_workflow_budget_ms:480000,
    source_documents:[{document_id:'synthetic'}],blueprint_architecture:projectBlueprintDraftArchitecture(blueprint,0)} as unknown as RagChapterCheckpointRequest;
  const response={checkpoint_version:1,correlation_id:'correlation',status:'ready',usage:{inputTokens:0,outputTokens:0,embeddingTokens:0,totalTokens:0},
    usage_source:'no_generation',usage_complete:true,retrieval:{},workflow:{status:'ready',workflow:'lesson_generation',workflow_version:'chapter-checkpoint-1',repair_count:0},
    proposal:{chapters:[{title:blueprint.chapters[0].title,lessons:[{title:blueprint.chapters[0].lessons[0].title,units:units.map(u=>u.unit)}]}]}};
  return{context,request,response};
}
test('EN/VI complete baselines pass full Node chapter validation and unchanged Python response',()=>{
  for(const locale of ['en','vi'] as const){const f=fixture(locale);const accepted=acceptWorkspaceChapterValidation(f.context,f.request,f.response);
    assert.equal(accepted.validation_contract,'workspace-chapter-baseline-1');assert.equal(accepted.usage.usage_source,'no_generation');
    assert.equal(accepted.result_hash.length,64);}
});
test('final validation cannot rewrite content, facts, topology, correlation or architecture',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.response.proposal.chapters[0].lessons[0].units[0].title='different';},
    (f:ReturnType<typeof fixture>)=>{f.response.proposal.chapters[0].lessons[0].units[0].components=[];},
    (f:ReturnType<typeof fixture>)=>{f.response.correlation_id='foreign';},
    (f:ReturnType<typeof fixture>)=>{f.request.blueprint_architecture!.lessons=[];}]){
    const f=fixture();f.response=structuredClone(f.response);mutate(f);assert.throws(()=>acceptWorkspaceChapterValidation(f.context,f.request,f.response));
  }
});
test('partial or invalid CMS baseline cannot be sent to Python or certified ready',()=>{
  const f=fixture();f.context.proposal.chapters[0].lessons[0].units[0].components=[];
  assert.throws(()=>workspaceChapterValidationUnits(f.context));
  const g=fixture();g.context.proposal.chapters[0].lessons[0].units[0].components![0].metadata!.covered_source_fact_ids=[];
  assert.throws(()=>workspaceChapterValidationUnits(g.context),/WORKSPACE_CHAPTER_VALIDATION_FAILED/);
});

test('stored CMS → validation wire → actual Python full-chapter gates → Node acceptance preserves the baseline',()=>{
  const f=fixture();
  const plan=componentPlanId('chapter_1.lesson_1.unit_1','html',['block_1']);
  f.context.blueprint.chapters[0].lessons[0].units[0].component_plan[0].component_plan_id=plan;
  f.context.proposal.chapters[0].lessons[0].units[0].components![0].metadata!.component_plan_id=plan;
  f.request.blueprint_architecture=projectBlueprintDraftArchitecture(f.context.blueprint,0);
  if(f.request.checkpoint_action==='validate_chapter')f.request.checkpoint_units=workspaceChapterValidationUnits(f.context);
  const before=structuredClone(f.context.proposal);
  f.context.correlation_id='55555555-5555-4555-8555-555555555555';
  f.request.correlation_id=f.context.correlation_id;
  f.request.source_documents=[{document_id:'66666666-6666-4666-8666-666666666666',kb_id:'77777777-7777-4777-8777-777777777777',name:'fixture.pdf',type:'pdf',status:'ready'}];
  const root=fileURLToPath(new URL('../../../../landa-ai-rag/',import.meta.url));
  const python=resolve(root,process.platform==='win32'?'.venv-dev/Scripts/python.exe':'.venv-dev/bin/python');
  const code=`import asyncio,json,sys\nfrom unittest.mock import patch\nfrom app import main\nfrom tests.test_chapter_checkpoint import fixture,checkpoint_result\npayload=json.load(sys.stdin)\nbase,_,_=fixture(count=1,action='validate_chapter')\ndata={**base.model_dump(),**payload['request'],'checkpoint_unit_index':None}\nrequest=main.RagLessonAuthorCheckpointRequest.model_validate(data)\nmanifest={'facts':[{'fact_id':'fact_1','source_page':1,'source_ref':'src_1','text':payload['evidence']}]}\ndef forbidden(*args,**kwargs):\n raise AssertionError('REAL_PROVIDER_OR_DATABASE_ACCESS_FORBIDDEN')\nwith patch('asyncpg.create_pool',forbidden),patch('app.main.generate_content',forbidden):\n result=asyncio.run(main.build_lesson_author_checkpoint_result(request,context='',source_outline='',source_coverage='',rows=[],manifest=manifest,known_source_refs={'src_1'},retrieval={},retrieval_usage=main.AiUsage(),elapsed_ms=0,emit=lambda _:None))\nprint(json.dumps(result))`;
  const result=spawnSync(python,['-X','utf8','-B','-c',code],{cwd:root,input:JSON.stringify({request:f.request,evidence:html.replace(/<[^>]*>/g,'')}),
    encoding:'utf8',timeout:20000,maxBuffer:1000000});
  assert.equal(result.status,0,result.error?.message??result.stderr);
  const accepted=acceptWorkspaceChapterValidation(f.context,f.request,JSON.parse(result.stdout));
  assert.equal(accepted.validation_contract,'workspace-chapter-baseline-1');assert.deepEqual(f.context.proposal,before);
});
