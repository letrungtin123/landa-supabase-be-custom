import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrchestrationV2Manifest, completeOrchestrationV2, OrchestrationV2Error } from './lesson-author-orchestration-v2.logic.js';

const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const hash=(n:number)=>n.toString(16).padStart(64,'0');
const provider=(output=8192)=>({input_tokens:1000,embedding_tokens:100,max_output_tokens:output,max_provider_attempts:2,execution_budget_ms:180000});
function fixture(){return{source_snapshot_hash:hash(1),source_snapshot_budget_ms:600000,skeleton_budget:provider(16384),chapters:[
  {chapter_key:'chapter-1',chapter_node_id:id(1),source_scope_hash:hash(2),architecture_budget:provider(16384),units:[
    {node_id:id(11),contract_hash:hash(11),budget:provider()},{node_id:id(12),contract_hash:hash(12),budget:provider()}]},
  {chapter_key:'chapter-2',chapter_node_id:id(2),source_scope_hash:hash(3),architecture_budget:provider(16384),units:[
    {node_id:id(21),contract_hash:hash(21),budget:provider()}]},
],architecture_validation_budget_ms:30000,inventory_publish_budget_ms:30000,chapter_validation_budget_ms:60000,finalization_budget_ms:30000};}

test('builds a deterministic finite DAG with chapter and unit fan-out',()=>{
  const first=buildOrchestrationV2Manifest(fixture()),second=buildOrchestrationV2Manifest(fixture());
  assert.deepEqual(first,second);assert.equal(first.manifest_hash,second.manifest_hash);
  assert.deepEqual(first.tasks.map(task=>task.kind),['source_snapshot','course_skeleton','chapter_blueprint','chapter_blueprint',
    'validate_architecture','publish_inventory','generate_unit','generate_unit','validate_chapter','generate_unit','validate_chapter','finalize_course']);
  assert.deepEqual(first.tasks.find(task=>task.task_key==='architecture:validate')?.depends_on,
    ['architecture:chapter:chapter-1','architecture:chapter:chapter-2']);
  assert.deepEqual(first.tasks.find(task=>task.task_key==='content:chapter-1:validate')?.depends_on,
    ['content:chapter-1:unit:1','content:chapter-1:unit:2']);
  assert.deepEqual(first.tasks.at(-1)?.depends_on,['content:chapter-1:validate','content:chapter-2:validate']);
  assert.ok(first.token_ceiling>0);assert.ok(first.execution_budget_ms>0);
});

test('rejects duplicate identity, unsafe provider budgets and empty chapters',()=>{
  const duplicate=fixture();duplicate.chapters[1].chapter_node_id=duplicate.chapters[0].chapter_node_id;
  assert.throws(()=>buildOrchestrationV2Manifest(duplicate),OrchestrationV2Error);
  const oversized=fixture();oversized.chapters[0].units[0].budget.max_output_tokens=65_537;
  assert.throws(()=>buildOrchestrationV2Manifest(oversized),{code:'ORCHESTRATION_V2_BUDGET_INVALID'});
  const empty=fixture();empty.chapters[0].units=[];
  assert.throws(()=>buildOrchestrationV2Manifest(empty),{code:'ORCHESTRATION_V2_INPUT_INVALID'});
});

test('terminal receipt requires every task and exact source completeness',()=>{
  const manifest=buildOrchestrationV2Manifest(fixture()),keys=manifest.tasks.map(task=>task.task_key);
  const receipt=completeOrchestrationV2({manifest,succeeded_task_keys:keys,admitted_fact_count:40,
    allocated_fact_count:40,covered_fact_count:40,duplicate_fact_count:0,unresolved_fact_count:0,chapter_receipt_count:2});
  assert.equal(receipt.checks.coverage,'PASS');assert.match(receipt.receipt_hash,/^[0-9a-f]{64}$/);
  assert.throws(()=>completeOrchestrationV2({manifest,succeeded_task_keys:keys.slice(1),admitted_fact_count:40,
    allocated_fact_count:40,covered_fact_count:40,duplicate_fact_count:0,unresolved_fact_count:0,chapter_receipt_count:2}),
  {code:'ORCHESTRATION_V2_COMPLETENESS_FAILED'});
  assert.throws(()=>completeOrchestrationV2({manifest,succeeded_task_keys:keys,admitted_fact_count:40,
    allocated_fact_count:39,covered_fact_count:40,duplicate_fact_count:0,unresolved_fact_count:0,chapter_receipt_count:2}),
  {code:'ORCHESTRATION_V2_COMPLETENESS_FAILED'});
});
