import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationV2Hash } from '../shared/lesson-author-orchestration-v2.logic.js';
import {
  buildOrganizationContext, emptyOrgContextProfile, isOrgContextProfileEmpty, normalizeOrgContextLine,
  normalizeOrgContextProfile, normalizeOrgContextText, orgContextConfirmIssue, orgContextProfileCharCount,
  orgContextProfileHash, OrgContextDistillResponseError, OrgContextStoredInvalidError, readOrgContextDistillResponse,
  readOrganizationContext, readStoredOrganizationContext, readStoredOrganizationContextOr, sameOrganizationContext,
  withOrganizationContextIdentity, type OrgContextProfileV1,
} from './lesson-author-org-context.contract.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const profile = (overrides: Partial<Record<keyof OrgContextProfileV1, unknown>> = {}): Record<string, unknown> => ({
  ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu bán thiết bị văn phòng.',
  products_services: ['Máy in'], ...overrides,
});
const ok = (value: unknown) => {
  const result = normalizeOrgContextProfile(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { ok: true; profile: OrgContextProfileV1 }).profile;
};
const issueOf = (value: unknown) => {
  const result = normalizeOrgContextProfile(value);
  assert.equal(result.ok, false);
  return (result as { ok: false; issue: unknown }).issue;
};
const NBSP = String.fromCharCode(0xa0), IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const throwPath = (path: string): never => { throw Object.assign(new Error('INVALID'), { path }); };

test('lines: NFC, a tab or line break becomes a space, other controls go, spaces collapse, trim', () => {
  const decomposed = 'Tiếng Việt';
  assert.equal(normalizeOrgContextLine(decomposed), 'Tiếng Việt');
  assert.equal(normalizeOrgContextLine('  a\tb\nc\r\nd\u0000e\u007f\u0085f   g' + NBSP + IDEOGRAPHIC_SPACE + 'h  '), 'a b c def g h');
  // An unpaired surrogate is dropped; a pair (an emoji) is kept.
  assert.equal(normalizeOrgContextLine(`x${String.fromCharCode(0xd800)}y😀`), 'xy😀');
  assert.equal(normalizeOrgContextLine(`a${String.fromCharCode(0x2028)}b`), 'a b');
});

test('multi-line texts keep their line breaks, trim each line and the text', () => {
  assert.equal(normalizeOrgContextText('\n\n  Dòng 1  \r\n\tDòng   2\n\n\nDòng 3\n\n'), 'Dòng 1\nDòng 2\n\n\nDòng 3');
  assert.equal(normalizeOrgContextText(' \n \t\n'), '');
});

test('a save normalises every field and drops empty list items (paths keep the request index)', () => {
  const stored = ok(profile({
    organization_summary: '  Dòng 1\nDòng 2  ',
    products_services: ['  Máy  in ', '', '   ', 'Dịch vụ\nbảo trì'],
    learner_groups: [{ name: ' Bán hàng ', description: '' }, { name: '', description: '  ' }],
    glossary: [{ term: 'Phiếu', meaning: 'Mẫu yêu cầu' }],
    culture_tone: '\tThân thiện\t',
  }));
  assert.deepEqual(stored, {
    organization_summary: 'Dòng 1\nDòng 2', products_services: ['Máy in', 'Dịch vụ bảo trì'],
    learner_groups: [{ name: 'Bán hàng', description: '' }], glossary: [{ term: 'Phiếu', meaning: 'Mẫu yêu cầu' }],
    key_processes: [], culture_tone: 'Thân thiện', design_conventions: [],
  });
  // Normalising a stored profile again changes nothing.
  assert.deepEqual(ok(stored), stored);
  assert.deepEqual(issueOf(profile({ products_services: ['', 'a'.repeat(201)] })),
    { path: 'profile.products_services[1]', reason: 'too_long' });
});

