import assert from 'node:assert/strict';
import test from 'node:test';
import { aiRagSkip } from '../../../../../test-support/ai-rag-python.js';
import {
  buildOrganizationContext, normalizeOrgContextProfile, orgContextProfileCharCount, orgContextProfileHash,
  readOrganizationContext, readOrgContextDistillResponse, type OrganizationContextV1, type OrgContextProfileV1,
} from '../../contracts/lesson-author-org-context.contract.js';
import { createOrgContextDistillWorker } from '../../org-context/lesson-author-org-context-distill.worker.js';
import type { RagOrgContextDistillRequest } from '../../../ai-platform/ai-rag-client.service.js';
import { idmBridge, idmGoldenSource, IDM_FIXTURE_ORG_PROFILE } from './lesson-author-idm.fixture.js';
import { runChain } from './lesson-author-idm-chain.fixture.js';

/**
 * Organization context across the languages (ORG_CONTEXT_SPEC §2–§4), against the real Python of the sibling
 * landa-ai-rag (tests/idm_contract_bridge.py, offline fakes, no provider call):
 * - profile_hash parity (Node canonicalJson vs Python js_canonical_hash), validity and char_count;
 * - the distill request exactly as the worker sends it, and its answer read by Node;
 * - the whole IDM chain with a frozen context: the course design echoes it in project_context and every unit
 *   brief carries it (Python verifies both).
 */

const SKIP = aiRagSkip('tests/idm_golden.py', 'tests/idm_contract_bridge.py', 'app/idm/org_profile.py',
  'tests/support/org_context_support.py');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VECTORS: Array<[string, OrgContextProfileV1]> = [
  ['fixture', IDM_FIXTURE_ORG_PROFILE],
  ['astral, quotes, backslash and line breaks', { ...IDM_FIXTURE_ORG_PROFILE,
    organization_summary: 'Dòng "một" \\ 😀𝒜\nDòng hai — ﬁ', glossary: [{ term: 'Ký hiệu <K>', meaning: 'a & b' }] }],
  ['empty', { organization_summary: '', products_services: [], learner_groups: [], glossary: [], key_processes: [],
    culture_tone: '', design_conventions: [] }],
  ['at the caps', { ...IDM_FIXTURE_ORG_PROFILE, organization_summary: 'ạ'.repeat(800), culture_tone: 'b'.repeat(600),
    products_services: Array.from({ length: 15 }, (_, i) => `${i}`.padEnd(200, 'x')).slice(0, 15),
    learner_groups: [], glossary: [], key_processes: [], design_conventions: [] }],
];

interface OrgContextCheck { profile_hash: string | null; valid: boolean; char_count: number | null;
  error: { type: string; loc: string[] } | null }

function check(contexts: unknown[]): OrgContextCheck[] {
  const results = idmBridge(contexts.map(organization_context => ({ stage: 'org_context' as never,
    request: { organization_context } })));
  return results.map(result => { assert.equal(result.status, 200); return result.response as OrgContextCheck; });
}

test('profile_hash, validity and char_count agree with Python on every vector', { skip: SKIP, timeout: 120_000 }, () => {
  const contexts = VECTORS.map(([, profile]) => buildOrganizationContext(3, profile));
  const python = check(contexts);
  VECTORS.forEach(([name, profile], index) => {
    assert.equal(python[index]!.profile_hash, orgContextProfileHash(profile), name);
    assert.equal(python[index]!.valid, true, `${name}: ${JSON.stringify(python[index]!.error)}`);
    assert.equal(python[index]!.char_count, orgContextProfileCharCount(profile), name);
    assert.deepEqual(readOrganizationContext(contexts[index], 'organization_context', path => { throw new Error(path); }),
      contexts[index], name);
  });
  // Both sides refuse the same broken objects.
  const fixture = buildOrganizationContext(3, IDM_FIXTURE_ORG_PROFILE);
  const broken: Array<[string, unknown]> = [
    ['hash mismatch', { ...fixture, profile_hash: 'a'.repeat(64) }],
    ['extra key', { ...fixture, extra: true }],
    // 800 + 600 + 15 × 200 + 6 × 300 = 6200 code points (every field within its own cap).
    ['over the total', buildOrganizationContext(1, { ...VECTORS[3]![1],
      key_processes: Array.from({ length: 6 }, () => 'z'.repeat(300)) })],
    ['empty item', buildOrganizationContext(1, { ...IDM_FIXTURE_ORG_PROFILE, products_services: [''] })],
  ];
  const refused = check(broken.map(([, value]) => value));
  broken.forEach(([name, value], index) => {
    assert.equal(refused[index]!.valid, false, name);
    assert.throws(() => readOrganizationContext(value, 'organization_context', path => { throw new Error(path); }), name);
  });
  assert.equal(refused[0]!.error?.type, 'ORG_CONTEXT_PROFILE_HASH_MISMATCH');
});

