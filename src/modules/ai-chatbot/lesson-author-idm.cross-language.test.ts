import assert from 'node:assert/strict';
import test from 'node:test';
import { IDM_CONTRACT_VERSION } from './lesson-author-idm.contract.js';
import { IDM_BRIDGE_AVAILABLE, idmGoldenSource } from './lesson-author-idm.fixture.js';
import { hash, runChain, type Row } from './lesson-author-idm-chain.fixture.js';
import {
  ORCHESTRATION_V2_COURSE_CONTRACT,
  ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT,
} from './lesson-author-orchestration-v2-finalization.logic.js';
import type { OrchestrationV2ChapterShardPlan } from './lesson-author-orchestration-v2-rag-contract.logic.js';

/**
 * Spec §15.3: the complete IDM chain with the real Python IDM code behind the
 * Node-built requests (`landa-ai-rag/tests/idm_contract_bridge.py`, offline fake
 * provider) and the real Node repositories/services over an in-memory SQL fake:
 * skeleton → shards → architecture → inventory → units → chapter receipts →
 * finalization → Apply compile (harness: `lesson-author-idm-chain.fixture.ts`).
 */

const WORKSPACE_TEXT = /[<>]/;

function assertWorkspaceContent(content: Row, kind: string, path: string) {
  assert.deepEqual(Object.keys(content).sort(), ['data', 'implementation_notes', 'purpose', 'title'], path);
  assert.ok(typeof content.title === 'string' && content.title.trim() && content.title.length <= 500, path);
  for (const field of ['purpose', 'implementation_notes']) {
    assert.ok(content[field] === null || (typeof content[field] === 'string' && content[field].length <= 8_000), path);
  }
  for (const field of ['title', 'purpose', 'implementation_notes']) {
    assert.ok(!WORKSPACE_TEXT.test(String(content[field] ?? '')), `${path}.${field}`);
  }
  const data = content.data as Row;
  const keys = Object.keys(data).sort();
  if (kind === 'course') assert.deepEqual(keys, ['assessment_strategy', 'prerequisites', 'summary', 'target_audience'], path);
  if (kind === 'chapter') assert.deepEqual(keys, ['learning_outcomes', 'objective'], path);
  if (kind === 'lesson') {
    assert.deepEqual(keys, ['assessment', 'learning_activities', 'learning_objectives', 'objective'], path);
    assert.ok((data.learning_objectives as string[]).length <= 12, path);
  }
  if (kind === 'unit') assert.deepEqual(keys, [], path);
  if (kind === 'media_brief') assert.deepEqual(keys, ['content_points', 'context_description'], path);
  if (kind !== 'component') assert.ok(!WORKSPACE_TEXT.test(JSON.stringify(data)), `${path}.data`);
}

