import assert from 'node:assert/strict';
import test from 'node:test';
import { IDM_BRIDGE_AVAILABLE, idmBridge, type IdmGoldenSource } from './lesson-author-idm.fixture.js';
import { ALLOWED, runChain, type Row } from './lesson-author-idm-chain.fixture.js';
import {
  idmPreserveExpectedTokens,
  idmPreserveHtmlTokens,
  idmPreserveTextFinding,
  idmPreserveVisibleText,
  PRESERVE_TEXT_ADDED,
} from './lesson-author-idm-preserve.logic.js';
import { ORCHESTRATION_V2_COURSE_CONTRACT } from './lesson-author-orchestration-v2-finalization.logic.js';
import {
  acceptOrchestrationV2GeneratedUnit,
  readOrchestrationV2UnitProviderResponse,
  type OrchestrationV2UnitGenerationContract,
} from './lesson-author-orchestration-v2-unit.logic.js';

/**
 * QLT-6 "keep the document as it is" (preserve_source), end to end with the real Python code
 * behind the Node-built requests (`landa-ai-rag/tests/idm_contract_bridge.py`): the course
 * skeleton makes the one segmentation call (offline fake answer), the chapter and unit stages
 * fail the test if they call the provider at all, and Node's acceptance agrees with Python's
 * exact-text check word for word.
 */

const SKIP = IDM_BRIDGE_AVAILABLE ? false : 'landa-ai-rag/.venv-dev or tests/idm_contract_bridge.py is not available';
const KEPT = { design_mode: 'preserve_source', learner_audience: null, course_purpose: null, version: 1 };
const NBSP = String.fromCodePoint(0xa0);

function preserveSource(): IdmGoldenSource & { segmentation: Row } {
  const [result] = idmBridge([{ stage: 'preserve_source', request: {} }]);
  assert.equal(result!.status, 200);
  return { ...(result!.response as IdmGoldenSource & { segmentation: Row }), vectors: [] };
}

function pythonFindings(cases: Array<{ facts: string[]; html: string }>): Array<string | null> {
  const [result] = idmBridge([{ stage: 'preserve_text', request: { cases } }]);
  assert.equal(result!.status, 200);
  return result!.response.results as Array<string | null>;
}

