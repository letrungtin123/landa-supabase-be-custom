// Test-only org-unit catalog shaped like the real tenants (Vietnamese names
// with diacritics, punctuation, duplicates across levels and siblings).

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

/** Thursday 8 October 2026, 12:00 in Asia/Ho_Chi_Minh. */
export const REPORT_REFERENCE_DATE = new Date('2026-10-08T05:00:00.000Z');
export const REPORT_TODAY = '2026-10-08';