test('IDM cross-language chain reaches ready with accounted-for facts, hash parity and Apply parity',
  { skip: IDM_BRIDGE_AVAILABLE ? false : 'landa-ai-rag/.venv-dev or tests/idm_contract_bridge.py is not available',
    timeout: 300_000 }, async t => {
    const golden = idmGoldenSource();
    const result = await runChain(t, golden, { hold_lessons: [] });
    const { publication, finalization, apply, chain, design } = result;
    // The golden course: 3 chapter shards, lesson offsets 0/2/3, 46 course facts of 61, 15 accounted outside.
    assert.equal((result.plans as OrchestrationV2ChapterShardPlan[]).length, 3);
    assert.deepEqual(result.shardRequests.map(request => (request.idm_module_context as Row).lesson_index_offset),
      [0, 2, 3]);
    assert.equal(result.assembly.admitted_fact_count, 46);
    assert.equal(result.assembly.idm?.excluded_fact_count, 15);
    assert.equal(publication.admitted_fact_count, 61);

    // (a) Every workspace node content honours the UI contract (§4.1).
    for (const node of publication.nodes) {
      if (node.baseline) assertWorkspaceContent(node.baseline as unknown as Row, node.kind, node.canonical_path);
      if (node.kind === 'component') {
        const review = (node.protected_contract.metadata as Row).author_review as Row;
        assert.deepEqual(Object.keys(review).sort(), ['example_scenario', 'purpose', 'user_behavior_navigation',
          'visual_asset']);
      }
    }
    for (const artifact of chain.unitArtifacts) {
      for (const [index, value] of ((artifact.payload as Row).nodes as Row[]).entries()) {
        assertWorkspaceContent(value.content, index === 0 ? 'unit' : 'component', value.path);
      }
    }
    // §8.4 author notes: course/chapter/lesson from the design, unit from the W6 quality note.
    const course = publication.nodes.find(node => node.kind === 'course')!;
    assert.equal(course.baseline?.implementation_notes, design.notes.course);
    const chapters = publication.nodes.filter(node => node.kind === 'chapter');
    assert.deepEqual(chapters.map(node => node.baseline?.implementation_notes),
      design.modules.map(module => design.notes.modules[module.module_key]));
    const lessons = publication.nodes.filter(node => node.kind === 'lesson');
    assert.equal(lessons.length, 5);
    assert.ok(lessons.every(node => typeof node.baseline?.implementation_notes === 'string'
      && node.baseline.implementation_notes.startsWith(design.notes.lessons[`lsn_00${lessons.indexOf(node) + 1}`]!)));
    for (const artifact of chain.unitArtifacts) {
      const payload = artifact.payload as Row;
      const quality = (payload.generated_unit as Row).idm_quality as Row;
      assert.ok(quality, 'generated_unit keeps idm_quality');
      assert.equal((payload.nodes as Row[])[0]!.content.implementation_notes, quality.author_note || null);
      assert.equal(payload.content_origin, 'provider_validated');
    }

    // (b) accounted-for: allocated = covered = admitted = 61.
    assert.equal(finalization.contract, ORCHESTRATION_V2_COURSE_CONTRACT);
    if (finalization.contract !== ORCHESTRATION_V2_COURSE_CONTRACT) return;
    assert.deepEqual([finalization.completion.admitted_fact_count, finalization.completion.allocated_fact_count,
      finalization.completion.covered_fact_count], [61, 61, 61]);
    assert.deepEqual(finalization.idm_accounting,
      { course: 36, reference_job_aid: 10, nice_to_know: 1, remove: 4, hold: 6, noise: 4 });
    assert.equal(result.receipts.reduce((sum, receipt) => sum + receipt.allocated_fact_count, 0), 46);
    assert.ok(chain.sql.some(sql => sql.includes('INSERT INTO lesson_author_workspace_v2_completion_receipts')));

    // (c) contract_hash / brief_hash parity: Python accepted every Node contract (UnitGenerationContractV2
    // re-hashes it, storyboard.parse_brief re-hashes the brief) and answered from the brief.
    assert.equal(result.contracts.length, 7);
    for (const contract of result.contracts) {
      const { contract_hash: contractHash, ...base } = contract;
      assert.equal(contractHash, hash(base));
      const { brief_hash: briefHash, ...brief } = contract.idm_unit_brief!;
      assert.equal(briefHash, hash(brief));
      // QLT-5: every brief carries the design's purpose to the writer and the judge.
      assert.deepEqual([brief.purpose_profile, brief.purpose_summary], [design.purpose!.profile, design.purpose!.summary]);
      // QLT-5 C: and its content mode (keep for the golden compliance course).
      assert.equal(brief.fidelity_mode, design.purpose!.fidelity_mode);
    }
    // QLT-5 D: the FAQ unit (lsn_003 unit 2) carries the W4 FAQ plan and its W1 material, and Python accepted it.
    // QLT-8: the FAQ floor adds one more FAQ (a quarter of a module's learning units), with its own plan.
    const faqBriefs = result.contracts.map(contract => contract.idm_unit_brief!).filter(brief => brief.faq_material);
    assert.equal(faqBriefs.length, 2);
    const plans = faqBriefs.map(brief => brief.components.find(slot => slot.type === 'la_faq')!.faq_items!
      .map(item => [item.question_type, item.origin]));
    const planned = plans.findIndex(plan => JSON.stringify(plan) === JSON.stringify(
      [['common_mistake', 'source'], ['what_if', 'source'], ['common_mistake', 'distractor']]));
    assert.ok(planned >= 0);
    assert.equal(faqBriefs[planned]!.faq_material!.blocks[0]!.support_role, 'common_mistake');
    const added = faqBriefs[1 - planned]!.components.find(slot => slot.type === 'la_faq')!;
    assert.ok(added.title.startsWith('Hỏi đáp: ') && added.faq_items!.length >= 2);
    // QLT-9: every single-choice slot carries its W4 key letter to Python, which accepted the briefs.
    const problems = result.contracts.flatMap(contract => contract.idm_unit_brief!.components)
      .filter(slot => slot.type === 'problem');
    assert.ok(problems.length > 0);
    assert.ok(problems.every(slot => Number.isInteger(slot.key_letter) && slot.key_letter! >= 0 && slot.key_letter! <= 3));
    assert.ok(result.contracts.flatMap(contract => contract.idm_unit_brief!.components)
      .filter(slot => slot.type !== 'problem').every(slot => !('key_letter' in slot)));
    // QLT-5: the design records the purpose it followed. Owner 2026-10-16: the course description is no longer AI ID
    // context, so Python never receives it.
    assert.equal(design.idm_contract_version, IDM_CONTRACT_VERSION);
    assert.equal(design.project_context.course_description, null);
    // QLT-6: a workspace created before the launch brief (NULL column) reaches Python with null brief fields
    // and is designed exactly as before (AI-proposed audience, model or classifier purpose summary).
    assert.deepEqual([design.project_context.design_mode, design.project_context.learner_audience,
      design.project_context.course_purpose], [null, null, null]);
    assert.equal(design.target_audience.origin, 'ai_proposed');
    for (const contract of result.contracts) assert.equal(contract.idm_unit_brief!.design_mode, null);
    assert.equal(design.purpose?.profile, 'compliance');
    assert.equal(design.purpose?.fidelity_mode, 'keep');
    assert.ok(design.notes.course.includes('Mục đích khoá học: Quy trình, quy định, tuân thủ, an toàn'));

    // (d) Apply compile parity: the Apply identity (with notes) equals the published inventory.
    assert.equal(apply.inventory_hash, publication.inventory_hash);
    assert.equal(apply.validation_contract, 'workspace-scoped-apply-2');
    // QLT-5: the AI course title follows the author intent, but Apply never renames the CMS course.
    assert.notEqual(design.project_context.course_title_hint, publication.nodes.find(node => node.kind === 'course')
      ?.baseline?.title);
    assert.equal(apply.writes.some(write => (write.kind as string) === 'course'), false);
    const chapterWrite = apply.writes.find(write => write.kind === 'chapter')!;
    assert.equal(chapterWrite.author_metadata.implementation_notes,
      design.notes.modules[design.modules[chapters.length - 1]!.module_key]);
    assert.ok(apply.writes.some(write => write.kind === 'unit'));

    // (f) Author edits inside an IDM unit still Apply. The unit's revision 0 carries the W6 author note,
    // which its inventory binding (fixed before generate_unit) does not cover.
    // Inside the Apply scope (the last chapter), so the edit is written, not only validated.
    const unitPath = `${chapters.at(-1)!.canonical_path}.lesson_1.unit_1`;
    const unitNode = result.unitContent.get(unitPath)!;
    assert.ok(unitNode.content.implementation_notes, 'the generated unit carries its author note');
    const componentPath = `${unitPath}.component_1`;
    const component = result.unitContent.get(componentPath)!.content as Row;
    const editedComponent = { ...component, title: `${component.title} (tác giả sửa)` };
    const componentApply = result.compileApply(new Map([[componentPath, editedComponent]]));
    assert.equal(componentApply.inventory_hash, publication.inventory_hash);
    const componentWrite = componentApply.writes.find(write => write.canonical_path === componentPath)!;
    assert.deepEqual([componentWrite.revision, componentWrite.title], [1, editedComponent.title]);
    // The workspace API only edits components; Apply still accepts an edited unit revision consistently.
    const editedUnit = { ...unitNode.content, title: 'Tiêu đề đơn vị do tác giả sửa' };
    const unitApply = result.compileApply(new Map([[unitPath, editedUnit], [componentPath, editedComponent]]));
    assert.equal(unitApply.inventory_hash, publication.inventory_hash);
    const unitWrite = unitApply.writes.find(write => write.canonical_path === unitPath)!;
    assert.deepEqual([unitWrite.revision, unitWrite.title, unitWrite.author_metadata.implementation_notes],
      [1, editedUnit.title, unitNode.content.implementation_notes]);
  });

