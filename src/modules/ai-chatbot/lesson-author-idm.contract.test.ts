import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDM_SINGLE_TASK_MAX_SOURCE_CHARS,
  boundIdmRemainingBudgetMs,
  buildIdmCourseSkeletonRequest,
  idmBlockScopeKey,
  idmHash,
  idmTextLength,
  readIdmCourseDesign,
  readIdmShardDesign,
  readIdmUnitBrief,
  readIdmUnitQuality,
  sealIdmUnitBrief,
  idmDesignHash,
  type IdmCourseDesignV1,
  type IdmShardDesignV1,
  type IdmUnitBriefV1,
  type IdmUnitQualityV1,
} from './lesson-author-idm.contract.js';
import { assertIdmCourseDesignInvariants, planIdmChapterShards } from './lesson-author-idm-scope-view.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { readOrchestrationV2CourseSkeletonResponse } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { ORCHESTRATION_V2_IDM_EXECUTION_POLICY } from './lesson-author-orchestration-v2-execution.config.js';
import {
  IDM_FIXTURE_DOCUMENT_ID,
  IDM_PYTHON_AVAILABLE,
  idmFixture,
  idmGoldenCourseDesign,
  idmGoldenSource,
  rehashIdmDesign,
} from './lesson-author-idm.fixture.js';

type Mutable = Record<string, any>;

function invalidAt(path: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'IDM_CONTRACT_INVALID');
    assert.equal((error as { path?: string }).path, path);
    return true;
  };
}

function mutated(change: (design: Mutable) => void, rehash = true): IdmCourseDesignV1 {
  const design = structuredClone(idmFixture().design) as Mutable;
  change(design);
  return rehash ? rehashIdmDesign(design as IdmCourseDesignV1) : design as IdmCourseDesignV1;
}

test('course design reader accepts the exact Python wire shape and returns an equal value', () => {
  const { design } = idmFixture();
  const parsed = readIdmCourseDesign(JSON.parse(JSON.stringify(design)));
  assert.deepEqual(parsed, design);
  assert.equal(parsed.design_hash, idmHash(Object.fromEntries(Object.entries(design)
    .filter(([key]) => key !== 'design_hash'))));
});

test('course design reader rejects extra, missing and mistyped fields with IDM_CONTRACT_INVALID', () => {
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.extra = 1; })), invalidAt('idm'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { delete design.notes; })), invalidAt('idm'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].debug = true; })),
    invalidAt('idm.blocks[0]'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.modules[0].lessons[0].est_minutes = 2.5; })),
    invalidAt('idm.modules[0].lessons[0].est_minutes'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.modules[0].lessons[0].est_minutes = true; })),
    invalidAt('idm.modules[0].lessons[0].est_minutes'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.idm_contract_version = true; })),
    invalidAt('idm.idm_contract_version'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.pipeline_version = 'v2-legacy'; })),
    invalidAt('idm.pipeline_version'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].intent = 'Know'; })),
    invalidAt('idm.blocks[0].intent'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].support_role = undefined; })),
    invalidAt('idm.blocks[0].support_role'));
  assert.throws(() => readIdmCourseDesign(null), invalidAt('idm'));
  assert.throws(() => readIdmCourseDesign([]), invalidAt('idm'));
});

test('course design reader enforces Python bounds, patterns and stripped strings', () => {
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.learning_objectives[0].statement = 'Too short'; })),
    invalidAt('idm.learning_objectives[0].statement'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.modules[0].lessons[0].est_screens = 31; })),
    invalidAt('idm.modules[0].lessons[0].est_screens'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].block_id = 'cb_1'; })),
    invalidAt('idm.blocks[0].block_id'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.block_scopes[0].scope_key = 'scope3_00'; })),
    invalidAt('idm.block_scopes[0].scope_key'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].name = ' Khối có khoảng trắng'; })),
    invalidAt('idm.blocks[0].name'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].name = 'Khối\u0085'; })),
    invalidAt('idm.blocks[0].name'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.blocks[0].summary = ''; })),
    invalidAt('idm.blocks[0].summary'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.modules = []; })), invalidAt('idm.modules'));
  assert.throws(() => readIdmCourseDesign(mutated(design => {
    design.project_context.learning_objectives = Array.from({ length: 9 }, (_, index) => `Mục tiêu ${index}`);
  })), invalidAt('idm.project_context.learning_objectives'));
  // pydantic strips Unicode White_Space only; U+FEFF and U+001C survive and are therefore legal edges.
  assert.doesNotThrow(() => readIdmCourseDesign(mutated(design => { design.blocks[0].name = '﻿Khối'; })));
  assert.doesNotThrow(() => readIdmCourseDesign(mutated(design => { design.blocks[0].name = 'Khối\u001c'; })));
  // Nullable strings without a minimum accept the empty string, exactly like Python.
  assert.doesNotThrow(() => readIdmCourseDesign(mutated(design => { design.dispositions[0].reason = ''; })));
});

