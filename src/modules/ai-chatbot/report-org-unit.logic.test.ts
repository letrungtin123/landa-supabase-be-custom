import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasReportUnitWord,
  reportUnitFilter,
  reportUnitPath,
  resolveReportOrgUnits,
  scoreReportUnitMatch,
  type ReportModelUnitMention,
  type ReportUnitResolution,
} from './report-org-unit.logic.js';
import { REPORT_UNIT_CATALOG, UNIT_IDS } from './report-chat.fixture.js';

function resolve(question: string, options: { model?: ReportModelUnitMention[]; allowed?: string[] | null; labels?: Record<string, string> } = {}): ReportUnitResolution {
  return resolveReportOrgUnits({
    question,
    modelUnits: options.model ?? [],
    catalog: REPORT_UNIT_CATALOG,
    labels: options.labels ?? {},
    allowedGroupIds: options.allowed === undefined ? null : options.allowed,
  });
}

function resolvedId(resolution: ReportUnitResolution): string | null {
  return resolution.status === 'resolved' ? resolution.unit.id : null;
}

test('matches unit names regardless of accents, case and punctuation', () => {
  assert.equal(resolvedId(resolve('Báo cáo nhóm Kinh doanh Hà Nội tháng 7')), UNIT_IDS.salesHanoi);
  assert.equal(resolvedId(resolve('bao cao team KINH DOANH HA NOI thang 7')), UNIT_IDS.salesHanoi);
  assert.equal(resolvedId(resolve('báo cáo nhóm CSKH TP.HCM')), UNIT_IDS.careHcm);
  assert.equal(resolvedId(resolve('báo cáo nhóm Tài chính kế toán')), UNIT_IDS.finance);
  assert.equal(resolvedId(resolve('báo cáo chi nhánh Miền Nam - Kinh doanh năm 2025')), UNIT_IDS.southSales);
});

test('reads Vietnamese and English unit words before or after the name', () => {
  assert.equal(resolvedId(resolve('báo cáo team Marketing tháng này')), UNIT_IDS.marketing);
  assert.equal(resolvedId(resolve('learners in the Marketing team last month')), UNIT_IDS.marketing);
  assert.equal(resolvedId(resolve('báo cáo đội Marketing')), UNIT_IDS.marketing);
});

test('tolerates a typo but not an unrelated name', () => {
  assert.equal(resolvedId(resolve('báo cáo phòng ban Markting')), UNIT_IDS.marketing);
  const missing = resolve('báo cáo nhóm Sales');
  assert.equal(missing.status, 'not_found');
  assert.equal(missing.status === 'not_found' ? missing.mention : '', 'Sales');
});

test('returns every candidate for a partial or duplicated name', () => {
  const partial = resolve('báo cáo nhóm Kinh doanh');
  assert.equal(partial.status, 'ambiguous');
  assert.deepEqual(
    partial.status === 'ambiguous' ? partial.candidates.map((unit) => unit.id).sort() : [],
    [UNIT_IDS.northSales, UNIT_IDS.southSales, UNIT_IDS.salesHanoi, UNIT_IDS.salesHcm, UNIT_IDS.salesNesso].sort(),
  );
  const south = resolve('báo cáo chi nhánh Miền Nam');
  assert.deepEqual(south.status === 'ambiguous' ? south.candidates.map((unit) => unit.id) : [], [UNIT_IDS.southSales, UNIT_IDS.southProduction]);
  const duplicated = resolve('báo cáo Nesso', { model: [{ name: 'Nesso' }] });
  assert.equal(duplicated.status, 'ambiguous');
  assert.equal(duplicated.status === 'ambiguous' ? duplicated.candidates.length : 0, 3);
});

test('uses the unit word as a level hint for identical names', () => {
  assert.equal(resolvedId(resolve('báo cáo nhóm Nesso')), UNIT_IDS.nesso);
  assert.equal(resolvedId(resolve('báo cáo team Nesso')), UNIT_IDS.nessoTeam);
  assert.equal(resolvedId(resolve('báo cáo Kinh doanh Hà Nội', { model: [{ name: 'Kinh doanh Hà Nội', level: 'team' }] })), UNIT_IDS.salesHanoi);
});

test('a model name may be a real unit name that contains a unit word', () => {
  const resolution = resolve('báo cáo của phòng ban', { model: [{ name: 'Phòng ban' }] });
  assert.equal(resolution.status, 'ambiguous');
  assert.deepEqual(
    resolution.status === 'ambiguous' ? resolution.candidates.map((unit) => unit.id).sort() : [],
    [UNIT_IDS.departmentNorth, UNIT_IDS.departmentSouth].sort(),
  );
  assert.equal(resolution.status === 'ambiguous' ? resolution.mention : '', 'Phòng ban');
});

test('narrows with a parent mention and reports separate units as multiple', () => {
  assert.equal(resolvedId(resolve('báo cáo team Marketing của chi nhánh Miền Nam')), UNIT_IDS.marketing);
  const multiple = resolve('so sánh team Marketing và team QC');
  assert.equal(multiple.status, 'multiple');
  assert.deepEqual(multiple.status === 'multiple' ? multiple.units.map((unit) => unit.id) : [], [UNIT_IDS.marketing, UNIT_IDS.qc]);
});

