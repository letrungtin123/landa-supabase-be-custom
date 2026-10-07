import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  acceptOrchestrationV2GeneratedUnit,
  prepareOrchestrationV2UnitGenerationContract,
  readOrchestrationV2UnitProviderResponse,
  type OrchestrationV2UnitComponentPlan,
  type OrchestrationV2UnitGenerationContract,
} from './lesson-author-orchestration-v2-unit.logic.js';
import { executeOrchestrationV2UnitTask } from './lesson-author-orchestration-v2-unit.service.js';
import { createOrchestrationV2UnitRepository } from './lesson-author-orchestration-v2-unit.repository.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

const hash = (value: string) => orchestrationV2Hash(value);

function resolveAiRagDevPython(root: string): string {
  return resolve(
    root,
    process.platform === 'win32' ? '.venv-dev/Scripts/python.exe' : '.venv-dev/bin/python',
  );
}

function fixture() {
  const source = hash('unit-source');
  const skeleton = { contract_version: 2 as const, source_snapshot_hash: source, locale: 'vi' as const,
    title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
    learning_outcomes: ['Apply'], assessment_strategy: 'Practice', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn', source_scope_ids: ['scope-1'],
    }] };
  const shard = { contract_version: 2 as const, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
    shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn', lessons: [{
      title: 'Lesson', objective: 'Learn', learning_objectives: ['Apply safely'], learning_activities: ['Read'],
      assessment: 'Check', units: [{ title: 'Unit', purpose: 'Teach safely', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [{ type: 'html' as const, title: 'Explanation',
          rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: null }] }] };
  const assembly = assembleOrchestrationV2Architecture(skeleton,
    [{ scope_key: 'scope-1', title: 'Scope', source_ref: 'doc.pdf', fact_count: 2, content_chars: 60 }],
    [{ artifact_hash: hash('unit-shard'), shard }]);
  const sourceFacts: OrchestrationV2SourceFact[] = [
    { document_id: '00000000-0000-4000-8000-000000000011', fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Read the procedure first.',
      source_ref: 'doc.pdf', source_page: 1, source_chunk: 0, locator: {} },
    { document_id: '00000000-0000-4000-8000-000000000011', fact_key: 'fact-2', scope_key: 'scope-1', fact_text: 'Verify each safety control.',
      source_ref: 'doc.pdf', source_page: 1, source_chunk: 0, locator: {} },
  ];
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts });
  const plan = contract.component_plan[0]!;
  const responseWire = { contract_version: 2, source_snapshot_hash: source,
    unit_path: contract.unit_path, unit: { title: contract.unit_title,
      source_fact_ids: [...contract.unit_source_fact_ids], components: [{ type: 'html', title: 'Explanation',
        data: '<p>Read the complete procedure first, then verify every safety control before starting work.</p>',
        component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
        covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [],
        metadata: { component_plan_id: plan.component_plan_id, source_fact_ids: [...plan.source_fact_ids],
          covered_source_fact_ids: [...plan.source_fact_ids], supporting_evidence_fact_ids: [],
          learning_objective_refs: [...plan.learning_objective_refs] } }] },
    usage_complete: true as const, usage_source: 'provider' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  return { assembly, sourceFacts, contract, responseWire };
}

test('unit contract is deterministic, bounded and uses provider-compatible stable component IDs', () => {
  const { assembly, sourceFacts, contract } = fixture();
  const again = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: structuredClone(sourceFacts) });
  assert.deepEqual(contract, again);
  assert.match(contract.component_plan[0]!.component_plan_id, /^cp2_[a-f0-9]{32}$/);
  assert.deepEqual(contract.component_plan[0]!.source_fact_ids, ['fact-1', 'fact-2']);
  const { contract_hash: contractHash, ...base } = contract;
  assert.equal(contractHash, orchestrationV2Hash(base));
});

test('CP3B sends table and visual relations through the real Python writer adapter without ownership drift', () => {
  const { assembly, sourceFacts } = fixture();
  const sourceRevision = hash('cp3b-source-revision');
  const assetRevision = hash('cp3b-visual-asset');
  const evidenceFacts = sourceFacts.map((fact, index) => ({
    ...fact,
    fact_text: index === 0
      ? 'Row 1: Mối nguy | Biện pháp | Chủ trì'
      : 'Row 2: Hóa chất |  | HSE',
    locator: {
      source_revision: sourceRevision,
      ...(index === 0 ? {
        visual_prompt_text: 'Biện pháp nào cần được ưu tiên?',
        visual_regions: [{
          region_kind: 'embedded_image', asset_revision: assetRevision,
          locator: { page: 1, bbox_normalized: [0.1, 0.2, 0.8, 0.9] },
          observation: { status: 'unreviewed', facts: [] },
          inference: { status: 'not_performed', claims: [] },
        }],
      } : {}),
    },
  }));
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: evidenceFacts });
  const root = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolveAiRagDevPython(root);
  const out = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.cp3b_writer_evidence_bridge'], {
    cwd: root, input: JSON.stringify({ unit_contract: contract, locale: 'vi' }),
    encoding: 'utf8', timeout: 20_000, maxBuffer: 8_000_000,
  });
  assert.equal(out.status, 0, out.error?.message ?? out.stderr);
  const result = JSON.parse(out.stdout) as {
    manifest_fact_ids: string[]; represented_fact_count: number;
    writer_source_evidence_bundle: { status: string; elements: Array<{
      kind: string; source_fact_ids: string[]; payload: Record<string, unknown>;
    }> };
  };
  assert.deepEqual(result.manifest_fact_ids, contract.unit_source_fact_ids);
  assert.equal(result.represented_fact_count, contract.unit_source_fact_ids.length);
  assert.equal(result.writer_source_evidence_bundle.status, 'review_required');
  const table = result.writer_source_evidence_bundle.elements.find(item => item.kind === 'table');
  assert.deepEqual(table?.payload.rows, [
    ['Mối nguy', 'Biện pháp', 'Chủ trì'],
    ['Hóa chất', '', 'HSE'],
  ]);
  const visual = result.writer_source_evidence_bundle.elements.find(item => item.kind === 'visual');
  assert.equal(visual?.payload.prompt_text, 'Biện pháp nào cần được ưu tiên?');
  const evidenceFactIds = new Set(result.writer_source_evidence_bundle.elements
    .flatMap(item => item.source_fact_ids));
  assert.deepEqual([...evidenceFactIds].sort(), [...contract.unit_source_fact_ids].sort());
});

