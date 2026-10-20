import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIdmCourseSkeletonRequest, readIdmCourseDesign, readIdmModuleContext, readIdmUnitBrief, sealIdmUnitBrief,
  type IdmCourseDesignV1,
} from '../../contracts/lesson-author-idm.contract.js';
import { buildOrganizationContext } from '../../contracts/lesson-author-org-context.contract.js';
import { assembleIdmOrchestrationArchitecture } from './lesson-author-idm-architecture.logic.js';
import {
  buildIdmModuleContext, idmScopeViewOf, idmShardLessonsOf, planIdmChapterShards, remapFactsToBlockScopes,
} from './lesson-author-idm-scope-view.logic.js';
import { ORCHESTRATION_V2_IDM_EXECUTION_POLICY } from '../lesson-author-orchestration-v2-execution.config.js';
import {
  IDM_FIXTURE_DOCUMENT_ID, IDM_FIXTURE_ORG_PROFILE, IDM_FIXTURE_ORGANIZATION_CONTEXT, idmFixture, idmShardFixtures,
  rehashIdmDesign,
} from './lesson-author-idm.fixture.js';
import { prepareOrchestrationV2UnitGenerationContract } from '../steps/lesson-author-orchestration-v2-unit.logic.js';
import { prepareOrchestrationV2Admission } from '../admission/lesson-author-orchestration-v2-admission.logic.js';

/**
 * Organization context in IDM contract 3 (no version bump): the frozen wire object rides in
 * project_context and the unit brief only when the run has one; without it every request, design and
 * brief is exactly what it was before.
 */

const invalidAt = (path: string) => ({ code: 'IDM_CONTRACT_INVALID', path });

function unitContract(design: IdmCourseDesignV1, fixture = idmFixture(undefined, { contract: 3 })) {
  const withDesign = { ...fixture, design };
  const shards = idmShardFixtures(withDesign);
  const view = idmScopeViewOf(design);
  const assembly = assembleIdmOrchestrationArchitecture(fixture.skeleton, view,
    shards.map(item => ({ artifact_hash: item.artifact_hash, shard: item.shard as never })));
  const scopes = assembly.architecture.chapters[0]!.lessons[0]!.units[0]!.source_scope_ids;
  const keys = new Set(view.design.block_scopes.filter(scope => scopes.includes(scope.scope_key))
    .flatMap(scope => scope.fact_keys));
  const facts = fixture.facts.filter(fact => keys.has(fact.fact_key));
  return prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: 'chapter_1.lesson_1.unit_1',
    source_facts: remapFactsToBlockScopes(facts, view), idm: { design, lesson_facts: facts } });
}

test('the course-skeleton request carries the frozen context only when the workspace has one', () => {
  const { facts } = idmFixture();
  const common = { locale: 'vi' as const, course_title: 'Khoá học', course_description: null,
    launch_brief: { design_mode: 'instructional_design' as const, learner_audience: 'Nhân viên mới',
      course_purpose: 'Giúp nhân viên mới làm đúng quy trình.' },
    source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, name: 'nguon.pdf', type: 'file' }], source_facts: facts,
    input_tokens: 1_800_000, max_output_tokens: 65_536, provider_max_attempts: 2, remaining_ms: 600_000 };
  const before = buildIdmCourseSkeletonRequest(common);
  assert.equal(Object.hasOwn(before.project_context, 'organization_context'), false);
  assert.deepEqual(buildIdmCourseSkeletonRequest({ ...common, organization_context: null }), before);
  const organized = buildIdmCourseSkeletonRequest({ ...common, organization_context: IDM_FIXTURE_ORGANIZATION_CONTEXT });
  assert.deepEqual(organized.project_context.organization_context, IDM_FIXTURE_ORGANIZATION_CONTEXT);
  const { organization_context: _context, ...rest } = organized.project_context;
  assert.deepEqual({ ...organized, project_context: rest }, before, 'nothing else changes');
  // A context that does not verify is refused before any dispatch.
  assert.throws(() => buildIdmCourseSkeletonRequest({ ...common, organization_context: {
    ...IDM_FIXTURE_ORGANIZATION_CONTEXT, profile_hash: 'a'.repeat(64) } }),
  invalidAt('idm.project_context.organization_context.profile_hash'));
});

test('a contract-3 design reads its echoed context exactly; older shapes cannot carry one', () => {
  const organized = idmFixture(undefined, { contract: 3, organizationContext: IDM_FIXTURE_ORGANIZATION_CONTEXT }).design;
  assert.deepEqual(readIdmCourseDesign(JSON.parse(JSON.stringify(organized))), organized);
  assert.throws(() => readIdmCourseDesign(rehashIdmDesign({ ...organized, project_context: { ...organized.project_context,
    organization_context: { ...IDM_FIXTURE_ORGANIZATION_CONTEXT, profile_version: 0 } } })),
  invalidAt('idm.project_context.organization_context.profile_version'));
  const tampered = structuredClone(organized);
  tampered.project_context.organization_context!.profile.products_services.push('Thêm');
  assert.throws(() => readIdmCourseDesign(rehashIdmDesign(tampered)),
    invalidAt('idm.project_context.organization_context.profile_hash'));
  const contract2 = idmFixture(undefined, { contract: 2 }).design;
  assert.throws(() => readIdmCourseDesign(rehashIdmDesign({ ...contract2, project_context: {
    ...contract2.project_context, organization_context: IDM_FIXTURE_ORGANIZATION_CONTEXT } })), { code: 'IDM_CONTRACT_INVALID' });
  // Null is never sent: absent means no context.
  assert.throws(() => readIdmCourseDesign(rehashIdmDesign({ ...organized, project_context: {
    ...organized.project_context, organization_context: null as never } })), { code: 'IDM_CONTRACT_INVALID' });
});