test('QLT-6 kept document: one segmentation call, no provider call after it, every unit word for word, ready, Apply',
  { skip: SKIP, timeout: 300_000 }, async t => {
    const source = preserveSource();
    // Every unit is counted as a whole fallback: a kept document is still ready (its units are its own text).
    const result = await runChain(t, source, { hold_lessons: [], launch_brief: KEPT, all_units_fallback: true });
    const { design, chain, publication, finalization, apply, unitRequests, contracts } = result;

    // Course skeleton: exactly one provider call, and it only answered line numbers.
    const [skeleton] = idmBridge([{ stage: 'course_skeleton', request: { ...result.skeletonRequests[0]!,
      api_key: 'offline-test-key' } }]);
    assert.deepEqual(skeleton!.calls.map(name => name.replace(/IdmWire$/, '')), ['IdmPreserveSegmentationV1']);
    assert.equal(design.project_context.design_mode, 'preserve_source');
    assert.deepEqual(design.stage_origins, { preserve_segmentation: 'provider' });
    assert.deepEqual(design.modules.map(module => module.title),
      ['MODUN 1: VÌ SAO PHẢN HỒI QUAN TRỌNG', 'MODUN 2: CÁCH ĐƯA RA PHẢN HỒI']);
    assert.deepEqual(design.modules.flatMap(module => module.lessons.map(lesson => lesson.title)),
      ['Bài 1: Phản hồi là gì', 'Bài 2: Lợi ích của phản hồi', 'Bài 3: Mô hình SBI', 'Bài 4: Những lỗi thường gặp']);
    assert.ok(design.notes.course.startsWith('Chế độ: Giữ nguyên nội dung tài liệu — nội dung được giữ nguyên '
      + 'từng chữ, AI chỉ chia chương và bài.'));

    // Chapter and unit stages ran through the bridge's no-provider fake (any call fails the chain).
    assert.equal(result.shardRequests.length, 2);
    assert.equal(unitRequests.length, 5);
    for (const request of unitRequests) {
      assert.equal(request.fallback_only, true, 'a kept unit takes the provider-free path');
      const contract = request.unit_contract as OrchestrationV2UnitGenerationContract;
      assert.equal(contract.idm_unit_brief?.design_mode, 'preserve_source');
      assert.deepEqual(contract.component_plan.map(plan => plan.type), ['html']);
    }

    // Every unit shows exactly its own lines (as stored, after the course html sanitizer), and the units cover every
    // line of the document except page furniture, once and in order.
    const noise = new Set(design.dispositions.filter(item => item.disposition === 'noise').map(item => item.fact_key));
    assert.equal(noise.size, 7);
    const covered: string[] = [];
    for (const [index, artifact] of chain.unitArtifacts.entries()) {
      const payload = artifact.payload as Row;
      const contract = contracts[index]!;
      const stored = (payload.nodes as Row[])[1]!.content.data as string;
      assert.equal(idmPreserveTextFinding(contract.source_facts.map(fact => fact.fact_text), stored), null);
      assert.equal(payload.content_origin, 'structured_fallback');
      assert.equal((payload.generated_unit as Row).source_locked_fallback, undefined);
      covered.push(...contract.unit_source_fact_ids);
    }
    assert.deepEqual(covered, chain.facts.map(fact => fact.fact_key as string).filter(key => !noise.has(key)));

    // Ready (not "mostly fallback"), with every fact accounted for.
    assert.equal(finalization.contract, ORCHESTRATION_V2_COURSE_CONTRACT);
    if (finalization.contract !== ORCHESTRATION_V2_COURSE_CONTRACT) return;
    assert.deepEqual([finalization.completion.admitted_fact_count, finalization.completion.covered_fact_count],
      [34, 34]);
    assert.deepEqual(finalization.idm_accounting,
      { course: 27, reference_job_aid: 0, nice_to_know: 0, remove: 0, hold: 0, noise: 7 });
    assert.ok(chain.sql.some(sql => sql.includes('INSERT INTO lesson_author_workspace_v2_completion_receipts')));
    assert.equal(chain.obligationRows.length, 0);

    // Apply compiles unchanged: chapter and lesson titles are the document's lines; the course is never renamed.
    assert.equal(apply.inventory_hash, publication.inventory_hash);
    assert.equal(apply.writes.some(write => (write.kind as string) === 'course'), false);
    assert.ok(apply.writes.some(write => write.kind === 'chapter' && write.title === 'MODUN 2: CÁCH ĐƯA RA PHẢN HỒI'));
    assert.ok(apply.writes.some(write => write.kind === 'unit' && write.title === '3.1 Ví dụ áp dụng'));
  });