test('lengths are counted in Unicode code points like Python len', () => {
  const astral = `${'a'.repeat(499)}\u{1F600}`;
  assert.equal(astral.length, 501);
  assert.equal(idmTextLength(astral), 500);
  assert.doesNotThrow(() => readIdmCourseDesign(mutated(design => { design.learning_objectives[0].statement = astral; })));
  assert.throws(() => readIdmCourseDesign(mutated(design => {
    design.learning_objectives[0].statement = `${astral}b`;
  })), invalidAt('idm.learning_objectives[0].statement'));
});

test('course design reader verifies design_hash over the design without design_hash', () => {
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.design_hash = 'f'.repeat(64); }, false)),
    invalidAt('idm.design_hash'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.notes.course = 'Đã sửa'; }, false)),
    invalidAt('idm.design_hash'));
  assert.throws(() => readIdmCourseDesign(mutated(design => { design.design_hash = 'F'.repeat(64); }, false)),
    invalidAt('idm.design_hash'));
});

function sealShard<T extends object>(design: T): T {
  return { ...design, design_hash: idmDesignHash(design) };
}

function shardDesign(): IdmShardDesignV1 {
  return sealShard({
    pipeline_version: 'idm-1' as const, chapter_key: 'chapter-1', shard_index: 0, lesson_index_offset: 0,
    stage_origin: 'provider', design_hash: 'a'.repeat(64),
    lessons: [{
      lesson_key: 'lsn_001', title: 'Phân loại khiếu nại', objective: 'Phân loại khiếu nại theo nhóm',
      learning_objectives: ['Phân loại đúng nhóm khiếu nại'], assessment: 'Bài tình huống phân loại.',
      notes: 'Ghi chú mục.',
      practice_tasks: [{ practice_id: 'pt_1', sentence: 'Cho một khiếu nại, người học phân loại để xử lý đúng.',
        context_input: 'Một khiếu nại', learner_action: 'Phân loại', result: 'Nhóm đúng', bloom: 'apply',
        criteria_fact_keys: ['d1-c3-f2'], scenario_origin: 'ai_drafted', hold: false, hold_question: null,
        feedback_focus: { criterion: 'Đúng nhóm', rationale: 'Theo bảng phân loại', improvement: 'Đối chiếu bảng' } }],
      units: [{ unit_index: 1, segment: 'practice_feedback', title: 'Luyện tập phân loại',
        purpose: 'Người học phân loại được khiếu nại.', block_ids: ['cb_0004'],
        components: [{ component_index: 1, type: 'problem', role: 'practice', title: 'Tình huống phân loại',
          rationale: 'Luyện tập Must Do.', block_ids: ['cb_0004'], practice_id: 'pt_1',
          support_items: [{ kind: 'worked_example', brief: 'Ví dụ phân loại mẫu.', block_id: 'cb_0004' }],
          author_review: { purpose: 'Kiểm tra phân loại', example_scenario: null, visual_asset: null,
            user_behavior_navigation: null } }],
        media_brief: { type: 'static_infographic', title: 'Sơ đồ nhóm khiếu nại', content_points: ['Năm nhóm'],
          context_description: 'Tổng hợp nhóm.', rationale: 'Hỗ trợ ghi nhớ.' } }],
    }],
  } as IdmShardDesignV1);
}