test('unit contract rejects facts outside its exact source scope', () => {
  const { assembly, sourceFacts } = fixture();
  sourceFacts[0]!.scope_key = 'scope-outside';
  assert.throws(() => prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts }),
  { code: 'ORCHESTRATION_V2_UNIT_CONTRACT_INVALID' });
});

test('density-v3 unit gives canonical ownership only to HTML and read-only evidence to interactions', () => {
  const { assembly: baseAssembly, sourceFacts: baseFacts } = fixture();
  const assembly = structuredClone(baseAssembly);
  const unit = assembly.architecture.chapters[0]!.lessons[0]!.units[0]!;
  unit.component_plan.push({
    type: 'problem', title: 'Check', rationale: 'Assess the taught facts', source_scope_ids: ['scope-1'],
  });
  const sourceFacts = baseFacts.map((fact, index) => ({ ...fact,
    fact_text: `Row ${index + 1}: Hazard ${index + 1} | Approved control ${index + 1}`,
    locator: {
    ...fact.locator, instructional_density_policy_version: 'unit-content-v3-density-1',
    content_kinds: ['table'], table_count: 1,
  } }));
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts });
  assert.deepEqual(contract.component_plan[0]!.required_artifacts, [{ type: 'table', minimum_items: 2 }]);
  assert.deepEqual(contract.component_plan[0]!.source_fact_ids, ['fact-1', 'fact-2']);
  assert.deepEqual(contract.component_plan[0]!.supporting_evidence_fact_ids, []);
  assert.deepEqual(contract.component_plan[1]!.source_fact_ids, []);
  assert.deepEqual(contract.component_plan[1]!.supporting_evidence_fact_ids, ['fact-1', 'fact-2']);

  const components = contract.component_plan.map(plan => ({
    type: plan.type, component_plan_id: plan.component_plan_id,
    source_fact_ids: [...plan.source_fact_ids], covered_source_fact_ids: [...plan.source_fact_ids],
    supporting_evidence_fact_ids: [...plan.supporting_evidence_fact_ids],
  }));
  assert.doesNotThrow(() => readOrchestrationV2UnitProviderResponse({
    contract_version: 2, source_snapshot_hash: contract.source_snapshot_hash, unit_path: contract.unit_path,
    unit: { title: contract.unit_title, source_fact_ids: [...contract.unit_source_fact_ids], components },
    usage_complete: true, usage_source: 'provider', usage: {},
  }, contract));
  const drifted = structuredClone(components);
  drifted[1]!.covered_source_fact_ids = ['fact-1'];
  assert.throws(() => readOrchestrationV2UnitProviderResponse({
    contract_version: 2, source_snapshot_hash: contract.source_snapshot_hash, unit_path: contract.unit_path,
    unit: { title: contract.unit_title, source_fact_ids: [...contract.unit_source_fact_ids], components: drifted },
    usage_complete: true, usage_source: 'provider', usage: {},
  }, contract), { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider response rejects provenance drift before normalization', () => {
  const { contract, responseWire } = fixture();
  const changed = structuredClone(responseWire);
  changed.unit.components[0]!.covered_source_fact_ids = ['fact-1'];
  assert.throws(() => readOrchestrationV2UnitProviderResponse(changed, contract),
    { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider response cannot publish when exact usage accounting is unavailable', () => {
  const { contract, responseWire } = fixture();
  const incomplete = { ...responseWire, usage_complete: false, usage_source: 'mixed_or_unavailable' };
  assert.throws(() => readOrchestrationV2UnitProviderResponse(incomplete, contract),
    { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider response accepts only the two server-owned fallback accounting contracts', () => {
  const { contract, responseWire } = fixture();
  const reserved = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: false, usage_source: 'reserved_upper_bound', usage: {} }, contract);
  assert.equal(reserved.usage_source, 'reserved_upper_bound');
  assert.equal(reserved.content_origin, 'structured_fallback');
  assert.equal(reserved.quality_state, 'review_required');
  const deterministic = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: true, usage_source: 'deterministic_fallback', usage: {} }, contract);
  assert.equal(deterministic.usage_source, 'deterministic_fallback');
  assert.equal(deterministic.content_origin, 'structured_fallback');
  assert.equal(deterministic.quality_state, 'review_required');
  for (const invalid of [
    { usage_complete: false, usage_source: 'reserved_upper_bound',
      content_origin: 'structured_fallback', quality_state: 'validated' },
    { usage_complete: true, usage_source: 'deterministic_fallback',
      content_origin: 'provider_validated', quality_state: 'validated' },
  ]) assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire, ...invalid }, contract),
    { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: true, usage_source: 'reserved_upper_bound' }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: false, usage_source: 'deterministic_fallback' }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider attempt trace is bounded metadata and legacy responses remain explicitly trace-empty', () => {
  const { contract, responseWire } = fixture();
  assert.deepEqual(readOrchestrationV2UnitProviderResponse(responseWire, contract).attempt_trace, []);
  const event = {
    sequence: 1, invocation_kind: 'writer', invocation_index: 1, provider_attempt: 1,
    phase: 'provider_transport', outcome: 'succeeded', event_code: 'provider_response_received',
    failure_stage: null, failure_code: null, failure_path: null, provider_dispatched: true,
    usage_source: 'provider_reported', observed_usage: {
      provider_input_tokens: 100, provider_output_tokens: 50, provider_total_tokens: 150,
    }, duration_ms: 120, diagnostics: { provider_http_status: 200, provider_finish_reason: 'STOP' },
  };
  const admitted = readOrchestrationV2UnitProviderResponse({ ...responseWire, attempt_trace: [event] }, contract);
  assert.deepEqual(admitted.attempt_trace[0]?.observed_usage, event.observed_usage);
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    attempt_trace: [{ ...event, prompt: 'must never cross the metadata boundary' }] }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    attempt_trace: [{ ...event, outcome: 'failed', failure_stage: null, failure_code: null }] }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    attempt_trace: Array.from({ length: 65 }, (_value, index) => ({ ...event, sequence: index + 1 })) }, contract),
  { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('provider usage can retain valid siblings while explicit component fallback stays review-required', () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    content_origin: 'structured_fallback', quality_state: 'review_required' }, contract);
  assert.equal(response.usage_source, 'provider');
  assert.equal(response.content_origin, 'structured_fallback');
  assert.equal(response.quality_state, 'review_required');
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response, normalizeProposal,
    allowed: new Set<CourseComponentType>(['html']) });
  assert.equal(publication.content_origin, 'structured_fallback');
  assert.equal(publication.quality_state, 'review_required');
});