test('QLT-6 kept unit: Node acceptance and Python agree; purity rules are off only for a kept unit',
  { skip: SKIP, timeout: 300_000 }, async t => {
    const source = preserveSource();
    const result = await runChain(t, source, { hold_lessons: [], launch_brief: KEPT });
    const { normalizeLessonAuthorProposal } = await import('../chat/chat.service.js');
    // Bài 2 keeps "Nguồn: Báo cáo nhân sự 2025, trang 12." and a table.
    const request = result.unitRequests[1]!;
    const contract = request.unit_contract as OrchestrationV2UnitGenerationContract;
    const [unit] = idmBridge([{ stage: 'unit', request: { ...request, api_key: 'offline-test-key' } }]);
    assert.equal(unit!.status, 200);
    assert.deepEqual(unit!.calls, []);
    const accept = (raw: Row, target = contract) => acceptOrchestrationV2GeneratedUnit({ contract: target,
      response: readOrchestrationV2UnitProviderResponse(raw, target), normalizeProposal: normalizeLessonAuthorProposal,
      allowed: ALLOWED });
    const accepted = accept(unit!.response);
    assert.match(String((accepted.nodes[1]!.content as Row).data), /trang 12/);
    assert.match((unit!.response.unit as Row).idm_quality.deterministic_codes.join(','), /IDM_PRESERVE_KEPT_/);

    // One added word: Node refuses at its exact-text check, Python's check says the same.
    const added = structuredClone(unit!.response) as Row;
    const component = (added.unit as Row).components[0] as Row;
    component.html = String(component.html).replace('trang 12.', 'trang 12. Ví dụ minh hoạ.');
    assert.throws(() => accept(added), (error: Error & { code?: string; acceptance?: Row }) =>
      error.code === 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID' && error.acceptance?.check === 'preserve_text'
      && error.acceptance?.code === PRESERVE_TEXT_ADDED);
    const facts = contract.source_facts.map(fact => fact.fact_text);
    assert.deepEqual(pythonFindings([{ facts, html: String(component.html) }]), [PRESERVE_TEXT_ADDED]);

    // The same html under a designed course's brief is rejected by the instructional-quality (purity) rules.
    const designed = structuredClone(contract);
    designed.idm_unit_brief = { ...designed.idm_unit_brief!, design_mode: 'instructional_design' };
    assert.throws(() => accept(unit!.response, designed), (error: Error & { code?: string; acceptance?: Row }) =>
      error.code === 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID' && error.acceptance?.check === 'coverage');
  });

test('QLT-6 exact-text rule: Node and Python give the same verdict on every case', { skip: SKIP }, () => {
  const facts = ['Bài 1: Mở đầu', 'Row 1: Nhóm | Tỷ lệ', 'Row 2: A ' + String.fromCodePoint(0xa6) + ' B | 92%',
    'Dùng thẻ <b> & "ngoặc" với \'nháy\'', `Khoảng${NBSP}trắng   kép`, 'ROW 3 :  x|y | z', 'Row 4:   ', 'Row 5:'];
  const base = '<h2>Bài 1: Mở đầu</h2><table><thead><tr><th>Nhóm</th><th>Tỷ lệ</th></tr></thead><tbody><tr>'
    + '<td>A | B</td><td>92%</td></tr></tbody></table><p>Dùng thẻ &lt;b&gt; &amp; &quot;ngoặc&quot; với &#x27;nháy&#39;'
    + `</p><p>Khoảng&nbsp;trắng kép</p><p>x|y z</p><p>Row 5:</p>`;
  const cases = [
    base,
    base.replace('&#x27;nháy&#39;', '\'nháy\''),
    base.replace('<p>x|y z</p>', '<p>  x|y\n z </p>'),
    base.replace('Mở đầu', 'Mở đầu thêm'),
    base.replace('<td>92%</td>', '<td></td>'),
    base.replace('<td>A | B</td><td>92%</td>', '<td>92%</td><td>A | B</td>'),
    base.replace('Nhóm', 'nhóm'),
    base.replace('&amp;', '&amp;amp;'),
    base.replace('&#x27;', '&#1114112;'),
    `<p>${String.fromCodePoint(0x1f600)}</p>` + base,
  ].map(html => ({ facts, html }));
  const node = cases.map(item => idmPreserveTextFinding(item.facts, item.html));
  assert.deepEqual(node, pythonFindings(cases));
  assert.deepEqual(node.slice(0, 3), [null, null, null]);
  assert.ok(node.slice(3).every(value => value !== null));
  assert.deepEqual(idmPreserveExpectedTokens(['Row 1: a | b c']), ['a', 'b', 'c']);
  assert.equal(idmPreserveVisibleText('Không phải bảng | chữ'), 'Không phải bảng | chữ');
  assert.deepEqual(idmPreserveHtmlTokens('<p>&#65;&copy;</p>'), ['A&copy;']);
});