test('shard design reader mirrors nested V2 author review and media brief semantics', () => {
  const shard = shardDesign();
  assert.deepEqual(readIdmShardDesign(JSON.parse(JSON.stringify(shard))), shard);
  const change = (edit: (value: Mutable) => void) => {
    const copy = structuredClone(shard) as Mutable;
    edit(copy);
    return sealShard(copy);
  };
  const component = 'idm_design.lessons[0].units[0].components[0]';
  // Python module_design: design_hash = canonical hash of the shard design without design_hash.
  assert.throws(() => readIdmShardDesign({ ...shard, design_hash: 'a'.repeat(64) }), invalidAt('idm_design.design_hash'));
  assert.throws(() => readIdmShardDesign({ ...shard, shard_index: 1 }), invalidAt('idm_design.design_hash'));
  assert.throws(() => readIdmShardDesign(change(value => { value.lessons[0].units[0].components[0].author_review.extra = null; })),
    invalidAt(`${component}.author_review`));
  // ArchitectureComponentAuthorReviewV2 normalises blank text to null, so a blank string never reaches Node.
  assert.throws(() => readIdmShardDesign(change(value => {
    value.lessons[0].units[0].components[0].author_review.visual_asset = '   ';
  })), invalidAt(`${component}.author_review.visual_asset`));
  assert.throws(() => readIdmShardDesign(change(value => { value.lessons[0].units[0].components[0].practice_id = 'pt_0'; })),
    invalidAt(`${component}.practice_id`));
  assert.throws(() => readIdmShardDesign(change(value => { value.lessons[0].units[0].components[0].component_index = 5; })),
    invalidAt(`${component}.component_index`));
  assert.throws(() => readIdmShardDesign(change(value => { value.lessons[0].units[0].media_brief.content_points = [' ']; })),
    invalidAt('idm_design.lessons[0].units[0].media_brief.content_points[0]'));
  // ArchitectureMediaBriefV2 is not an IDM model: its raw strings are not stripped by Python.
  assert.doesNotThrow(() => readIdmShardDesign(change(value => { value.lessons[0].units[0].media_brief.title = ' Sơ đồ '; })));
  assert.throws(() => readIdmShardDesign(change(value => { value.lessons[0].practice_tasks[0].hold = 'false'; })),
    invalidAt('idm_design.lessons[0].practice_tasks[0].hold'));
  assert.throws(() => readIdmShardDesign(change(value => { value.lesson_index_offset = -1; })),
    invalidAt('idm_design.lesson_index_offset'));
  assert.throws(() => readIdmShardDesign(change(value => { value.idm_design = {}; })), invalidAt('idm_design'));
});

test('unit quality reader is strict about enums, counts and deterministic codes', () => {
  const quality: IdmUnitQualityV1 = { judge_mode: 'observe', judge_status: 'review_required',
    finding_counts: { minor: 1, major: 0, critical: 0 }, criteria: { Q1_support_sufficient: 'pass', Q4_feedback_teaches: 'minor' },
    repair_applied: false, deterministic_codes: ['IDM_W5_CONTEXT_OVERWEIGHT'], author_note: '' };
  assert.deepEqual(readIdmUnitQuality(JSON.parse(JSON.stringify(quality))), quality);
  assert.throws(() => readIdmUnitQuality({ ...quality, criteria: { Q10_unknown: 'pass' } }),
    invalidAt('idm_quality.criteria{Q10_unknown}'));
  assert.throws(() => readIdmUnitQuality({ ...quality, criteria: { Q2_not_copied: 'fatal' } }),
    invalidAt('idm_quality.criteria.Q2_not_copied'));
  assert.throws(() => readIdmUnitQuality({ ...quality, deterministic_codes: ['idm_lower'] }),
    invalidAt('idm_quality.deterministic_codes[0]'));
  assert.throws(() => readIdmUnitQuality({ ...quality, finding_counts: { minor: 0, major: 0, critical: 0, info: 0 } }),
    invalidAt('idm_quality.finding_counts'));
  assert.throws(() => readIdmUnitQuality({ ...quality, finding_counts: { minor: 1_001, major: 0, critical: 0 } }),
    invalidAt('idm_quality.finding_counts.minor'));
  assert.throws(() => readIdmUnitQuality({ ...quality, author_note: 'x'.repeat(1_501) }),
    invalidAt('idm_quality.author_note'));
  assert.throws(() => readIdmUnitQuality({ ...quality, judge_mode: 'strict' }), invalidAt('idm_quality.judge_mode'));
});

