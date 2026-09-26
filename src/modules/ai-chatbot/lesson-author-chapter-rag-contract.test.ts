import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRagChapterCheckpointRequest, readRagChapterCheckpointResponse,
  type RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';

function request(): RagChapterCheckpointRequest {
  return { tenant_id: 'tenant', kb_id: 'kb', conversation_id: 'conversation', target: 'lesson_author',
    correlation_id: 'same-server-correlation', model: 'unchanged-model', max_output_tokens: 30_000,
    embedding_model: 'unchanged-embedding', embedding_dimensions: 768, system_prompt: 'test', user_message: 'test',
    history: [], source_documents: [{ document_id: 'doc', kb_id: 'kb', name: 'fixture.pdf', type: 'pdf', status: 'ready' }],
    outline_context: '', target_scope_instruction: '', output_schema_hint: '',
    operation: 'create', target_type: 'chapter', generation_mode: 'staged',
    blueprint_architecture: { architecture_contract_version: 5, chapter_title: 'Chapter', lessons: [
      { title: 'First', units: [{ title: 'Repeated', component_plan: [] }, { title: 'Repeated', component_plan: [] }] },
      { title: 'Second', units: [{ title: 'Repeated', component_plan: [] }] },
    ] }, checkpoint_version: 1, checkpoint_action: 'generate_unit', checkpoint_unit_index: 2, remaining_workflow_budget_ms: 250_000 };
}
const unit = () => ({ title: 'Repeated', components: [{ type: 'html', html: '<p>Synthetic fixture</p>' }] });
function response() {
  return { checkpoint_version: 1, correlation_id: 'same-server-correlation', status: 'unit_ready',
    unit_index: 2, unit_path: 'chapter_1.lesson_2.unit_1', unit: unit(),
    usage: { inputTokens: 10, outputTokens: 20, embeddingTokens: 0, totalTokens: 30 },
    usage_complete: true, usage_source: 'provider', retrieval: {} };
}

test('only explicit V5 staged chapter contract can enter checkpoint transport', () => {
  assertRagChapterCheckpointRequest(request());
  for (const changes of [{ checkpoint_version: 2 }, { operation: 'delete' }, { generation_mode: 'single' },
    { target_type: 'unit' }, { correlation_id: '' }, { source_documents: [] }, { remaining_workflow_budget_ms: 0 },
    { remaining_workflow_budget_ms: 600_000 }, { checkpoint_unit_index: -1 }, { checkpoint_unit_index: 3 },
    { checkpoint_unit_index: 1.5 }, { checkpoint_units: [] }]) {
    assert.throws(() => assertRagChapterCheckpointRequest({ ...request(), ...changes } as RagChapterCheckpointRequest));
  }
  const old = request();
  old.blueprint_architecture!.architecture_contract_version = 4;
  assert.throws(() => assertRagChapterCheckpointRequest(old)); // Old normal proposal transport remains available.
});

test('response binds correlation and indexed topology, never repeated title matching', () => {
  const accepted = readRagChapterCheckpointResponse(response(), request());
  assert.equal(accepted.status, 'unit_ready');
  for (const changes of [{ checkpoint_version: 2 }, { correlation_id: 'different' }, { unit_index: 0 },
    { unit_path: 'chapter_1.lesson_1.unit_1' }, { status: 'ready' }, { unit: { ...unit(), title: 'Other' } },
    { proposal: { chapters: [] } }]) {
    assert.throws(() => readRagChapterCheckpointResponse({ ...response(), ...changes }, request()));
  }
});

test('response cannot claim complete provider usage from missing fields or local estimates', () => {
  for (const changes of [{ usage: {} }, { usage: { inputTokens: 10, totalTokens: 30 } },
    { usage_source: 'local_estimate' }, { usage_source: 'no_generation' }, { usage_source: 'unknown-value' },
    { usage_complete: 'true' }]) {
    assert.throws(() => readRagChapterCheckpointResponse({ ...response(), ...changes }, request()));
  }
  const unavailable = readRagChapterCheckpointResponse({ ...response(), usage_complete: false,
    usage_source: 'mixed_or_unavailable', usage: {} }, request());
  assert.equal(unavailable.usage_complete, false);
});

test('empty or oversized checkpoint cannot cross the transport acceptance boundary', () => {
  assert.throws(() => readRagChapterCheckpointResponse({ ...response(), unit: { components: [] } }, request()));
  assert.throws(() => readRagChapterCheckpointResponse({ ...response(), unit: { ...unit(), padding: 'x'.repeat(2 * 1024 * 1024) } }, request()));
});

function finalRequest(): RagChapterCheckpointRequest {
  const { checkpoint_unit_index: _index, ...base } = request();
  return { ...base, checkpoint_action: 'validate_chapter', checkpoint_units: [0, 1, 2].map(unit_index => ({ unit_index, unit: unit() })) };
}
function finalResponse() {
  return { checkpoint_version: 1, correlation_id: 'same-server-correlation', status: 'ready',
    proposal: { chapters: [] }, usage: { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, totalTokens: 0 },
    usage_complete: true, usage_source: 'no_generation', retrieval: {}, workflow: {
      status: 'ready', workflow: 'lesson_generation', workflow_version: 'chapter-checkpoint-1', repair_count: 0,
    } };
}

test('finalization requires every unique canonical unit index; no partial or duplicated list', () => {
  assertRagChapterCheckpointRequest(finalRequest());
  const good = finalRequest();
  if (good.checkpoint_action !== 'validate_chapter') assert.fail();
  for (const units of [good.checkpoint_units.slice(1), [good.checkpoint_units[0], good.checkpoint_units[0], good.checkpoint_units[2]],
    good.checkpoint_units.map(u => ({ ...u, unit_index: u.unit_index + 1 }))]) {
    assert.throws(() => assertRagChapterCheckpointRequest({ ...good, checkpoint_units: units }));
  }
});

test('finalization accepts only final validation result, never per-unit readiness or failed workflow', () => {
  assert.equal(readRagChapterCheckpointResponse(finalResponse(), finalRequest()).status, 'ready');
  for (const changes of [{ status: 'unit_ready' }, { unit: unit() }, { unit_index: 0 }, { workflow: { status: 'failed' } },
    { workflow: { ...finalResponse().workflow, repair_count: 1 } }, { workflow: { ...finalResponse().workflow, workflow: 'course_architecture' } }]) {
    assert.throws(() => readRagChapterCheckpointResponse({ ...finalResponse(), ...changes }, finalRequest()));
  }
});

test('envelope validation does not replace existing component/source/full proposal validation', () => {
  // The registry/complete proposal callbacks remain mandatory in the checkpoint
  // repository. Do not add a second competing registry to the transport layer.
  const accepted = readRagChapterCheckpointResponse(finalResponse(), finalRequest());
  assert.equal(accepted.status, 'ready');
  if (accepted.status === 'ready') assert.deepEqual(accepted.proposal, { chapters: [] });
});