test('the module context of an organized design carries the same project context', () => {
  const fixture = idmFixture(undefined, { contract: 3, organizationContext: IDM_FIXTURE_ORGANIZATION_CONTEXT });
  const plans = planIdmChapterShards(fixture.skeleton, fixture.design, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning,
    'a'.repeat(64));
  const shard = plans.chapter_tasks[0]!.shard_plan!;
  const context = buildIdmModuleContext({ design: fixture.design, lessons: idmShardLessonsOf(fixture.design, shard),
    allowed_component_types: ['html', 'problem'], input_tokens: 400_000, max_output_tokens: 65_536,
    provider_max_attempts: 2, remaining_ms: 500_000 });
  assert.deepEqual(context.project_context.organization_context, IDM_FIXTURE_ORGANIZATION_CONTEXT);
  assert.deepEqual(readIdmModuleContext(JSON.parse(JSON.stringify(context))), context);
});

test('a unit brief carries the design\'s context (bound by brief_hash) and nothing without one', () => {
  const fixture = idmFixture(undefined, { contract: 3 });
  const plain = unitContract(fixture.design, fixture).idm_unit_brief!;
  assert.equal(Object.hasOwn(plain, 'organization_context'), false);
  const organizedDesign = idmFixture(undefined, { contract: 3, organizationContext: IDM_FIXTURE_ORGANIZATION_CONTEXT }).design;
  const organized = unitContract(organizedDesign, fixture).idm_unit_brief!;
  assert.deepEqual(organized.organization_context, IDM_FIXTURE_ORGANIZATION_CONTEXT);
  // Component plan ids follow the design hash; every other field is the plain brief's.
  const strip = (brief: Record<string, unknown>) => Object.fromEntries(Object.entries(brief)
    .filter(([key]) => !['organization_context', 'brief_hash', 'components'].includes(key)));
  assert.deepEqual(strip(organized as never), strip(plain as never));
  assert.deepEqual(Object.keys(organized).sort(), [...Object.keys(plain), 'organization_context'].sort());
  assert.notEqual(organized.brief_hash, plain.brief_hash);
  assert.deepEqual(readIdmUnitBrief(JSON.parse(JSON.stringify(organized))), organized);
  const other = buildOrganizationContext(4, { ...IDM_FIXTURE_ORG_PROFILE, culture_tone: 'Trang trọng.' });
  assert.throws(() => readIdmUnitBrief({ ...organized, organization_context: other }), invalidAt('idm_unit_brief.brief_hash'));
  // Only a brief of a contract-3 design (design_mode present) may carry it.
  const { design_mode: _mode, brief_hash: _hash, ...older } = organized;
  assert.throws(() => sealIdmUnitBrief(older), invalidAt('idm_unit_brief'));
});

test('the V2 bootstrap hash: absent or null context leaves it unchanged; a context binds the run to it', () => {
  const authority = { workspace_id: '00000000-0000-4000-8000-000000000001', tenant_id: '00000000-0000-4000-8000-000000000002',
    course_id: 'course-v1:x+y+z', source_snapshot_hash: 'a'.repeat(64), source_document_ids: ['00000000-0000-4000-8000-000000000003'],
    launch_brief: { design_mode: 'instructional_design' as const, learner_audience: 'Nhân viên mới',
      course_purpose: 'Giúp nhân viên mới làm đúng quy trình.' } };
  const config = { runtime_config_hash: 'b'.repeat(64), model: 'gemini-3.8-flash', source_snapshot_budget_ms: 600_000,
    tenant_concurrency_limit: 4, workspace_concurrency_limit: 4, routing_shard_count: 4_096 };
  const before = prepareOrchestrationV2Admission(authority, config);
  assert.equal(prepareOrchestrationV2Admission({ ...authority, organization_context: null }, config).bootstrap_hash,
    before.bootstrap_hash);
  const organized = prepareOrchestrationV2Admission({ ...authority, organization_context: IDM_FIXTURE_ORGANIZATION_CONTEXT },
    config);
  assert.notEqual(organized.bootstrap_hash, before.bootstrap_hash);
  assert.equal(organized.source_task_contract_hash, before.source_task_contract_hash);
  assert.throws(() => prepareOrchestrationV2Admission({ ...authority, organization_context: {
    ...IDM_FIXTURE_ORGANIZATION_CONTEXT, profile_hash: 'c'.repeat(64) } }, config), { code: 'ORCHESTRATION_V2_ADMISSION_INVALID' });
});