test('unit brief is sealed with a canonical brief_hash and tampering is rejected', () => {
  const unsealed: Omit<IdmUnitBriefV1, 'brief_hash'> = {
    pipeline_version: 'idm-1', course_title: 'Xử lý khiếu nại', target_audience: 'Nhân viên CSKH',
    module_title: 'Phân loại', lesson_title: 'Phân loại khiếu nại', lesson_objective: 'Phân loại theo nhóm',
    lesson_practice_sentences: ['Cho một khiếu nại, người học phân loại để xử lý đúng.'],
    previous_lesson_title: null, next_lesson_title: 'Đánh giá mức độ', unit_segment: 'practice_feedback',
    unit_purpose: 'Phân loại được khiếu nại.', job_aid_signpost: null,
    components: [{ component_plan_id: `cp2_${'a'.repeat(32)}`, type: 'problem', role: 'practice',
      title: 'Tình huống', support_items: [], practice: shardDesign().lessons[0]!.practice_tasks[0]!,
      treatments: [{ block_id: 'cb_0004', treatment: 'keep', detail_level: 'Giữ nguyên bảng.' }],
      owned_fact_keys: ['d1-c3-f2'], supporting_fact_keys: [] }],
    lesson_context_facts: [{ fact_key: 'd1-c3-f1', fact_text: 'Khiếu nại về sản phẩm.' }],
  };
  const sealed = sealIdmUnitBrief(unsealed);
  assert.equal(sealed.brief_hash, idmHash(unsealed));
  assert.deepEqual(readIdmUnitBrief(JSON.parse(JSON.stringify(sealed))), sealed);
  assert.throws(() => readIdmUnitBrief({ ...sealed, unit_purpose: 'Đã sửa.' }), invalidAt('idm_unit_brief.brief_hash'));
  assert.throws(() => readIdmUnitBrief({ ...sealed, extra: true }), invalidAt('idm_unit_brief'));
  assert.throws(() => sealIdmUnitBrief({ ...unsealed, components: [] }), invalidAt('idm_unit_brief.components'));
  assert.throws(() => sealIdmUnitBrief({ ...unsealed, previous_lesson_title: undefined as never }),
    invalidAt('idm_unit_brief.previous_lesson_title'));
});