test('accepted response becomes exact revision-zero unit and component baselines', () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const allowed = new Set<CourseComponentType>(['html']);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response, normalizeProposal, allowed });
  assert.equal(publication.nodes.length, 2);
  assert.deepEqual(publication.nodes.map(node => node.path),
    ['chapter_1.lesson_1.unit_1', 'chapter_1.lesson_1.unit_1.component_1']);
  assert.equal(publication.validation_contract, 'orchestration-unit-baseline-v2');
  assert.match(publication.result_hash, /^[a-f0-9]{64}$/);
});

test('bounded semantic review evidence survives provider admission and publication', () => {
  const { contract, responseWire } = fixture();
  const semanticReview = {
    contract_version: 'semantic-review-v1', config_hash: 'a'.repeat(64), status: 'passed',
    quality_state: 'validated', finding_counts: { critical: 0, major: 0, minor: 0 }, findings: [],
    repair_attempted: false, repair_applied: false, repair_component_indices: [], failure_code: null,
  };
  const response = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    semantic_review: semanticReview }, contract);
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response, normalizeProposal,
    allowed: new Set<CourseComponentType>(['html']) });
  assert.equal(response.semantic_review?.status, 'passed');
  assert.equal(publication.semantic_review?.config_hash, semanticReview.config_hash);
});

test('semantic review evidence cannot address a component outside the admitted unit', () => {
  const { contract, responseWire } = fixture();
  const semanticReview = {
    contract_version: 'semantic-review-v1', config_hash: 'a'.repeat(64), status: 'review_required',
    quality_state: 'review_required', finding_counts: { critical: 1, major: 0, minor: 0 },
    findings: [{ criterion: 'evidence_fidelity', code: 'EVIDENCE_CONTRADICTION', severity: 'critical',
      scope: 'component', component_index: 2, candidate_path: 'components[2].data',
      source_fact_key_hashes: ['b'.repeat(16)], witness_sha256: 'c'.repeat(64),
      repair_instruction_sha256: 'd'.repeat(64) }], repair_attempted: false,
    repair_applied: false, repair_component_indices: [], failure_code: null,
  };
  assert.throws(() => readOrchestrationV2UnitProviderResponse({ ...responseWire,
    semantic_review: semanticReview }, contract), { code: 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID' });
});

test('density-v3 acceptance rejects handbook-sized HTML while legacy contracts remain compatible', () => {
  const { assembly, sourceFacts, responseWire } = fixture();
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const allowed = new Set<CourseComponentType>(['html']);
  const oversized = structuredClone(responseWire);
  oversized.unit.components[0]!.data = `<p>${'oversized teaching text '.repeat(260)}</p>`;

  const legacyContract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts });
  assert.doesNotThrow(() => acceptOrchestrationV2GeneratedUnit({ contract: legacyContract,
    response: readOrchestrationV2UnitProviderResponse(oversized, legacyContract), normalizeProposal, allowed }));

  const v3Facts = sourceFacts.map(fact => ({ ...fact, locator: {
    ...fact.locator, instructional_density_policy_version: 'unit-content-v3-density-1',
  } }));
  const v3Contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: v3Facts });
  assert.throws(() => acceptOrchestrationV2GeneratedUnit({ contract: v3Contract,
    response: readOrchestrationV2UnitProviderResponse(oversized, v3Contract), normalizeProposal, allowed }),
  { code: 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID' });
});