test('lengths are code points, bounds are inclusive, counts and the 6000 total are enforced', () => {
  ok(profile({ organization_summary: 'a'.repeat(800) }));
  assert.deepEqual(issueOf(profile({ organization_summary: 'a'.repeat(801) })),
    { path: 'profile.organization_summary', reason: 'too_long' });
  // 800 emoji are 800 code points (1600 UTF-16 units).
  ok(profile({ organization_summary: '😀'.repeat(800) }));
  ok(profile({ products_services: Array.from({ length: 15 }, (_, i) => `Sản phẩm ${i}`) }));
  assert.deepEqual(issueOf(profile({ products_services: Array.from({ length: 16 }, (_, i) => `Sản phẩm ${i}`) })),
    { path: 'profile.products_services', reason: 'too_many' });
  assert.deepEqual(issueOf(profile({ glossary: Array.from({ length: 41 }, (_, i) => ({ term: `T${i}`, meaning: 'M' })) })),
    { path: 'profile.glossary', reason: 'too_many' });
  const big = profile({ organization_summary: 'a'.repeat(800), culture_tone: 'b'.repeat(600),
    key_processes: Array.from({ length: 15 }, () => 'c'.repeat(300)) });
  assert.equal(orgContextProfileCharCount(ok(big)), 800 + 600 + 15 * 300 + 'Máy in'.length);
  const total = profile({ organization_summary: 'a'.repeat(800), culture_tone: 'b'.repeat(600),
    key_processes: Array.from({ length: 15 }, () => 'c'.repeat(300)), design_conventions: ['d'.repeat(200)] });
  assert.deepEqual(issueOf(total), { path: 'profile', reason: 'total_too_long' });
});

test('more than 12 lines in a multi-line text is refused, not shortened', () => {
  ok(profile({ culture_tone: Array.from({ length: 12 }, (_, i) => `Dòng ${i}`).join('\n') }));
  assert.deepEqual(issueOf(profile({ culture_tone: Array.from({ length: 13 }, (_, i) => `Dòng ${i}`).join('\n') })),
    { path: 'profile.culture_tone', reason: 'too_long' });
});

test('a pair item needs its required text; a wrong shape is refused before any length', () => {
  assert.deepEqual(issueOf(profile({ learner_groups: [{ name: '', description: 'Chỉ có mô tả' }] })),
    { path: 'profile.learner_groups[0].name', reason: 'empty' });
  assert.deepEqual(issueOf(profile({ glossary: [{ term: 'Từ', meaning: ' ' }] })),
    { path: 'profile.glossary[0].meaning', reason: 'empty' });
  assert.deepEqual(issueOf({ ...profile(), extra: 1 }), { path: 'profile', reason: 'shape' });
  const { culture_tone: _drop, ...missing } = profile();
  assert.deepEqual(issueOf(missing), { path: 'profile', reason: 'shape' });
  assert.deepEqual(issueOf(profile({ products_services: [1] })), { path: 'profile.products_services', reason: 'shape' });
  assert.deepEqual(issueOf(profile({ learner_groups: [{ name: 'a' }] })), { path: 'profile.learner_groups[0]', reason: 'shape' });
  assert.deepEqual(issueOf(profile({ organization_summary: null })), { path: 'profile.organization_summary', reason: 'shape' });
  assert.deepEqual(issueOf(null), { path: 'profile', reason: 'shape' });
});

test('char_count, emptiness and the confirm rule', () => {
  const stored = ok(profile({ learner_groups: [{ name: 'Nhóm 😀', description: 'Mô tả' }],
    glossary: [{ term: 'Từ', meaning: 'Nghĩa' }] }));
  assert.equal(orgContextProfileCharCount(stored), [...'Công ty mẫu bán thiết bị văn phòng.'].length + 'Máy in'.length
    + 'Nhóm 😀'.length - 1 + 'Mô tả'.length + 'Từ'.length + 'Nghĩa'.length);
  assert.equal(isOrgContextProfileEmpty(emptyOrgContextProfile()), true);
  assert.equal(isOrgContextProfileEmpty(stored), false);
  assert.deepEqual(orgContextConfirmIssue(emptyOrgContextProfile()), { path: 'profile', reason: 'empty' });
  assert.equal(orgContextConfirmIssue(stored), null);
});

