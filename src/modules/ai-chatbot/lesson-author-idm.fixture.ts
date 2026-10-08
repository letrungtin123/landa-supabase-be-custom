import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type {
  OrchestrationV2CourseSkeleton,
  OrchestrationV2SourceFact,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  idmBlockScopeKey,
  idmDesignHash,
  type IdmBlockScopeV1,
  type IdmBlueprintRowV1,
  type IdmContentBlockV1,
  type IdmCourseDesignV1,
  type IdmDispositionV1,
  type IdmModulePlanV1,
} from './lesson-author-idm.contract.js';

/** Synthetic offline IDM fixtures for tests; no customer content and no provider output. */

export const IDM_FIXTURE_SNAPSHOT_HASH = orchestrationV2Hash('idm-fixture-snapshot');
export const IDM_FIXTURE_DOCUMENT_ID = '00000000-0000-4000-8000-0000000000d1';

/** Module → lesson → block → fact text lengths. */
export type IdmFixtureShape = number[][][][];

export interface IdmFixture {
  design: IdmCourseDesignV1;
  skeleton: OrchestrationV2CourseSkeleton;
  facts: OrchestrationV2SourceFact[];
  snapshotFacts: Array<{ fact_key: string; fact_chars: number }>;
}

/** Recompute `design_hash` after a test mutates a design. */
export function rehashIdmDesign(design: IdmCourseDesignV1): IdmCourseDesignV1 {
  const copy = structuredClone(design);
  copy.design_hash = idmDesignHash(copy);
  return copy;
}

/**
 * Build a self-consistent IDM course design plus its projected skeleton. Every
 * block is a course block; one nice-to-know block, one held block and one noise
 * fact are appended to exercise dispositions outside the course.
 */