test('density-v3 contract preserves source table structure as a required HTML artifact', () => {
  const { assembly, sourceFacts, responseWire } = fixture();
  const tableFacts = sourceFacts.map((fact, index) => ({ ...fact,
    fact_text: `Row ${index + 1}: Column ${index + 1} | Value ${index + 1}`,
    locator: {
    ...fact.locator, instructional_density_policy_version: 'unit-content-v3-density-1',
    content_kinds: ['table'], table_count: 1,
  } }));
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: tableFacts });
  assert.deepEqual(contract.component_plan[0]!.required_artifacts, [{ type: 'table', minimum_items: 2 }]);
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const allowed = new Set<CourseComponentType>(['html']);
  assert.throws(() => acceptOrchestrationV2GeneratedUnit({ contract,
    response: readOrchestrationV2UnitProviderResponse(responseWire, contract), normalizeProposal, allowed }),
  { code: 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID' });

  const preserved = structuredClone(responseWire);
  preserved.unit.components[0]!.data = '<table><tbody><tr><th>Hazard</th><td>Control</td></tr><tr><th>Heat</th><td>Guard</td></tr></tbody></table>';
  assert.doesNotThrow(() => acceptOrchestrationV2GeneratedUnit({ contract,
    response: readOrchestrationV2UnitProviderResponse(preserved, contract), normalizeProposal, allowed }));
});

test('chunk table metadata alone does not require an unreconstructable HTML table', () => {
  const { assembly, sourceFacts } = fixture();
  const proseFacts = sourceFacts.map(fact => ({ ...fact, locator: {
    ...fact.locator, instructional_density_policy_version: 'unit-content-v3-density-1',
    content_kinds: ['table', 'text'], table_count: 1,
  } }));

  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: proseFacts });

  assert.deepEqual(contract.component_plan[0]!.required_artifacts, []);
});

test('Python deterministic fallback for every component type passes the production Node normalizer', async t => {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorProposal } = await import('./chat.service.js');
  const root = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolveAiRagDevPython(root);
  const base = fixture().contract;
  const evidenceTexts = [
    'Bước 1: Kiểm tra điều kiện an toàn trước khi bắt đầu công việc.',
    'Bước 2: Mang đầy đủ thiết bị bảo hộ phù hợp với mối nguy đã nhận diện.',
    'Bước 3: Thực hiện công việc theo trình tự đã được phê duyệt.',
    'Mối nguy cơ khí: Nguồn chuyển động có thể gây va đập, cuốn hoặc kẹp.',
    'Mối nguy điện: Nguồn điện không được kiểm soát có thể gây điện giật hoặc hồ quang.',
    'Mối nguy hóa chất: Phơi nhiễm cần được kiểm soát theo đặc tính của hóa chất.',
    'Câu hỏi: Việc nào phải thực hiện trước khi bắt đầu công việc?',
    'A. Kiểm tra điều kiện an toàn tại nơi làm việc',
    'B. Bỏ qua mối nguy đã nhận diện',
    'C. Chờ đến khi xảy ra sự cố mới kiểm tra',
    'Đáp án: A',
    'Giải thích: Cần kiểm tra điều kiện an toàn trước khi công việc bắt đầu.',
    'Nếu điều kiện an toàn chưa được xác nhận, không được bắt đầu công việc.',
    'Lưu ý: Thiết bị bảo hộ phải phù hợp với mối nguy đã nhận diện.',
  ];
  const evidenceIds = evidenceTexts.map((_text, index) => `fact-${index + 1}`);
  const evidenceFacts = evidenceTexts.map((fact_text, index) => ({
    ...base.source_facts[0]!, fact_key: evidenceIds[index]!, fact_text,
  }));
  const variants: OrchestrationV2UnitComponentPlan['type'][][] = [
    ['html', 'la_diagram', 'problem', 'la_faq'], ['html', 'la_sortable', 'la_crossword'],
  ];
  for (const types of variants) {
    const componentPlan = types.map((type, index) => ({ ...base.component_plan[0]!, type,
      component_plan_id: `cp2_${String(index + 1).padStart(32, '0')}`,
      source_fact_ids: index === 0 ? [...evidenceIds] : [],
      supporting_evidence_fact_ids: index === 0 ? [] : [...evidenceIds],
      title: `${type} fallback`, purpose: type === 'problem' ? 'assess' as const
        : type === 'la_sortable' ? 'sequence' as const : type === 'la_diagram' ? 'relationship' as const
          : type === 'la_crossword' ? 'terminology' as const : type === 'la_faq' ? 'clarify' as const : 'explain' as const }));
    const contractBase = { ...base, unit_source_fact_ids: evidenceIds,
      source_facts: evidenceFacts, component_plan: componentPlan };
    const { contract_hash: _oldHash, ...withoutHash } = contractBase;
    const contract = { ...withoutHash, contract_hash: orchestrationV2Hash(withoutHash) };
    const out = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.orchestration_v2_unit_fallback_bridge'], {
      cwd: root, input: JSON.stringify({ contract, locale: 'vi' }), encoding: 'utf8', timeout: 20_000,
      maxBuffer: 4_000_000,
    });
    assert.equal(out.status, 0, out.error?.message ?? out.stderr);
    const fallbackUnit = JSON.parse(out.stdout);
    const response = readOrchestrationV2UnitProviderResponse({ contract_version: 2,
      source_snapshot_hash: contract.source_snapshot_hash, unit_path: contract.unit_path,
      unit: fallbackUnit, usage_complete: true, usage_source: 'deterministic_fallback', usage: {},
      content_origin: 'structured_fallback', quality_state: 'review_required' }, contract);
    const normalized = normalizeLessonAuthorProposal({ chapters: [{ title: contract.chapter_title,
      lessons: [{ title: contract.lesson_title, units: [fallbackUnit] }] }] });
    assert.deepEqual(new Set(normalized.chapters[0]?.lessons[0]?.units[0]?.components
      ?.map(component => component.metadata?.component_plan_id)),
    new Set(componentPlan.map(plan => plan.component_plan_id)),
    `fallback normalization lost an instance for ${types.join(',')}`);
    const publication = acceptOrchestrationV2GeneratedUnit({ contract, response,
      normalizeProposal: normalizeLessonAuthorProposal, allowed: new Set<CourseComponentType>(types) });
    assert.deepEqual(publication.generated_unit.components.map(component => component.type), types);
    assert.equal(publication.content_origin, 'structured_fallback');
    assert.equal(publication.quality_state, 'review_required');
  }
});