test('course skeleton request carries the exact Python shape, bounded budgets and capacity guard', () => {
  const { facts } = idmFixture();
  const request = buildIdmCourseSkeletonRequest({
    locale: 'vi', course_title: `  ${'Khoá '.repeat(150)}  `,
    source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, name: '  ', type: 'file' }],
    source_facts: facts, input_tokens: 1_800_000, max_output_tokens: 65_536, provider_max_attempts: 2,
    remaining_ms: 700_000,
  });
  assert.deepEqual(Object.keys(request).sort(),
    ['pipeline_version', 'project_context', 'remaining_budget_ms', 'source_facts', 'token_allowance']);
  assert.equal(request.pipeline_version, 'idm-1');
  assert.deepEqual(request.token_allowance, { input_tokens: 1_800_000, output_tokens: 131_072 });
  assert.equal(request.remaining_budget_ms, 600_000);
  assert.equal(idmTextLength(request.project_context.course_title_hint!), 499);
  assert.deepEqual(request.project_context.source_documents,
    [{ document_id: IDM_FIXTURE_DOCUMENT_ID, name: IDM_FIXTURE_DOCUMENT_ID, type: 'file' }]);
  assert.deepEqual({ ...request.project_context, course_title_hint: null, source_documents: [] }, {
    locale: 'vi', course_title_hint: null, source_documents: [], target_audience: null, learning_objectives: [],
    duration_target_minutes: null });
  assert.deepEqual(request.source_facts, facts);
  const lowBudgetRequest = { locale: 'vi' as const, course_title: null,
    source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, name: 'nguon.pdf', type: 'file' }], source_facts: facts,
    input_tokens: 1_800_000, max_output_tokens: 65_536, provider_max_attempts: 2 };
  // Python's 30 s floor is never granted past the lease: below it the task fails before dispatch.
  const lowBudget = buildIdmCourseSkeletonRequest({ ...lowBudgetRequest, remaining_ms: 45_000 });
  assert.equal(lowBudget.remaining_budget_ms, 30_000);
  for (const remaining_ms of [44_999, 20_000, 0, -1]) {
    assert.throws(() => buildIdmCourseSkeletonRequest({ ...lowBudgetRequest, remaining_ms }),
      { code: 'IDM_REMAINING_BUDGET_INSUFFICIENT' });
  }
  assert.throws(() => buildIdmCourseSkeletonRequest({ ...lowBudgetRequest, remaining_ms: Number.NaN }),
    invalidAt('idm.remaining_budget_ms'));
  assert.equal(lowBudget.project_context.course_title_hint, null);
  assert.equal(buildIdmCourseSkeletonRequest({ ...lowBudgetInput(facts), remaining_ms: 500_000 }).remaining_budget_ms,
    485_000);
  const huge = [{ ...facts[0]!, fact_key: 'huge-1', fact_text: 'x'.repeat(IDM_SINGLE_TASK_MAX_SOURCE_CHARS) },
    { ...facts[0]!, fact_key: 'huge-2', fact_text: 'y' }];
  assert.throws(() => buildIdmCourseSkeletonRequest({ ...lowBudgetInput(huge) }),
    { code: 'IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY' });
  assert.throws(() => buildIdmCourseSkeletonRequest({ ...lowBudgetInput([facts[0]!, facts[0]!]) }),
    invalidAt('idm.source_facts'));
  assert.throws(() => buildIdmCourseSkeletonRequest({ ...lowBudgetInput([{ ...facts[0]!, extra: 1 } as never]) }),
    invalidAt('idm.source_facts[0]'));
  assert.throws(() => buildIdmCourseSkeletonRequest({ ...lowBudgetInput(facts), max_output_tokens: 70_000 }),
    invalidAt('idm.token_allowance.output_tokens'));
});

test('IDM remaining budget never outlives the Node transport timeout', () => {
  assert.equal(boundIdmRemainingBudgetMs(585_000, 600_000), 585_000);
  assert.equal(boundIdmRemainingBudgetMs(585_000, 300_000), 285_000);
  assert.equal(boundIdmRemainingBudgetMs(585_000, 45_000), 30_000);
  // A transport timeout under Python's 30 s floor (+15 s margin) fails before dispatch.
  for (const timeout of [44_999, 20_000]) {
    assert.throws(() => boundIdmRemainingBudgetMs(585_000, timeout), { code: 'IDM_REMAINING_BUDGET_INSUFFICIENT' });
  }
});

function lowBudgetInput(facts: ReturnType<typeof idmFixture>['facts']) {
  return { locale: 'vi' as const, course_title: 'Khoá học', source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID,
    name: 'nguon.pdf', type: 'file' }], source_facts: facts, input_tokens: 1_800_000, max_output_tokens: 65_536,
  provider_max_attempts: 2, remaining_ms: 600_000 };
}

test('block scope key is the Python block_scope_key formula', () => {
  const key = idmBlockScopeKey('a'.repeat(64), 'cb_0001', ['f-2', 'f-10', 'f-1']);
  assert.match(key, /^idmcb_[0-9a-f]{32}$/);
  assert.equal(key, idmBlockScopeKey('a'.repeat(64), 'cb_0001', ['f-1', 'f-10', 'f-2']));
  assert.notEqual(key, idmBlockScopeKey('a'.repeat(64), 'cb_0002', ['f-1', 'f-10', 'f-2']));
});