export function idmFixture(shape: IdmFixtureShape = [[[[120, 80]], [[200]]], [[[150], [90, 60]]]]): IdmFixture {
  const hash = IDM_FIXTURE_SNAPSHOT_HASH;
  const facts: OrchestrationV2SourceFact[] = [];
  const blocks: IdmContentBlockV1[] = [];
  const rows: IdmBlueprintRowV1[] = [];
  const dispositions: IdmDispositionV1[] = [];
  const scopes: IdmBlockScopeV1[] = [];
  const modules: IdmModulePlanV1[] = [];
  const addFact = (length: number) => {
    const key = `d1-c0-f${facts.length + 1}`;
    facts.push({ document_id: IDM_FIXTURE_DOCUMENT_ID, fact_key: key, scope_key: 'scope3_00',
      fact_text: 'x'.repeat(length), source_ref: 'src-0', source_page: 1, source_chunk: 0,
      locator: { source_evidence_status: 'ready', source_evidence_revision: orchestrationV2Hash('revision'),
        scope_title: 'Heading' } });
    return key;
  };
  const addBlock = (factLengths: number[], disposition: 'course' | 'nice_to_know' | 'hold', mustDo: string | null) => {
    const blockId = `cb_${String(blocks.length + 1).padStart(4, '0')}`;
    const factKeys = factLengths.map(addFact);
    blocks.push({ block_id: blockId, section_id: 'sec_001', name: `Khối nội dung ${blocks.length + 1}`,
      summary: 'Tóm tắt khối nội dung.', intent: 'do', support_role: null, content_kind: 'procedure',
      fact_keys: factKeys, issues: [], gaps: [], sme_questions: [], origin: 'provider' });
    const hold = disposition === 'hold';
    rows.push({ block_id: blockId, lo_id: 'lo_1', must_do_ids: mustDo ? [mustDo] : ['md_1'],
      classification: disposition === 'nice_to_know' ? 'nice_to_know' : 'must_do',
      placement: disposition === 'nice_to_know' ? 'excluded' : 'course',
      treatment: disposition === 'nice_to_know' ? 'remove' : 'condense', detail_level: 'Giữ phần cần thiết.',
      hold, hold_reason: hold ? 'Cần SME xác nhận.' : null, sme_question: hold ? 'Quy định nào đang áp dụng?' : null,
      combine_into: null, separate_into: [], rationale: 'Theo Must Do.' });
    for (const key of factKeys) dispositions.push({ fact_key: key, disposition, block_id: blockId, reason: null });
    if (disposition === 'course') {
      scopes.push({ scope_key: idmBlockScopeKey(hash, blockId, factKeys), block_id: blockId,
        title: `Khối nội dung ${blocks.length}`, source_ref: 'src-0', fact_count: factKeys.length,
        content_chars: Math.max(1, factLengths.reduce((sum, value) => sum + value, 0)), fact_keys: factKeys });
    }
    return blockId;
  };
  let lessonNumber = 0;
  shape.forEach((moduleShape, moduleIndex) => {
    const lessons = moduleShape.map(lessonShape => {
      lessonNumber += 1;
      const mustDo = `md_${lessonNumber}`;
      const blockIds = lessonShape.map(blockShape => addBlock(blockShape, 'course', mustDo));
      return { lesson_key: `lsn_${String(lessonNumber).padStart(3, '0')}`, kind: 'learning' as const,
        title: `Bài học ${lessonNumber}`, primary_must_do_id: mustDo, secondary_must_do_ids: [], block_ids: blockIds,
        est_screens: 4, est_minutes: 6, ordering_rationale: 'Theo trình tự công việc.' };
    });
    modules.push({ module_key: `mod_${String(moduleIndex + 1).padStart(2, '0')}`, title: `Chương ${moduleIndex + 1}`,
      performance_goal: 'Thực hiện đúng quy trình mẫu trong công việc.', lo_ids: ['lo_1'], lessons });
  });
  addBlock([40], 'nice_to_know', null);
  const holdBlock = addBlock([70], 'hold', null);
  dispositions.push({ fact_key: addFact(25), disposition: 'noise', block_id: null, reason: 'page_furniture' });
  const lessonKeys = modules.flatMap(module => module.lessons.map(lesson => lesson.lesson_key));
  const unsealed = {
    pipeline_version: 'idm-1' as const, idm_contract_version: 1 as const, prompt_policy_version: 'idm-prompt-1' as const,
    source_snapshot_hash: hash,
    project_context: { locale: 'vi' as const, course_title_hint: 'Khoá học mẫu',
      source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, name: 'nguon.pdf', type: 'file' }],
      target_audience: null, learning_objectives: [], duration_target_minutes: null },
    target_audience: { description: 'Nhân viên tuyến đầu cần áp dụng quy trình.', origin: 'ai_proposed' as const },
    learning_objectives: [{ lo_id: 'lo_1', statement: 'Người học có thể áp dụng quy trình mẫu', bloom: 'apply' as const,
      origin: 'ai_proposed' as const }],
    must_dos: lessonKeys.map((_, index) => ({ must_do_id: `md_${index + 1}`, lo_id: 'lo_1',
      statement: `Thực hiện bước ${index + 1}`, kind: 'do' as const, bloom: 'apply' as const })),
    blocks, lo_links: [], blueprint: rows, blocked_must_do_ids: [],
    hold_items: [{ block_id: holdBlock, name: `Khối nội dung ${blocks.length}`, reason: 'Cần SME xác nhận.',
      sme_question: 'Quy định nào đang áp dụng?', blocked_must_do_ids: [] }],
    modules, block_scopes: scopes, dispositions,
    notes: { course: '[Thiết kế theo quy trình ID — idm-1]',
      modules: Object.fromEntries(modules.map(module => [module.module_key, 'Ghi chú chương.'])),
      lessons: Object.fromEntries(lessonKeys.map(key => [key, 'Ghi chú mục.'])) },
    stage_origins: { w1_map: 'provider' as const, w1_reduce: 'provider' as const, w2: 'provider' as const,
      w4: 'provider' as const },
  };
  const design: IdmCourseDesignV1 = { ...unsealed, design_hash: idmDesignHash(unsealed) };
  const scopeOfBlock = new Map(scopes.map(scope => [scope.block_id, scope.scope_key]));
  const skeleton: OrchestrationV2CourseSkeleton = {
    contract_version: 2, source_snapshot_hash: hash, locale: 'vi', title: 'Khoá học mẫu theo IDM',
    summary: 'Khoá học giúp người học thực hiện đúng quy trình mẫu.', target_audience: 'Nhân viên tuyến đầu.',
    prerequisites: [], learning_outcomes: ['Người học có thể áp dụng quy trình mẫu'],
    assessment_strategy: 'Luyện tập theo tình huống.', assumptions: ['IDM pipeline idm-1'],
    chapters: modules.map((module, index) => ({ chapter_key: `chapter-${index + 1}`, order: index, title: module.title,
      objective: module.performance_goal, learning_outcomes: ['Người học có thể áp dụng quy trình mẫu'],
      source_scope_ids: module.lessons.flatMap(lesson => lesson.block_ids.map(blockId => scopeOfBlock.get(blockId)!)) })),
  };
  return { design, skeleton, facts,
    snapshotFacts: facts.map(fact => ({ fact_key: fact.fact_key, fact_chars: Array.from(fact.fact_text).length })) };
}

