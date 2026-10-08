// Test-only org-unit and course catalogs shaped like the real tenants
// (Vietnamese names with diacritics, punctuation, duplicates across levels
// and siblings).

import type { ReportCourseCatalog } from './report-course-mention.logic.js';
import type { ReportOrgUnit, ReportOrgUnitCatalog } from './report-org-unit.logic.js';

const group = (id: string, name: string): ReportOrgUnit => ({
  id, level: 'group', name, group_id: id, group_name: name, subgroup_id: null, subgroup_name: null,
});
const subgroup = (id: string, name: string, parent: ReportOrgUnit): ReportOrgUnit => ({
  id, level: 'subgroup', name, group_id: parent.id, group_name: parent.name, subgroup_id: id, subgroup_name: name,
});
const team = (id: string, name: string, parent: ReportOrgUnit): ReportOrgUnit => ({
  id, level: 'team', name, group_id: parent.group_id, group_name: parent.group_name, subgroup_id: parent.id, subgroup_name: parent.name,
});

export const UNIT_IDS = {
  holdings: '00000000-0000-4000-8000-000000000001',
  nesso: '00000000-0000-4000-8000-000000000002',
  northSales: '00000000-0000-4000-8000-000000000011',
  southSales: '00000000-0000-4000-8000-000000000012',
  southProduction: '00000000-0000-4000-8000-000000000013',
  nessoBranch: '00000000-0000-4000-8000-000000000014',
  salesHanoi: '00000000-0000-4000-8000-000000000101',
  salesHcm: '00000000-0000-4000-8000-000000000102',
  careHanoi: '00000000-0000-4000-8000-000000000103',
  careHcm: '00000000-0000-4000-8000-000000000104',
  marketing: '00000000-0000-4000-8000-000000000105',
  departmentNorth: '00000000-0000-4000-8000-000000000106',
  departmentSouth: '00000000-0000-4000-8000-000000000107',
  nessoTeam: '00000000-0000-4000-8000-000000000108',
  finance: '00000000-0000-4000-8000-000000000109',
  qc: '00000000-0000-4000-8000-000000000110',
  salesNesso: '00000000-0000-4000-8000-000000000111',
} as const;

const holdings = group(UNIT_IDS.holdings, 'L&A Holdings');
const nesso = group(UNIT_IDS.nesso, 'Nesso');
const northSales = subgroup(UNIT_IDS.northSales, 'Miền Bắc - Kinh doanh', holdings);
const southSales = subgroup(UNIT_IDS.southSales, 'Miền Nam - Kinh doanh', holdings);
const southProduction = subgroup(UNIT_IDS.southProduction, 'Miền Nam - Sản xuất', holdings);
const nessoBranch = subgroup(UNIT_IDS.nessoBranch, 'Nesso', nesso);

export const REPORT_UNIT_CATALOG: ReportOrgUnitCatalog = {
  truncated: false,
  units: [
    holdings, nesso, northSales, southSales, southProduction, nessoBranch,
    team(UNIT_IDS.salesHanoi, 'Kinh doanh Hà Nội', northSales),
    team(UNIT_IDS.salesHcm, 'Kinh doanh TP.HCM', southSales),
    team(UNIT_IDS.careHanoi, 'CSKH Hà Nội', northSales),
    team(UNIT_IDS.careHcm, 'CSKH TP.HCM', southSales),
    team(UNIT_IDS.marketing, 'Marketing', southSales),
    team(UNIT_IDS.departmentNorth, 'Phòng ban', northSales),
    team(UNIT_IDS.departmentSouth, 'Phòng ban', southProduction),
    team(UNIT_IDS.nessoTeam, 'Nesso', nessoBranch),
    team(UNIT_IDS.finance, 'Tài chính - Kế toán', southProduction),
    team(UNIT_IDS.qc, 'QC', southProduction),
    team(UNIT_IDS.salesNesso, 'Kinh doanh Nesso', nessoBranch),
  ],
};

export const COURSE_IDS = {
  customerExperience: 'course-v1:LAndA2+06+2026',
  customerExperienceV2: 'course-v1:LAndA2+65867+2026',
  qualityCheck: 'course-v1:LAndA2+QC+2026',
  safety: 'course-v1:LAndA2+ATLD+2026',
  marketing: 'course-v1:LAndA2+MKT+2026',
  hse: 'course-v1:LAndA2+HSE+2026',
  test: 'course-v1:LAndA2+TEST+2026',
  salesSkills: 'course-v1:LAndA2+SALES+2026',
  salesSkillsCopy: 'course-v1:LAndA2+SALES2+2026',
} as const;

/**
 * Test-only course catalog shaped like the production tenant: nested names
 * ("Customer Experience" / "... V2"), a course named like a team
 * ("Marketing"), short and generic names, and two courses sharing a name.
 */
export const REPORT_COURSE_CATALOG: ReportCourseCatalog = {
  truncated: false,
  courses: [
    { id: COURSE_IDS.customerExperience, name: 'Customer Experience' },
    { id: COURSE_IDS.customerExperienceV2, name: 'Customer Experience V2' },
    { id: COURSE_IDS.qualityCheck, name: 'Quality Check' },
    { id: COURSE_IDS.safety, name: 'An toàn lao động và 5S tại nơi làm việc' },
    { id: COURSE_IDS.marketing, name: 'Marketing' },
    { id: COURSE_IDS.hse, name: 'HSE' },
    { id: COURSE_IDS.test, name: 'Test 1' },
    { id: COURSE_IDS.salesSkills, name: 'Kỹ năng bán hàng' },
    { id: COURSE_IDS.salesSkillsCopy, name: 'Kỹ Năng Bán Hàng' },
  ],
};

/** Thursday 8 October 2026, 12:00 in Asia/Ho_Chi_Minh. */
export const REPORT_REFERENCE_DATE = new Date('2026-10-08T05:00:00.000Z');
export const REPORT_TODAY = '2026-10-08';
