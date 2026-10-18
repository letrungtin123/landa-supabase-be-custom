// ═══════════════════════════════════════════════════════════════
// Tenant display labels of the AI report: the names a superadmin configured
// for the organization levels (tenant_group_labels) and the learner roles
// (tenant_role_labels). They are read at render time and never stored in a
// report snapshot. No I/O.
//
// Rule (mirrors the dashboard, utils/group-labels.ts and utils/role-labels.ts):
// - a configured label is printed exactly as configured, in the Vietnamese and
//   the English PDF alike (the dashboard does not translate them either);
// - an unconfigured level uses the localized default (Công ty / Chi nhánh /
//   Phòng ban, Company / Branch / Department);
// - an unconfigured role uses the dashboard's default role name (Learner,
//   Learner+); a technical role id is never printed;
// - inside a sentence a level label is lowercased (lowerGroupLabel); headings,
//   chips and table headers keep it as configured.
// ═══════════════════════════════════════════════════════════════
import type { ReportPdfLocale } from './report-pdf-i18n.js';
import type { ReportUnitLevel } from './report-unit-breakdown.logic.js';

/** Same bound as the label editors (tenant-group-labels / tenant-role-labels services). */
export const REPORT_LABEL_MAX_CHARS = 64;

export const REPORT_LABEL_KEYS = ['group', 'subgroup', 'team', 'learner', 'learner_plus'] as const;
export type ReportLabelKey = (typeof REPORT_LABEL_KEYS)[number];

/** Configured labels only: a missing key means "use the default display name". */
export type ReportTenantLabels = Partial<Record<ReportLabelKey, string>>;

export const REPORT_DEFAULT_LEVEL_LABELS: Record<ReportPdfLocale, Record<ReportUnitLevel, string>> = {
  vi: { group: 'Công ty', subgroup: 'Chi nhánh', team: 'Phòng ban' },
  en: { group: 'Company', subgroup: 'Branch', team: 'Department' },
};

/** The dashboard's default role names (DEFAULT_ROLE_LABELS), identical in both languages. */
export const REPORT_DEFAULT_ROLE_LABELS: Record<'learner' | 'learner_plus', string> = {
  learner: 'Learner',
  learner_plus: 'Learner+',
};

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Braces are dropped so a label can never form an entity token ({{C1}}) inside narrative text.
  const text = value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length > REPORT_LABEL_MAX_CHARS ? `${characters.slice(0, REPORT_LABEL_MAX_CHARS - 1).join('').trimEnd()}…` : text;
}

/** Keeps the known keys with a non-empty, single-line, bounded value. */
export function normalizeReportTenantLabels(input: Partial<Record<string, unknown>> | null | undefined): ReportTenantLabels {
  const labels: ReportTenantLabels = {};
  if (!input || typeof input !== 'object') return labels;
  for (const key of REPORT_LABEL_KEYS) {
    const label = cleanLabel(input[key]);
    if (label) labels[key] = label;
  }
  return labels;
}

/** Stable text of the labels, part of the stored-PDF key so a label change renders a new PDF. */
export function reportTenantLabelsKey(labels: ReportTenantLabels): string {
  return REPORT_LABEL_KEYS.map((key) => labels[key] ?? '').join('\u001f');
}

/** Lowercase form used inside a sentence (same as the dashboard's lowerGroupLabel). */
export function lowerReportLabel(value: string): string {
  return value.toLocaleLowerCase('vi-VN');
}

/** Level of the units below a scope: tenant -> group, group -> subgroup, subgroup -> team; a team has none. */
export function reportChildUnitLevel(scope: { groupId?: string | null; subgroupId?: string | null; teamId?: string | null }): ReportUnitLevel | null {
  if (scope.teamId) return null;
  if (scope.subgroupId) return 'team';
  if (scope.groupId) return 'subgroup';
  return 'group';
}

/** Label words the PDF dictionaries are built with. */
export interface ReportPdfLabelWords {
  /** Org level names as shown in headings, chips and table headers. */
  group: string;
  subgroup: string;
  team: string;
  /** Level of the unit breakdown, as configured (headings, column header)… */
  unit: string;
  /** …and lowercased for use inside a sentence. */
  unitLower: string;
  /**
   * Several units of that level. Vietnamese has no plural ("bộ phận"); English
   * uses the plural of a default name ("Departments") and "<label> units" for
   * a configured label, which cannot be pluralized ("Bộ phận units").
   */
  units: string;
  unitsLower: string;
  /** Learner role names (learner, learner_plus), without duplicates. */
  learnerRoles: string[];
}

const EN_DEFAULT_LEVEL_PLURALS: Record<ReportUnitLevel, string> = { group: 'Companies', subgroup: 'Branches', team: 'Departments' };

export function resolveReportPdfLabelWords(
  locale: ReportPdfLocale,
  labels: ReportTenantLabels = {},
  unitLevel: ReportUnitLevel | null = null,
): ReportPdfLabelWords {
  const defaults = REPORT_DEFAULT_LEVEL_LABELS[locale];
  const level = (key: ReportUnitLevel) => labels[key] ?? defaults[key];
  // A team scope has no unit below it: no unit text is printed then, the team name is only a safe default.
  const unitKey = unitLevel ?? 'team';
  const unit = level(unitKey);
  const units = locale === 'vi' ? unit : labels[unitKey] ? `${unit} units` : EN_DEFAULT_LEVEL_PLURALS[unitKey];
  const roles = [labels.learner ?? REPORT_DEFAULT_ROLE_LABELS.learner, labels.learner_plus ?? REPORT_DEFAULT_ROLE_LABELS.learner_plus];
  const learnerRoles = roles.filter((role, index) => roles.findIndex((other) => lowerReportLabel(other) === lowerReportLabel(role)) === index);
  return {
    group: level('group'), subgroup: level('subgroup'), team: level('team'),
    unit, unitLower: lowerReportLabel(unit), units, unitsLower: lowerReportLabel(units), learnerRoles,
  };
}

/**
 * Configured labels that contain a letter, longest first. The narrative
 * validator blanks them like entity tokens: a label is a name, not a claim, so
 * its digits, direction words ("Tăng trưởng") or language never count.
 */
export function reportLabelTerms(labels: ReportTenantLabels): string[] {
  const terms = new Set<string>();
  for (const key of REPORT_LABEL_KEYS) {
    const label = labels[key];
    if (label && /\p{L}/u.test(label)) terms.add(label.normalize('NFC'));
  }
  return [...terms].sort((left, right) => right.length - left.length);
}