test('profile_hash is the shared canonical hash and does not depend on key order', () => {
  const stored = ok(profile());
  const reordered = Object.fromEntries(Object.entries(stored).reverse()) as unknown as OrgContextProfileV1;
  assert.equal(orgContextProfileHash(stored), orchestrationV2Hash(stored));
  assert.equal(orgContextProfileHash(reordered), orgContextProfileHash(stored));
  assert.match(orgContextProfileHash(stored), /^[0-9a-f]{64}$/);
});

test('the wire object reads strictly and its hash must match the profile', () => {
  const stored = ok(profile());
  const wire = buildOrganizationContext(4, stored);
  assert.deepEqual(readOrganizationContext(JSON.parse(JSON.stringify(wire)), 'oc', throwPath), wire);
  assert.throws(() => readOrganizationContext({ ...wire, profile_hash: 'a'.repeat(64) }, 'oc', throwPath), { path: 'oc.profile_hash' });
  assert.throws(() => readOrganizationContext({ ...wire, extra: true }, 'oc', throwPath), { path: 'oc' });
  assert.throws(() => readOrganizationContext({ ...wire, profile_version: 0 }, 'oc', throwPath), { path: 'oc.profile_version' });
  assert.throws(() => readOrganizationContext({ ...wire, profile: { ...stored, products_services: [''] } }, 'oc', throwPath),
    { path: 'oc.profile.products_services[0]' });
  assert.equal(readStoredOrganizationContext(null), null);
  assert.equal(readStoredOrganizationContext(undefined), null);
  assert.throws(() => readStoredOrganizationContext({ profile_version: 1 }), OrgContextStoredInvalidError);
  assert.throws(() => readStoredOrganizationContextOr({}, () => { throw new Error('MINE'); }), /MINE/);
  assert.equal(sameOrganizationContext(null, null), true);
  assert.equal(sameOrganizationContext(wire, null), false);
  assert.equal(sameOrganizationContext(wire, buildOrganizationContext(4, stored)), true);
  assert.equal(sameOrganizationContext(wire, buildOrganizationContext(5, stored)), false);
});

test('the identity input is unchanged without a context and carries version + hash with one', () => {
  const identity = { content: 'x', locale: 'vi' };
  assert.equal(withOrganizationContextIdentity(identity, null), identity);
  assert.equal(withOrganizationContextIdentity(identity, undefined), identity);
  const wire = buildOrganizationContext(2, ok(profile()));
  assert.deepEqual(withOrganizationContextIdentity(identity, wire), { ...identity,
    organization_context: { profile_version: 2, profile_hash: wire.profile_hash } });
  assert.notEqual(orchestrationV2Hash(withOrganizationContextIdentity(identity, wire)), orchestrationV2Hash(identity));
});

test('the distill answer: exact keys, requested ids only, normalised profile, extra lines folded', () => {
  const requested = [uuid(1), uuid(2)];
  const answer = { profile: profile({ organization_summary: Array.from({ length: 14 }, (_, i) => `Dòng ${i}`).join('\n') }),
    source_document_ids: [uuid(2)], source_chars: 1234, truncated: false,
    usage: { inputTokens: 10, outputTokens: 5, embeddingTokens: 0, totalTokens: 15 }, usage_complete: true, provider_calls: 3 };
  const read = readOrgContextDistillResponse(answer, requested);
  assert.equal(read.profile.organization_summary.split('\n').length, 12);
  assert.equal(read.profile.organization_summary.split('\n')[11], 'Dòng 11 Dòng 12 Dòng 13');
  assert.deepEqual(read.usage, answer.usage);
  assert.deepEqual(readOrgContextDistillResponse({ ...answer, usage: { inputTokens: 4 } }, requested).usage,
    { inputTokens: 4, outputTokens: 0, embeddingTokens: 0, totalTokens: 4 });
  for (const bad of [{ ...answer, extra: 1 }, { ...answer, source_document_ids: [uuid(3)] },
    { ...answer, source_document_ids: [] }, { ...answer, source_document_ids: [uuid(1), uuid(1)] },
    { ...answer, usage: { inputTokens: -1 } }, { ...answer, truncated: 'no' },
    { ...answer, profile: { ...answer.profile, glossary: [{ term: 'x' }] } }]) {
    assert.throws(() => readOrgContextDistillResponse(bad, requested), OrgContextDistillResponseError);
  }
});