test('ignores compounds that only look like unit words', () => {
  assert.equal(resolve('báo cáo đội ngũ giảng viên tháng 7').status, 'none');
  assert.equal(resolve('báo cáo phòng chống cháy nổ').status, 'none');
  assert.equal(resolve('đổi bộ lọc báo cáo').status, 'none');
  assert.equal(resolve('báo cáo nhóm học viên mới tháng 7').status, 'none');
  assert.equal(hasReportUnitWord('báo cáo đội ngũ giảng viên'), false);
  assert.equal(hasReportUnitWord('báo cáo đội Marketing'), true);
});

test('uses tenant group labels as unit words', () => {
  assert.equal(hasReportUnitWord('báo cáo khu vực Miền Nam - Kinh doanh'), false);
  assert.equal(hasReportUnitWord('báo cáo khu vực Miền Nam - Kinh doanh', { subgroup: 'Khu vực' }), true);
  assert.equal(resolvedId(resolve('báo cáo khu vực Miền Nam - Kinh doanh', { labels: { subgroup: 'Khu vực' } })), UNIT_IDS.southSales);
});

test('learner_plus: a unit outside their groups is answered like an unknown name, never silently replaced', () => {
  const allowed = [UNIT_IDS.nesso];
  const outside = resolve('báo cáo team Marketing', { allowed });
  const unknown = resolve('báo cáo team Zebra', { allowed });
  assert.deepEqual(outside, { status: 'not_found', mention: 'Marketing', suggestions: [] });
  assert.deepEqual(unknown, { status: 'not_found', mention: 'Zebra', suggestions: [] }, 'same shape as a name that does not exist');
  // Only the text as typed is echoed: a typo never reveals the real name.
  assert.deepEqual(resolve('báo cáo phòng ban Markting', { allowed }), { status: 'not_found', mention: 'Markting', suggestions: [] });
  assert.equal(resolvedId(resolve('báo cáo phòng ban Markting')), UNIT_IDS.marketing, 'staff still get the typo-tolerant match');
  assert.equal(resolvedId(resolve('báo cáo nhóm Nesso', { allowed })), UNIT_IDS.nesso);
  // All three "Nesso" units are inside the permitted group: the choice stays with the user.
  const permittedChoice = resolve('báo cáo Nesso', { model: [{ name: 'Nesso' }], allowed });
  assert.equal(permittedChoice.status === 'ambiguous' ? permittedChoice.candidates.length : 0, 3);
  // Ambiguity is reduced to permitted candidates; a single one left resolves.
  assert.equal(resolvedId(resolve('báo cáo nhóm Kinh doanh', { allowed })), UNIT_IDS.salesNesso);
  const allOutside = resolve('báo cáo chi nhánh Miền Nam', { allowed });
  assert.deepEqual(allOutside, { status: 'not_found', mention: 'Miền Nam', suggestions: [] });
  const twoOutside = resolve('so sánh team Marketing và team QC', { allowed });
  assert.deepEqual(twoOutside, { status: 'not_found', mention: 'Marketing', suggestions: [] });
  for (const resolution of [outside, allOutside, twoOutside]) {
    for (const unit of REPORT_UNIT_CATALOG.units.filter((candidate) => candidate.group_id !== UNIT_IDS.nesso && candidate.name !== 'Marketing')) {
      assert.ok(!JSON.stringify(resolution).includes(unit.name), `reveals ${unit.name}`);
    }
  }
});

test('learner_plus: suggestions never reveal units outside their groups', () => {
  const missing = resolve('báo cáo nhóm Marketng Hà Nội', { allowed: [UNIT_IDS.nesso] });
  assert.equal(missing.status, 'not_found');
  assert.ok(missing.status === 'not_found' && missing.suggestions.every((unit) => unit.group_id === UNIT_IDS.nesso));
});

test('scores exact > longer phrase > partial > contained > typo', () => {
  assert.equal(scoreReportUnitMatch(['marketing'], ['marketing']), 1);
  assert.equal(scoreReportUnitMatch(['marketing', 'team'], ['marketing']), 0.9);
  assert.equal(scoreReportUnitMatch(['kinh', 'doanh'], ['kinh', 'doanh', 'ha', 'noi']), 0.8);
  assert.equal(scoreReportUnitMatch(['ha', 'noi'], ['cskh', 'ha', 'noi']), 0.72);
  assert.ok(scoreReportUnitMatch(['markting'], ['marketing']) > 0.8);
  assert.equal(scoreReportUnitMatch(['sales'], ['marketing']), 0);
});

test('maps a unit to the existing report filter keys and a display path', () => {
  const team = REPORT_UNIT_CATALOG.units.find((unit) => unit.id === UNIT_IDS.marketing)!;
  assert.deepEqual(reportUnitFilter(team), { group_id: UNIT_IDS.holdings, subgroup_id: UNIT_IDS.southSales, team_id: UNIT_IDS.marketing });
  assert.deepEqual(reportUnitPath(team), ['L&A Holdings', 'Miền Nam - Kinh doanh']);
  const group = REPORT_UNIT_CATALOG.units.find((unit) => unit.id === UNIT_IDS.nesso)!;
  assert.deepEqual(reportUnitFilter(group), { group_id: UNIT_IDS.nesso });
});