test('density-v3 Python fallback preserves supporting-only interaction evidence through Node acceptance', async t => {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorProposal } = await import('./chat.service.js');
  const root = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolveAiRagDevPython(root);
  const { assembly: baseAssembly, sourceFacts: baseFacts } = fixture();
  const assembly = structuredClone(baseAssembly);
  assembly.architecture.chapters[0]!.lessons[0]!.units[0]!.component_plan.push({
    type: 'problem', title: 'Check', rationale: 'Assess the taught facts', source_scope_ids: ['scope-1'],
  });
  const evidenceTexts = [
    'Row 1: Hazard | Approved control',
    'Row 2: Heat | Install a physical guard before work starts',
    'Câu hỏi: Biện pháp nào được nguồn phê duyệt cho mối nguy nhiệt?',
    'A. Lắp tấm chắn vật lý trước khi bắt đầu công việc',
    'B. Bỏ qua mối nguy khi thời gian hạn chế',
    'C. Chờ sự cố xảy ra rồi mới kiểm soát',
    'Đáp án: A',
    'Giải thích: Bảng nguồn chỉ định tấm chắn vật lý là biện pháp kiểm soát được phê duyệt.',
  ];
  const sourceFacts = evidenceTexts.map((fact_text, index) => ({ ...baseFacts[0]!,
    fact_key: `fact-${index + 1}`, fact_text,
    locator: {
    ...baseFacts[0]!.locator, instructional_density_policy_version: 'unit-content-v3-density-1',
    content_kinds: ['table'], table_count: 1,
  } }));
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly,
    unit_path: 'chapter_1.lesson_1.unit_1', source_facts: sourceFacts });
  assert.deepEqual(contract.component_plan[0]!.required_artifacts, [{ type: 'table', minimum_items: 2 }]);
  const out = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.orchestration_v2_unit_fallback_bridge'], {
    cwd: root, input: JSON.stringify({ contract, locale: 'vi' }), encoding: 'utf8', timeout: 20_000,
    maxBuffer: 4_000_000,
  });
  assert.equal(out.status, 0, out.error?.message ?? out.stderr);
  const fallbackUnit = JSON.parse(out.stdout);
  const response = readOrchestrationV2UnitProviderResponse({ contract_version: 2,
    source_snapshot_hash: contract.source_snapshot_hash, unit_path: contract.unit_path,
    unit: fallbackUnit, usage_complete: true, usage_source: 'deterministic_fallback', usage: {},
    content_origin: 'structured_fallback', quality_state: 'review_required' }, contract);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response,
    normalizeProposal: normalizeLessonAuthorProposal,
    allowed: new Set<CourseComponentType>(['html', 'problem']) });
  const interaction = publication.generated_unit.components[1]!;
  assert.deepEqual(interaction.metadata?.source_fact_ids, []);
  assert.deepEqual(interaction.metadata?.covered_source_fact_ids, []);
  assert.deepEqual(interaction.metadata?.supporting_evidence_fact_ids,
    evidenceTexts.map((_text, index) => `fact-${index + 1}`));
  assert.equal(publication.content_origin, 'structured_fallback');
  assert.equal(publication.quality_state, 'review_required');
});