// --- Python bridge (spec §15.3) ------------------------------------------------------------------
const RAG_ROOT = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
const PYTHON = resolve(RAG_ROOT, process.platform === 'win32' ? '.venv-dev/Scripts/python.exe' : '.venv-dev/bin/python');

/** True when the sibling `landa-ai-rag` checkout and its dev virtualenv are available. */
export const IDM_PYTHON_AVAILABLE = existsSync(PYTHON) && existsSync(resolve(RAG_ROOT, 'tests/idm_golden.py'));

const GOLDEN_SOURCE = `
import json, sys
sys.path.insert(0, "tests")
import idm_golden as g
from app.lesson_author_orchestration_v2 import canonical_hash
vectors = [
    {"a": 1, "b": [True, None, "x"], "\\u00e9": "\\u0111\\u1ebfn", "z": {"y": "<tag> & \\"quoted\\""}},
    {"control": "\\u0001\\b\\f\\n\\r\\t\\u001f\\u007f", "line": "\\u2028\\u2029", "astral": "\\U0001F600"},
    ["Thi\\u1ebft k\\u1ebf theo quy tr\\u00ecnh ID \\u2014 idm-1", 0, -7, 123456789, {}],
]
sys.stdout.write("\\n" + json.dumps({
    "snapshot_hash": g.SNAPSHOT_HASH,
    "facts": [fact.model_dump(mode="json") for fact in g.source_facts()],
    "project_context": g.project_context(),
    "vectors": [{"value": value, "hash": canonical_hash(value)} for value in vectors],
}, ensure_ascii=False))
`;

const DESIGN_SOURCE = `
import asyncio, json, sys, time
sys.path.insert(0, "tests")
import idm_golden as g
from app.main import RagLessonAuthorCourseSkeletonV2Request
from app.idm.course_design import run_idm_course_design
from app.idm.runtime import IdmRuntime, IdmTokenAllowance

async def main():
    request = RagLessonAuthorCourseSkeletonV2Request.model_validate(json.loads(sys.stdin.read()))
    provider = g.golden_provider()
    allowance = request.idm.token_allowance
    runtime = IdmRuntime(generate=provider, api_key="offline-test-key", model=request.model, locale=request.locale,
                         deadline=time.monotonic() + request.idm.remaining_budget_ms / 1000,
                         correlation_id=request.correlation_id,
                         token_allowance=IdmTokenAllowance(allowance.input_tokens, allowance.output_tokens))
    result = await run_idm_course_design(request.idm, source_snapshot_hash=request.source_snapshot_hash,
                                         runtime=runtime, parallelism=4, max_sections=16)
    sys.stdout.write("\\n" + json.dumps({"response": result, "provider_calls": len(provider.calls)},
                                        ensure_ascii=False))

asyncio.run(main())
`;