test('IDM cross-language chain with a held practice ends needs_action through the assessment obligation',
  { skip: IDM_BRIDGE_AVAILABLE ? false : 'landa-ai-rag/.venv-dev or tests/idm_contract_bridge.py is not available',
    timeout: 300_000 }, async t => {
    const golden = idmGoldenSource();
    // QLT-6: this run's workspace was started in "Thiết kế bài giảng" mode with the author's audience and purpose.
    const coursePurpose = 'Giúp nhân viên chăm sóc khách hàng xử lý khiếu nại đúng quy trình và quy định của công ty.';
    const { finalization, chain, assembly, design, contracts } = await runChain(t, golden, { hold_lessons: ['lsn_002'],
      launch_brief: { design_mode: 'instructional_design', learner_audience: 'Nhân viên chăm sóc khách hàng mới',
        course_purpose: coursePurpose, version: 1 } });
    assert.deepEqual([design.project_context.design_mode, design.project_context.learner_audience,
      design.project_context.course_purpose],
    ['instructional_design', 'Nhân viên chăm sóc khách hàng mới', coursePurpose]);
    assert.deepEqual(design.target_audience, { description: 'Nhân viên chăm sóc khách hàng mới', origin: 'author' });
    assert.equal(design.purpose?.summary, coursePurpose);
    assert.ok(design.notes.course.includes('• Đối tượng học (tác giả nhập): Nhân viên chăm sóc khách hàng mới.'));
    assert.ok(design.notes.course.includes(`• Mục đích khoá học (tác giả nhập): ${coursePurpose}`));
    for (const contract of contracts) {
      const brief = contract.idm_unit_brief!;
      assert.deepEqual([brief.design_mode, brief.target_audience, brief.purpose_summary],
        ['instructional_design', 'Nhân viên chăm sóc khách hàng mới', coursePurpose]);
    }
    assert.equal(assembly.assessment_obligation_count, 1);
    assert.equal(chain.obligationRows.length, 1);
    assert.equal(chain.obligationRows[0]!.unit_path, 'chapter_1.lesson_2.unit_1');
    assert.equal(finalization.contract, ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT);
    if (finalization.contract !== ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT) return;
    assert.equal(finalization.review.open_assessment_obligation_count, 1);
    assert.deepEqual([finalization.review.allocated_fact_count, finalization.review.covered_fact_count], [61, 61]);
    assert.ok(chain.sql.some(sql => sql.includes('failure_code=\'ASSESSMENT_REVIEW_REQUIRED\'')));
  });