test('CP2A frozen reviewer candidates survive Python schema/binding and the production Node adapter', async t => {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorProposal } = await import('./chat.service.js');
  const root = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolveAiRagDevPython(root);
  const out = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.cp2a_boundary_replay_bridge'], {
    cwd: root, input: '{}', encoding: 'utf8', timeout: 20_000, maxBuffer: 8_000_000,
  });
  assert.equal(out.status, 0, out.error?.message ?? out.stderr);
  const replay = JSON.parse(out.stdout) as { results: Array<{
    case_id: string; status: string; first_failing_boundary: string | null; classification: string;
    code: string | null; contract: OrchestrationV2UnitGenerationContract;
    unit: Record<string, unknown> & { components: unknown[] } | null;
  }> };
  const accepted = replay.results.filter(result => result.status === 'accepted');
  assert.deepEqual(accepted.map(result => result.case_id), [
    'text_valid', 'table_valid', 'procedure_valid', 'quiz_valid',
  ]);

  for (const result of accepted) {
    assert.ok(result.unit, result.case_id);
    const response = readOrchestrationV2UnitProviderResponse({
      contract_version: 2, source_snapshot_hash: result.contract.source_snapshot_hash,
      unit_path: result.contract.unit_path, unit: result.unit,
      usage_complete: true, usage_source: 'provider',
      content_origin: 'provider_validated', quality_state: 'validated',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, attempt_trace: [],
    }, result.contract);
    const allowed = new Set<CourseComponentType>(result.contract.component_plan.map(plan => plan.type));
    const publication = acceptOrchestrationV2GeneratedUnit({
      contract: result.contract, response, normalizeProposal: normalizeLessonAuthorProposal, allowed,
    });
    assert.deepEqual(publication.generated_unit.components.map(component => component.type),
      result.contract.component_plan.map(plan => plan.type), result.case_id);
    const html = publication.generated_unit.components.find(component => component.type === 'html')?.data;
    assert.equal(typeof html, 'string', result.case_id);
    if (result.case_id === 'table_valid') assert.match(String(html), /<table>/i);
    if (result.case_id === 'procedure_valid') assert.match(String(html), /<ol>/i);
    if (result.case_id === 'quiz_valid') {
      const problem = publication.generated_unit.components.find(component => component.type === 'problem');
      assert.ok(problem);
    }
  }

  const invalidQuiz = replay.results.find(result => result.case_id === 'quiz_invalid_short_text');
  assert.equal(invalidQuiz?.first_failing_boundary, 'provider_wire_schema');
  assert.equal(invalidQuiz?.classification, 'candidate_invalid');
  assert.equal(invalidQuiz?.code, 'PROVIDER_WIRE_SCHEMA_REJECTED');
  const image = replay.results.find(result => result.case_id === 'image_situation_missing_asset');
  assert.equal(image?.status, 'inconclusive');
  assert.equal(image?.first_failing_boundary, 'writer_input_assembly');
  assert.equal(image?.classification, 'input_missing');
});