function runPython(source: string, input?: string): unknown {
  const out = spawnSync(PYTHON, ['-X', 'utf8', '-B', '-c', source], {
    cwd: RAG_ROOT, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 16_000_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (out.status !== 0) throw new Error(`IDM_PYTHON_BRIDGE_FAILED: ${out.error?.message ?? out.stderr}`);
  const lines = out.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!);
}

export interface IdmGoldenSource {
  snapshot_hash: string;
  facts: OrchestrationV2SourceFact[];
  project_context: Record<string, unknown>;
  vectors: Array<{ value: unknown; hash: string }>;
}

/** Golden fixture facts of `landa-ai-rag/tests/idm_golden.py` plus Python canonical-hash vectors. */
export function idmGoldenSource(): IdmGoldenSource {
  return runPython(GOLDEN_SOURCE) as IdmGoldenSource;
}

/** Validate a complete Node course-skeleton request in Python and run the golden IDM course design offline. */
export function idmGoldenCourseDesign(request: Record<string, unknown>): {
  response: Record<string, unknown>; provider_calls: number;
} {
  return runPython(DESIGN_SOURCE, JSON.stringify(request)) as { response: Record<string, unknown>; provider_calls: number };
}

/** True when `landa-ai-rag/tests/idm_contract_bridge.py` can be spawned. */
export const IDM_BRIDGE_AVAILABLE = IDM_PYTHON_AVAILABLE
  && existsSync(resolve(RAG_ROOT, 'tests/idm_contract_bridge.py'));

export interface IdmBridgeMessage {
  stage: 'course_skeleton' | 'chapter_shard' | 'unit' | 'golden_unit' | 'acceptance';
  request: unknown;
  options?: Record<string, unknown>;
}

export interface IdmBridgeResult {
  status: number;
  response: Record<string, any>;
  calls: string[];
}

/** Post Node-built requests to the real Python routes in one offline process (spec §15.3). */
export function idmBridge(batch: readonly IdmBridgeMessage[]): IdmBridgeResult[] {
  const out = spawnSync(PYTHON, ['-X', 'utf8', '-B', '-m', 'tests.idm_contract_bridge'], {
    cwd: RAG_ROOT, input: JSON.stringify({ batch }), encoding: 'utf8', timeout: 180_000, maxBuffer: 64_000_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (out.status !== 0) throw new Error(`IDM_PYTHON_BRIDGE_FAILED: ${out.error?.message ?? out.stderr}`);
  const lines = out.stdout.trim().split('\n');
  return (JSON.parse(lines[lines.length - 1]!) as { results: IdmBridgeResult[] }).results;
}

/**
 * Synthetic module design for every chapter of an `idmFixture`: one shard per
 * chapter, one unit per lesson with one HTML component over all lesson blocks.
 * Returns the stored `chapter_blueprint` shard (V2 projection + `idm_design`).
 */
export function idmShardFixtures(fixture: IdmFixture): Array<{
  plan: { chapter_key: string; order: number; shard_index: number; shard_count: number; source_scope_ids: string[];
    source_fact_count: number; source_content_chars: number };
  shard: Record<string, any>;
  artifact_hash: string;
}> {
  const { design, skeleton } = fixture;
  const scopeOf = new Map(design.block_scopes.map(scope => [scope.block_id, scope]));
  let offset = 0;
  return skeleton.chapters.map((chapter, chapterIndex) => {
    const module = design.modules[chapterIndex]!;
    const review = { purpose: 'Giải thích phần cần thiết.', example_scenario: null, visual_asset: null,
      user_behavior_navigation: 'Đọc rồi tiếp tục.' };
    const lessons = module.lessons.map(lesson => ({
      lesson_key: lesson.lesson_key, title: lesson.title, objective: `Thực hiện ${lesson.title}`,
      learning_objectives: [`Thực hiện ${lesson.title}`], practice_tasks: [], assessment: 'Đánh giá theo tiêu chí.',
      units: [{ unit_index: 1, segment: 'context_explain', title: `Đơn vị ${lesson.title}`,
        purpose: 'Người học nắm phần cần thiết.', block_ids: [...lesson.block_ids],
        components: [{ component_index: 1, type: 'html', role: 'explain', title: 'Giải thích', rationale: 'Giải thích.',
          block_ids: [...lesson.block_ids], practice_id: null, support_items: [], author_review: review }],
        media_brief: null }],
      notes: `Ghi chú thiết kế ${lesson.lesson_key}.`,
    }));
    const unsealed = { pipeline_version: 'idm-1', chapter_key: chapter.chapter_key, shard_index: 0, lessons,
      lesson_index_offset: offset, stage_origin: 'provider' };
    offset += lessons.length;
    const idmDesign = { ...unsealed, design_hash: idmDesignHash(unsealed) };
    const scopes = (blockIds: readonly string[]) => blockIds.map(blockId => scopeOf.get(blockId)!.scope_key);
    const plan = { chapter_key: chapter.chapter_key, order: chapter.order, shard_index: 0, shard_count: 1,
      source_scope_ids: [...chapter.source_scope_ids],
      source_fact_count: module.lessons.flatMap(lesson => lesson.block_ids)
        .reduce((sum, blockId) => sum + scopeOf.get(blockId)!.fact_count, 0),
      source_content_chars: module.lessons.flatMap(lesson => lesson.block_ids)
        .reduce((sum, blockId) => sum + scopeOf.get(blockId)!.content_chars, 0) };
    const shard = { contract_version: 2, source_snapshot_hash: skeleton.source_snapshot_hash,
      chapter_key: chapter.chapter_key, order: chapter.order, shard_index: 0, shard_count: 1,
      source_scope_ids: [...chapter.source_scope_ids], title: chapter.title, objective: chapter.objective,
      lessons: lessons.map(lesson => ({ title: lesson.title, objective: lesson.objective,
        learning_objectives: lesson.learning_objectives, learning_activities: ['Tra cứu và áp dụng.'],
        assessment: lesson.assessment, units: lesson.units.map(unit => ({ title: unit.title, purpose: unit.purpose,
          learning_objective_refs: ['lo_1'], source_scope_ids: scopes(unit.block_ids),
          component_plan: unit.components.map(component => ({ type: component.type, title: component.title,
            rationale: component.rationale, author_review: component.author_review,
            source_scope_ids: scopes(component.block_ids) })), media_brief: null })) })),
      assessment_obligations: [], idm_design: idmDesign };
    return { plan, shard, artifact_hash: orchestrationV2Hash({ contract_version: 2, shard }) };
  });
}