test('Python golden course design parses in Node with hash, scope-key and invariant parity',
  { skip: IDM_PYTHON_AVAILABLE ? false : 'landa-ai-rag/.venv-dev is not available' }, () => {
    const golden = idmGoldenSource();
    for (const vector of golden.vectors) assert.equal(idmHash(vector.value), vector.hash);

    const scopes = [...new Set(golden.facts.map(fact => fact.scope_key))].map(scopeKey => {
      const owned = golden.facts.filter(fact => fact.scope_key === scopeKey);
      return { scope_key: scopeKey, title: scopeKey, source_ref: owned[0]!.source_ref, fact_count: owned.length,
        content_chars: owned.reduce((sum, fact) => sum + idmTextLength(fact.fact_text), 0) };
    });
    const idm = buildIdmCourseSkeletonRequest({ locale: 'vi', course_title: 'Xử lý khiếu nại khách hàng',
      source_documents: [{ document_id: golden.facts[0]!.document_id, name: 'quy-trinh-khieu-nai.pdf', type: 'file' }],
      source_facts: golden.facts, input_tokens: 1_800_000, max_output_tokens: 65_536, provider_max_attempts: 2,
      remaining_ms: 600_000 });
    const request = { tenant_id: '00000000-0000-4000-8000-000000000004', kb_id: '00000000-0000-4000-8000-000000000008',
      conversation_id: '00000000-0000-4000-8000-000000000009', target: 'lesson_author', model: 'gemini-3.8-flash',
      max_output_tokens: 65_536, embedding_model: 'gemini-embedding-001', embedding_dimensions: 768,
      system_prompt: 'Server-owned AI ID orchestration V2 contract.', user_message: 'Build the admitted course.',
      history: [], source_documents: [{ document_id: golden.facts[0]!.document_id,
        kb_id: '00000000-0000-4000-8000-000000000008', name: 'quy-trinh-khieu-nai.pdf', type: 'file', status: 'learned' }],
      course_context: null, locale: 'vi', correlation_id: '00000000-0000-4000-8000-000000000010',
      api_key: 'offline-test-key', contract_version: 2, source_snapshot_hash: golden.snapshot_hash,
      scope_catalog: scopes, source_authority: { mode: 'model_designed', source: 'none', complete: true, confidence: 0,
        structure_hash: 'e'.repeat(64), reason_codes: [], chapters: [] }, max_attempts: 2, idm };
    const { response, provider_calls: providerCalls } = idmGoldenCourseDesign(request);
    assert.equal(providerCalls, 4);
    const envelope = readOrchestrationV2CourseSkeletonResponse(response, golden.snapshot_hash);
    const design = readIdmCourseDesign(response.idm);
    assert.equal(design.design_hash, (response.idm as { design_hash: string }).design_hash);
    for (const scope of design.block_scopes) {
      assert.equal(scope.scope_key, idmBlockScopeKey(golden.snapshot_hash, scope.block_id, scope.fact_keys));
    }
    const view = assertIdmCourseDesignInvariants({ design, skeleton: envelope.skeleton,
      sourceSnapshotHash: golden.snapshot_hash, snapshotFacts: golden.facts.map(fact => ({
        fact_key: fact.fact_key, fact_chars: idmTextLength(fact.fact_text) })) });
    assert.deepEqual(view.dispositionCounts,
      { course: 36, reference_job_aid: 10, nice_to_know: 1, remove: 4, hold: 6, noise: 4 });
    assert.equal(design.project_context.course_title_hint, 'Xử lý khiếu nại khách hàng');
    const plan = planIdmChapterShards(envelope.skeleton, design, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning,
      orchestrationV2Hash({ skeleton: envelope.skeleton, idm: design }));
    assert.deepEqual(plan.chapter_tasks.map(task => [task.task_key, task.shard_plan?.source_scope_ids.length]), [
      ['architecture:chapter:chapter-1:shard:1', 3],
      ['architecture:chapter:chapter-2:shard:1', 2],
      ['architecture:chapter:chapter-3:shard:1', 5],
    ]);
    // A tampered design is rejected even if the envelope is otherwise valid.
    const tampered = structuredClone(response.idm) as Mutable;
    tampered.dispositions[0].disposition = 'course';
    assert.throws(() => readIdmCourseDesign(tampered), invalidAt('idm.design_hash'));
  });