test('the worker\'s distill request is accepted as is and its answer reads as an AI draft', { skip: SKIP, timeout: 120_000 },
  async () => {
    const tenant = uuid(1), kb = uuid(2), documents = [uuid(3), uuid(4)];
    const sent: RagOrgContextDistillRequest[] = [];
    let answered: unknown;
    const worker = createOrgContextDistillWorker({
      distill: { failExhaustedLeases: async () => 0,
        claim: async token => ({ tenant_id: tenant, locale: 'vi', requested_by: uuid(5), attempts: 1, lease_token: token }),
        lockLease: async () => true, finishSucceeded: async () => true, finishFailed: async () => true },
      repository: { contextKbId: async () => kb, learnedDocuments: async () => documents.map(id => ({ id, size_bytes: 4_000 })),
        insertVersion: async () => 1 } as never,
      transaction: work => work(),
      settings: () => ({ timeout_ms: 600_000, max_source_chars: 1_500_000 }),
      tenantFilter: () => ({ clause: '', params: [] }),
      runtime: async () => ({ engine: 'self_built_rag', model: 'gemini-3.8-flash', providerKey: true }),
      metered: async (_call, run) => (await run()).value,
      callAi: async request => {
        sent.push(request);
        const [result] = idmBridge([{ stage: 'org_context_distill' as never,
          request: { ...request, api_key: 'offline-test-key' },
          options: { documents: { [documents[0]!]: ['Công ty Hải Đăng giao hàng chặng cuối.', 'Kho lạnh ở Sơn Trà.'] } } }]);
        assert.equal(result!.status, 200, JSON.stringify(result!.response).slice(0, 400));
        answered = result!.response;
        return result!.response;
      },
      id: () => uuid(9),
    });
    assert.equal(await worker.tick(new AbortController().signal), 'succeeded');
    assert.deepEqual(Object.keys(sent[0]!).sort(), ['correlation_id', 'document_ids', 'kb_id', 'locale', 'max_source_chars',
      'model', 'tenant_id']);
    const read = readOrgContextDistillResponse(answered, documents);
    assert.deepEqual(read.source_document_ids, [documents[0]]);
    assert.equal(normalizeOrgContextProfile(read.profile).ok, true);
    assert.ok(read.provider_calls >= 1);
    // A document with no learned text at all is the AI service's 409, which the worker never retries.
    const [none] = idmBridge([{ stage: 'org_context_distill' as never, request: { ...sent[0], api_key: 'offline-test-key' },
      options: { documents: {} } }]);
    assert.equal(none!.status, 409);
    assert.equal((none!.response as { detail?: { code?: string } }).detail?.code ?? (none!.response as { code?: string }).code,
      'ORG_CONTEXT_NO_LEARNED_SOURCE');
  });

test('IDM chain with a frozen organization context: the design echoes it and every unit brief carries it',
  { skip: SKIP, timeout: 300_000 }, async t => {
    const golden = idmGoldenSource();
    const context: OrganizationContextV1 = buildOrganizationContext(3, IDM_FIXTURE_ORG_PROFILE);
    const { design, contracts, skeletonRequests, finalization } = await runChain(t, golden, { hold_lessons: [],
      launch_brief: { design_mode: 'instructional_design', learner_audience: 'Nhân viên chăm sóc khách hàng mới',
        course_purpose: 'Giúp nhân viên xử lý khiếu nại đúng quy trình.', version: 1 },
      organization_context: context as never });
    const sent = (skeletonRequests[0]!.idm as { project_context: Record<string, unknown> }).project_context;
    assert.deepEqual(sent.organization_context, context);
    assert.deepEqual(design.project_context.organization_context, context);
    assert.ok(contracts.length > 0);
    for (const contract of contracts) assert.deepEqual(contract.idm_unit_brief!.organization_context, context);
    assert.ok(finalization);
  });