test('unit service persists dispatch before exactly one provider call and one completion', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000001', run_id: '00000000-0000-4000-8000-000000000002',
    workspace_id: '00000000-0000-4000-8000-000000000003', tenant_id: '00000000-0000-4000-8000-000000000004',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000005',
    contract_hash: hash('task-contract'), input_context_hash: hash('task-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000006', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000007', dispatch_epoch: 1,
    routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const events: string[] = [];
  const repository = { load: async () => { events.push('load'); return { authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000008', conversation_id: '00000000-0000-4000-8000-000000000009',
    correlation_id: '00000000-0000-4000-8000-000000000010', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000011',
      kb_id: '00000000-0000-4000-8000-000000000008', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }; }, complete: async (_lease: unknown, publication: { nodes: unknown[] }) => {
      events.push(`complete:${publication.nodes.length}`);
    } };
  const worker = { markProviderDispatched: async () => { events.push('dispatch'); } };
  let receivedWorkflowBudget = 0, receivedTransportTimeout = 0;
  const client = { generate: async (request: { remaining_workflow_budget_ms: number }, execution: { timeoutMs: number; beforeProviderDispatch?: () => Promise<void> }) => {
    receivedWorkflowBudget = request.remaining_workflow_budget_ms;
    receivedTransportTimeout = execution.timeoutMs;
    await execution.beforeProviderDispatch?.();
    events.push('provider');
    return response;
  } };
  const normalizeProposal = (raw: unknown): LessonAuthorProposal => ({ summary: 'Unit generation',
    chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
  const settleProvider = async () => undefined;
  const releaseUndispatched = async () => undefined;
  assert.equal(await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']), unit_soft_deadline_ms: 45_000 }, normalizeProposal,
    settleProvider as never, releaseUndispatched as never, new AbortController().signal), 'generate_unit');
  assert.deepEqual(events, ['load', 'dispatch', 'provider', 'complete:2']);
  assert.equal(receivedWorkflowBudget, 45_000);
  assert.equal(receivedTransportTimeout, 55_000);
});

test('unit service retries a rolled-back completion transaction without calling the provider again', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000201', run_id: '00000000-0000-4000-8000-000000000202',
    workspace_id: '00000000-0000-4000-8000-000000000203', tenant_id: '00000000-0000-4000-8000-000000000204',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000205',
    contract_hash: hash('retry-task-contract'), input_context_hash: hash('retry-task-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000206', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000207', dispatch_epoch: 1,
    routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  let providerCalls = 0;
  let completionAttempts = 0;
  const repository = { load: async () => ({ authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000208', conversation_id: '00000000-0000-4000-8000-000000000209',
    correlation_id: '00000000-0000-4000-8000-000000000210', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000211',
      kb_id: '00000000-0000-4000-8000-000000000208', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }), complete: async () => {
      completionAttempts += 1;
      if (completionAttempts === 1) throw Object.assign(new Error('safe test deadlock'), { code: '40P01' });
    } };
  const worker = { markProviderDispatched: async () => undefined };
  const client = { generate: async (_request: unknown, execution: { beforeProviderDispatch?: () => Promise<void> }) => {
    await execution.beforeProviderDispatch?.();
    providerCalls += 1;
    return response;
  } };
  await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']) },
    (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    (async () => undefined) as never, (async () => undefined) as never, new AbortController().signal);
  assert.equal(providerCalls, 1);
  assert.equal(completionAttempts, 2);
});

test('unit durable retry is fallback-only and never dispatches a second paid provider call', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse({ ...responseWire,
    usage_complete: true, usage_source: 'deterministic_fallback', usage: {} }, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000101', run_id: '00000000-0000-4000-8000-000000000102',
    workspace_id: '00000000-0000-4000-8000-000000000103', tenant_id: '00000000-0000-4000-8000-000000000104',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000105',
    contract_hash: hash('retry-contract'), input_context_hash: hash('retry-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000106', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000107', dispatch_epoch: 2,
    provider_replay_required: true, routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const events: string[] = [];
  const repository = { load: async () => ({ authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000108', conversation_id: '00000000-0000-4000-8000-000000000109',
    correlation_id: '00000000-0000-4000-8000-000000000110', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000111',
      kb_id: '00000000-0000-4000-8000-000000000108', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }), complete: async (...args: unknown[]) => {
      events.push(`complete:${String(args[5])}`);
    } };
  const worker = { markProviderDispatched: async () => { events.push('dispatch'); } };
  const client = { generate: async (request: { fallback_only: boolean }) => {
    events.push(`generate:${String(request.fallback_only)}`); return response;
  } };
  await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client as never,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']) },
    (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    (async () => undefined) as never, (async () => undefined) as never, new AbortController().signal);
  assert.deepEqual(events, ['generate:true', 'complete:deterministic_fallback']);
});

test('unit pre-dispatch durable retry still performs its first paid provider call', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const lease = { task_id: '00000000-0000-4000-8000-000000000301', run_id: '00000000-0000-4000-8000-000000000302',
    workspace_id: '00000000-0000-4000-8000-000000000303', tenant_id: '00000000-0000-4000-8000-000000000304',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000305',
    contract_hash: hash('pre-dispatch-retry-contract'), input_context_hash: hash('pre-dispatch-retry-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000306', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000307', dispatch_epoch: 2,
    provider_replay_required: false, routing_shard: 0, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const events: string[] = [];
  const repository = { load: async () => ({ authority: { tenant_id: lease.tenant_id,
    kb_id: '00000000-0000-4000-8000-000000000308', conversation_id: '00000000-0000-4000-8000-000000000309',
    correlation_id: '00000000-0000-4000-8000-000000000310', locale: 'vi' as const,
    source_documents: [{ document_id: '00000000-0000-4000-8000-000000000311',
      kb_id: '00000000-0000-4000-8000-000000000308', name: 'source.pdf', type: 'pdf', status: 'learned' }] },
    contract }), complete: async (...args: unknown[]) => { events.push(`complete:${String(args[5])}`); } };
  const worker = { markProviderDispatched: async () => { events.push('dispatch'); } };
  const client = { generate: async (request: { fallback_only: boolean },
    execution: { beforeProviderDispatch?: () => Promise<void> }) => {
    events.push(`generate:${String(request.fallback_only)}`);
    await execution.beforeProviderDispatch?.();
    return response;
  } };
  await executeOrchestrationV2UnitTask(lease, repository as never, worker as never, client as never,
    { embedding_model: 'text-embedding', embedding_dimensions: 768,
      allowed_component_types: new Set<CourseComponentType>(['html']) },
    (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    (async () => undefined) as never, (async () => undefined) as never, new AbortController().signal);
  assert.deepEqual(events, ['generate:false', 'dispatch', 'complete:provider']);
});

test('unit service fails closed before load/provider when runtime is invalid', async () => {
  let called = false;
  await assert.rejects(() => executeOrchestrationV2UnitTask({} as OrchestrationV2TaskLease,
    { load: async () => { called = true; throw new Error('must not load'); } } as never,
    {} as never, { generate: async () => { called = true; throw new Error('must not call'); } },
    { embedding_model: '', embedding_dimensions: 0, allowed_component_types: new Set() },
    (() => ({ summary: '', chapters: [] })) as never, (async () => undefined) as never,
    (async () => undefined) as never,
    new AbortController().signal), { code: 'ORCHESTRATION_V2_UNIT_RUNTIME_INVALID' });
  assert.equal(called, false);
});

test('unit completion writes all revision-zero baselines and only then unlocks chapter validation', async () => {
  const { contract, responseWire } = fixture();
  const response = readOrchestrationV2UnitProviderResponse(responseWire, contract);
  const publication = acceptOrchestrationV2GeneratedUnit({ contract, response,
    normalizeProposal: (raw): LessonAuthorProposal => ({ summary: 'Unit generation',
      chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters }),
    allowed: new Set<CourseComponentType>(['html']) });
  const lease = { task_id: '00000000-0000-4000-8000-000000000021', run_id: '00000000-0000-4000-8000-000000000022',
    workspace_id: '00000000-0000-4000-8000-000000000023', tenant_id: '00000000-0000-4000-8000-000000000024',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000025',
    contract_hash: hash('task-contract'), input_context_hash: hash('task-input'),
    source_snapshot_id: '00000000-0000-4000-8000-000000000026', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000027', dispatch_epoch: 1,
    routing_shard: 3, ai_reservation_id: null } as OrchestrationV2TaskLease;
  const componentId = '00000000-0000-4000-8000-000000000028';
  const queries: string[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string) {
    queries.push(sql);
    let rows: Array<Record<string, unknown>> = [];
    if (sql.includes('FROM lesson_author_workspace_nodes WHERE')) rows = [
      { id: lease.node_id, canonical_path: publication.nodes[0]!.path, kind: 'unit', content_state: 'planned', current_revision: null },
      { id: componentId, canonical_path: publication.nodes[1]!.path, kind: 'component', content_state: 'planned', current_revision: null },
    ];
    else if (sql.includes('INSERT INTO lesson_author_workspace_revisions')) rows = [
      { node_id: lease.node_id, revision: 0 }, { node_id: componentId, revision: 0 },
    ];
    else if (sql.includes('INSERT INTO lesson_author_workspace_events')) rows = [{ sequence: 1 }];
    else if (sql.includes("candidate.kind='validate_chapter'")) rows = [{ id: '00000000-0000-4000-8000-000000000029' }];
    else if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) rows = [
      { id: '00000000-0000-4000-8000-000000000030' },
    ];
    else assert.fail(`unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    return work(tx);
  } };
  const captured: { artifact: { artifact_kind: string; payload: Record<string, unknown> } | null } = {
    artifact: null,
  };
  const worker = { succeed: async (...args: unknown[]) => {
    captured.artifact = args[4] as { artifact_kind: string; payload: Record<string, unknown> };
    const hooks = args[6] as { beforeSuccess(tx: GenerationJobSql): Promise<void>;
      afterSuccess(tx: GenerationJobSql): Promise<void> };
    await hooks.beforeSuccess(tx); await hooks.afterSuccess(tx);
  } };
  const repository = createOrchestrationV2UnitRepository(db, worker as never,
    () => '00000000-0000-4000-8000-000000000030');
  await repository.complete(lease, publication, response.usage ?? {},
    (async () => undefined) as never, (async () => undefined) as never, 'provider');
  assert.equal(captured.artifact?.artifact_kind, 'unit_baseline');
  assert.equal(captured.artifact?.payload.content_origin, publication.content_origin);
  assert.equal(captured.artifact?.payload.quality_state, publication.quality_state);
  assert.ok(queries.findIndex(sql => sql.includes('INSERT INTO lesson_author_workspace_revisions'))
    < queries.findIndex(sql => sql.includes("candidate.kind='validate_chapter'")));
  assert.equal(queries.filter(sql => sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')).length, 1);
});

test('unit repository reloads exact authority, architecture, inventory and source facts under the live lease', async () => {
  const { assembly, sourceFacts, contract } = fixture();
  const inventoryHash = hash('inventory');
  const unitContractHash = hash('unit-node-contract');
  const lease = { task_id: '00000000-0000-4000-8000-000000000041', run_id: '00000000-0000-4000-8000-000000000042',
    workspace_id: '00000000-0000-4000-8000-000000000043', tenant_id: '00000000-0000-4000-8000-000000000044',
    course_id: 'course-v1:test+1+2026', task_key: 'content:chapter-1:unit:1', kind: 'generate_unit',
    chapter_key: 'chapter-1', node_id: '00000000-0000-4000-8000-000000000045',
    contract_hash: hash('task-contract'), input_context_hash: '',
    source_snapshot_id: '00000000-0000-4000-8000-000000000046', source_snapshot_hash: contract.source_snapshot_hash,
    model: 'test-model', locale: 'vi', max_output_tokens: 4_000, provider_max_attempts: 1,
    execution_budget_ms: 60_000, lease_token: '00000000-0000-4000-8000-000000000047', dispatch_epoch: 1,
    routing_shard: 3, ai_reservation_id: '00000000-0000-4000-8000-000000000048' } as OrchestrationV2TaskLease;
  lease.input_context_hash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash, inventory_hash: inventoryHash,
    node_id: lease.node_id, contract_hash: unitContractHash, source_scope_ids: ['scope-1'] });
  const componentContract = { component_type: 'html', metadata: {
    component_plan_id: contract.component_plan[0]!.component_plan_id, source_scope_ids: ['scope-1'] } };
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    seen.push({ sql, params });
    let rows: Array<Record<string, unknown>> = [];
    if (sql.includes('SELECT w.kb_id::text')) rows = [{
      kb_id: '00000000-0000-4000-8000-000000000049',
      conversation_id: '00000000-0000-4000-8000-000000000050',
      correlation_id: '00000000-0000-4000-8000-000000000051', content_locale: 'vi',
      source_document_ids: ['00000000-0000-4000-8000-000000000011'], canonical_path: contract.unit_path,
      node_contract_hash: unitContractHash, content_state: 'planned', current_revision: null,
      task_key: lease.task_key,
    }];
    else if (sql.includes('FROM kb_documents')) rows = [{ document_id: '00000000-0000-4000-8000-000000000011',
      kb_id: '00000000-0000-4000-8000-000000000049', name: 'source.pdf', type: 'pdf', status: 'learned' }];
    else if (sql.includes('FROM lesson_author_workspace_v2_artifacts a')) rows = [
      { artifact_kind: 'architecture_validation', artifact_hash: assembly.assembly_hash, payload: assembly },
      { artifact_kind: 'inventory_receipt', artifact_hash: hash('inventory-receipt'),
        payload: { inventory_hash: inventoryHash } },
    ];
    else if (sql.includes('FROM lesson_author_workspace_source_facts')) {
      rows = sourceFacts as unknown as Array<Record<string, unknown>>;
    }
    else if (sql.includes("parent_id=$4 AND kind='component'")) rows = [{
      id: '00000000-0000-4000-8000-000000000052', canonical_path: `${contract.unit_path}.component_1`,
      sort_order: 0, protected_contract: componentContract, contract_hash: orchestrationV2Hash(componentContract),
      content_state: 'planned', current_revision: null,
    }];
    else assert.fail(`unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    return work(tx);
  } };
  const loaded = await createOrchestrationV2UnitRepository(db, {} as never).load(lease);
  assert.equal(loaded.contract.contract_hash, contract.contract_hash);
  assert.deepEqual(loaded.contract.unit_source_fact_ids, ['fact-1', 'fact-2']);
  const factQuery = seen.find(query => query.sql.includes('FROM lesson_author_workspace_source_facts'));
  assert.deepEqual(factQuery?.params[4], ['scope-1']);
  assert.ok(seen[0]!.sql.includes('lease_expires_at>clock_timestamp()'));
});
