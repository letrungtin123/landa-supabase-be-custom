import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { query } from '../../config/database.js';
import { getReportSummary, type ReportSummary } from './reports.service.js';

type ExportScope = {
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
};

type ExportLabels = {
  group: string;
  subgroup: string;
  team: string;
};

export type ReportExcelExportOptions = {
  stream: Writable;
  tenantId: string;
  year: number;
  month?: number;
  scope: ExportScope;
  labels: ExportLabels;
  exporterName: string;
};

type ColumnDef = {
  header: string;
  key: string;
  width: number;
};

type ScopeNames = {
  groupName: string;
  subgroupName: string;
  teamName: string;
};

type CourseRankingExportRow = {
  course_id: string;
  name: string;
  visible_learners: string;
  learning_count: string;
  completed_count: string;
  not_started_count: string;
  completion_rate: string;
};

type TeamBreakdownRow = {
  group_name: string;
  subgroup_name: string;
  team_name: string;
  member_count: string;
  visible_courses: string;
  total_enrollments: string;
  completed_count: string;
  learning_count: string;
  not_started_count: string;
  completion_rate: string | null;
};

type HierarchyTrendRow = {
  month: number;
  group_name: string;
  subgroup_name: string;
  team_name: string;
  total_enrollments: string;
  active_learners: string;
  completion_rate: string | null;
};

type LearnerSummaryRow = {
  user_id: string;
  username: string;
  email: string;
  full_name: string | null;
  group_names: string | null;
  subgroup_names: string | null;
  team_names: string | null;
  visible_courses: string;
  enrolled_courses: string;
  completed_courses: string;
  learning_courses: string;
  not_started_courses: string;
  average_progress: string | null;
  last_completion_at: Date | null;
  status: 'not_started' | 'learning' | 'completed';
};

type CourseLearnerRow = {
  user_id: string;
  username: string;
  email: string;
  full_name: string | null;
  group_names: string | null;
  subgroup_names: string | null;
  team_names: string | null;
  course_id: string;
  course_name: string;
  enrolled_at: Date | null;
  completed_at: Date | null;
  progress: string | null;
  status: 'not_started' | 'learning' | 'completed';
};

const MONTH_LABELS = [
  '', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

const EXCEL_MAX_ROWS = 1_048_576;
const STREAM_BATCH_SIZE = 5_000;

const COLORS = {
  navy: 'FF0F172A',
  blue: 'FF2563EB',
  blueSoft: 'FFEFF6FF',
  indigo: 'FF4F46E5',
  emerald: 'FF059669',
  emeraldSoft: 'FFE8FFF6',
  amber: 'FFD97706',
  amberSoft: 'FFFFF7E6',
  slate: 'FF64748B',
  slateSoft: 'FFF8FAFC',
  red: 'FFDC2626',
  white: 'FFFFFFFF',
  border: 'FFD8E1EE',
  headerBg: 'FF1E293B',
};

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: COLORS.border } },
  left: { style: 'thin', color: { argb: COLORS.border } },
  bottom: { style: 'thin', color: { argb: COLORS.border } },
  right: { style: 'thin', color: { argb: COLORS.border } },
};

function getMonthRange(year: number, month: number): { startDate: Date; endDate: Date } {
  return {
    startDate: new Date(year, month - 1, 1),
    endDate: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

function getPeriodRange(year: number, month?: number): { startDate: Date; endDate: Date } {
  if (month) return getMonthRange(year, month);
  return {
    startDate: new Date(year, 0, 1),
    endDate: new Date(year, 11, 31, 23, 59, 59, 999),
  };
}

function getSnapshotEndDate(year: number, month?: number): Date {
  return getPeriodRange(year, month).endDate;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundPercent(value: unknown): number {
  return Math.round(Math.min(Math.max(toNumber(value), 0), 100) * 10) / 10;
}

function statusText(status: string): string {
  if (status === 'completed') return 'Đã học';
  if (status === 'learning') return 'Đang học';
  return 'Chưa học';
}

function statusColor(status: string): string {
  if (status === 'completed') return COLORS.emerald;
  if (status === 'learning') return COLORS.amber;
  return COLORS.slate;
}

function appendScopeFilter(
  params: unknown[],
  scope: ExportScope,
  aliases: { group: string; subgroup: string; team: string } = { group: 'og', subgroup: 'sg', team: 't' },
): string {
  if (scope.teamId) {
    params.push(scope.teamId);
    return `AND ${aliases.team}.id = $${params.length}`;
  }
  if (scope.subgroupId) {
    params.push(scope.subgroupId);
    return `AND ${aliases.subgroup}.id = $${params.length}`;
  }
  if (scope.groupId) {
    params.push(scope.groupId);
    return `AND ${aliases.group}.id = $${params.length}`;
  }
  return '';
}

function buildVisibleCourseUsersCte(options: {
  tenantParam: string;
  snapshotParam: string;
  extraFilterSql?: string;
}): string {
  const { tenantParam, snapshotParam, extraFilterSql = '' } = options;
  const learnerWhere = `
    u.tenant_id = ${tenantParam}
    AND u.is_active = true
    AND u.role IN ('learner', 'learner_plus')
    AND u.created_at <= ${snapshotParam}
  `;
  const courseWhere = `
    c.tenant_id = ${tenantParam}
    AND c.deleted_at IS NULL
    AND c.visible_to_staff_only = false
    AND c.created_at <= ${snapshotParam}
    ${extraFilterSql}
  `;
  const assignedWhere = `
    ${learnerWhere}
    AND og.tenant_id = ${tenantParam}
    AND ${courseWhere}
  `;
  const publicWhere = `
    ${learnerWhere}
    AND ${courseWhere}
    AND COALESCE(c.is_public, false) = true
  `;

  return `
    visible_course_users AS (
      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      JOIN teams t ON t.id = tm.team_id
      JOIN sub_groups sg ON sg.id = t.sub_group_id
      JOIN org_groups og ON og.id = sg.org_group_id
      JOIN team_courses tc ON tc.team_id = t.id
      JOIN courses c ON c.id = tc.course_id
      WHERE ${assignedWhere}

      UNION

      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      JOIN teams t ON t.id = tm.team_id
      JOIN sub_groups sg ON sg.id = t.sub_group_id
      JOIN org_groups og ON og.id = sg.org_group_id
      JOIN team_course_categories tcc ON tcc.team_id = t.id
      JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
      JOIN courses c ON c.id = ccc.course_id
      WHERE ${assignedWhere}

      UNION

      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      LEFT JOIN sub_groups sg ON sg.id = t.sub_group_id
      LEFT JOIN org_groups og ON og.id = sg.org_group_id
      JOIN courses c ON c.tenant_id = ${tenantParam}
      WHERE ${publicWhere}
    )
  `;
}

function safeSheetName(baseName: string, index?: number): string {
  const suffix = index && index > 1 ? ` ${index}` : '';
  return `${baseName}${suffix}`.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31);
}

function lowerLabel(label: string): string {
  return label.trim().toLocaleLowerCase('vi-VN');
}

function addStyledRow(
  worksheet: ExcelJS.Worksheet,
  values: unknown[],
  colCount: number,
  style: 'title' | 'subtitle' | 'header' | 'summary' | 'data' | 'spacer',
  dataIndex = 0,
): ExcelJS.Row {
  const padded = [...values, ...Array(Math.max(colCount - values.length, 0)).fill('')];
  const row = worksheet.addRow(padded);

  if (style === 'spacer') {
    row.height = 8;
    row.commit();
    return row;
  }

  row.height = style === 'title' ? 30 : style === 'header' ? 28 : 22;
  for (let i = 1; i <= colCount; i++) {
    const cell = row.getCell(i);
    cell.border = style === 'title' || style === 'subtitle' ? {} : thinBorder;
    cell.alignment = {
      vertical: 'middle',
      horizontal: style === 'header' ? 'center' : 'left',
      wrapText: style === 'header',
    };

    if (style === 'title') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
      cell.font = { name: 'Arial', size: i === 1 ? 15 : 11, bold: true, color: { argb: COLORS.white } };
    } else if (style === 'subtitle') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.blueSoft } };
      cell.font = { name: 'Arial', size: 10, italic: i === 1, color: { argb: COLORS.slate } };
    } else if (style === 'header') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.white } };
    } else if (style === 'summary') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.blueSoft } };
      cell.font = { name: 'Arial', size: 10, bold: i === 1, color: { argb: i === 1 ? COLORS.navy : COLORS.slate } };
    } else {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: dataIndex % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
  }

  row.commit();
  return row;
}

function addWorksheetChrome(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  name: string,
  title: string,
  subtitle: string,
  columns: ColumnDef[],
): ExcelJS.Worksheet {
  const worksheet = workbook.addWorksheet(safeSheetName(name), {
    views: [{ state: 'frozen', ySplit: 4 }],
    properties: { defaultRowHeight: 20 },
  });
  worksheet.columns = columns.map(col => ({ key: col.key, width: col.width }));

  addStyledRow(worksheet, [title], columns.length, 'title');
  addStyledRow(worksheet, [subtitle], columns.length, 'subtitle');
  addStyledRow(worksheet, [], columns.length, 'spacer');
  addStyledRow(worksheet, columns.map(col => col.header), columns.length, 'header');
  worksheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: columns.length },
  };

  return worksheet;
}

class SplitWorksheetWriter {
  private worksheet: ExcelJS.Worksheet | null = null;
  private sheetIndex = 0;
  private currentRowCount = 0;
  private dataRowCount = 0;

  constructor(
    private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    private readonly baseName: string,
    private readonly title: string,
    private readonly subtitle: string,
    private readonly columns: ColumnDef[],
  ) {
    this.openNextSheet();
  }

  addRow(values: unknown[], customize?: (row: ExcelJS.Row) => void): void {
    if (!this.worksheet) this.openNextSheet();
    if (this.currentRowCount >= EXCEL_MAX_ROWS - 1) this.openNextSheet();

    const row = this.worksheet!.addRow(values);
    row.height = 22;
    for (let i = 1; i <= this.columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: this.dataRowCount % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
    customize?.(row);
    row.commit();
    this.currentRowCount++;
    this.dataRowCount++;
  }

  finish(): void {
    this.worksheet?.commit();
    this.worksheet = null;
  }

  private openNextSheet(): void {
    this.worksheet?.commit();
    this.sheetIndex++;
    this.currentRowCount = 4;
    this.worksheet = addWorksheetChrome(
      this.workbook,
      safeSheetName(this.baseName, this.sheetIndex),
      this.title,
      this.subtitle,
      this.columns,
    );
  }
}

async function resolveScopeNames(tenantId: string, scope: ExportScope): Promise<ScopeNames> {
  if (scope.teamId) {
    const result = await query<ScopeNames>(
      `SELECT og.name AS "groupName", sg.name AS "subgroupName", t.name AS "teamName"
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
      [scope.teamId, tenantId],
    );
    return result.rows[0] || { groupName: 'Tất cả', subgroupName: 'Tất cả', teamName: 'Tất cả' };
  }

  if (scope.subgroupId) {
    const result = await query<Pick<ScopeNames, 'groupName' | 'subgroupName'>>(
      `SELECT og.name AS "groupName", sg.name AS "subgroupName"
       FROM sub_groups sg
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE sg.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
      [scope.subgroupId, tenantId],
    );
    const row = result.rows[0];
    return { groupName: row?.groupName || 'Tất cả', subgroupName: row?.subgroupName || 'Tất cả', teamName: 'Tất cả' };
  }

  if (scope.groupId) {
    const result = await query<Pick<ScopeNames, 'groupName'>>(
      `SELECT name AS "groupName"
       FROM org_groups
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [scope.groupId, tenantId],
    );
    return { groupName: result.rows[0]?.groupName || 'Tất cả', subgroupName: 'Tất cả', teamName: 'Tất cả' };
  }

  return { groupName: 'Tất cả', subgroupName: 'Tất cả', teamName: 'Tất cả' };
}

async function writeInfoSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  scopeNames: ScopeNames,
  subtitle: string,
): Promise<void> {
  const columns: ColumnDef[] = [
    { header: 'Mục', key: 'label', width: 30 },
    { header: 'Giá trị', key: 'value', width: 78 },
  ];
  const worksheet = addWorksheetChrome(workbook, 'Thông tin', 'Thông tin file báo cáo', subtitle, columns);
  const periodLabel = options.month ? `${MONTH_LABELS[options.month]}/${options.year}` : `Năm ${options.year}`;

  const rows: Array<[string, unknown]> = [
    ['Kỳ dữ liệu', periodLabel],
    ['Năm tổng hợp', options.year],
    [options.labels.group, scopeNames.groupName],
    [options.labels.subgroup, scopeNames.subgroupName],
    [options.labels.team, scopeNames.teamName],
    ['Người xuất', options.exporterName],
    ['Thời gian xuất', new Date()],
    ['Ghi chú', 'Dữ liệu được tính theo tenant và bộ lọc phân quyền hiện tại.'],
  ];

  rows.forEach((item, index) => {
    const row = worksheet.addRow(item);
    row.height = 23;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, bold: i === 1, color: { argb: i === 1 ? COLORS.navy : COLORS.slate } };
      if (item[0] === 'Thời gian xuất' && i === 2) cell.numFmt = 'dd/mm/yyyy hh:mm';
    }
    row.commit();
  });

  worksheet.commit();
}

async function writeMonthlyOverviewSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const columns: ColumnDef[] = [
    { header: 'Tháng', key: 'month', width: 14 },
    { header: 'Tổng học viên', key: 'totalLearners', width: 18 },
    { header: 'Học viên hoạt động', key: 'activeLearners', width: 22 },
    { header: 'Lượt ghi danh', key: 'enrollments', width: 18 },
    { header: 'Tỉ lệ hoàn thành', key: 'completionRate', width: 18 },
    { header: 'Trạng thái dữ liệu', key: 'status', width: 18 },
  ];
  const worksheet = addWorksheetChrome(
    workbook,
    'Tổng quan tháng',
    `Tổng quan theo tháng - năm ${options.year}`,
    subtitle,
    columns,
  );

  const now = new Date();
  const maxMonth = options.year > now.getFullYear()
    ? 0
    : options.year === now.getFullYear()
      ? now.getMonth() + 1
      : 12;

  let totalEnrollments = 0;
  let rateSum = 0;
  let rateCount = 0;

  for (let month = 1; month <= 12; month++) {
    const isFuture = month > maxMonth;
    const summary: ReportSummary | null = isFuture
      ? null
      : await getReportSummary(
        options.tenantId,
        month,
        options.year,
        options.scope.groupId,
        options.scope.subgroupId,
        options.scope.teamId,
      );

    const completionRate = summary ? roundPercent(summary.overview.completion_rate) : null;
    if (summary) {
      totalEnrollments += summary.overview.total_enrollments;
      rateSum += completionRate ?? 0;
      rateCount++;
    }

    const row = worksheet.addRow([
      MONTH_LABELS[month],
      summary?.overview.total_learners ?? '',
      summary?.overview.active_learners ?? '',
      summary?.overview.total_enrollments ?? '',
      completionRate === null ? '' : completionRate / 100,
      isFuture ? 'Chưa đến kỳ' : 'Đã có dữ liệu',
    ]);

    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'center' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: month % 2 === 0 ? COLORS.slateSoft : COLORS.white },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy }, bold: i === 1 };
    }
    row.getCell(5).numFmt = '0.0%';
    if (completionRate !== null) {
      row.getCell(5).font = {
        name: 'Arial',
        size: 10,
        bold: true,
        color: { argb: completionRate >= 80 ? COLORS.emerald : completionRate >= 50 ? COLORS.amber : COLORS.red },
      };
    }
    if (isFuture) row.getCell(6).font = { name: 'Arial', size: 10, italic: true, color: { argb: COLORS.slate } };
    row.commit();
  }

  addStyledRow(worksheet, [], columns.length, 'spacer');
  addStyledRow(worksheet, ['Tổng lượt ghi danh trong năm', totalEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, ['Tỉ lệ hoàn thành trung bình', rateCount ? `${(rateSum / rateCount).toFixed(1)}%` : 'N/A'], columns.length, 'summary');
  worksheet.commit();
}

async function fetchHierarchyTrendRows(options: ReportExcelExportOptions): Promise<HierarchyTrendRow[]> {
  const { startDate, endDate } = getPeriodRange(options.year);
  const params: unknown[] = [options.tenantId, startDate, endDate];
  const scopeFilter = appendScopeFilter(params, options.scope);

  const result = await query<HierarchyTrendRow>(
    `SELECT
       EXTRACT(MONTH FROM e.enrolled_at)::int AS month,
       og.name AS group_name,
       sg.name AS subgroup_name,
       t.name AS team_name,
       COUNT(DISTINCT e.id)::bigint AS total_enrollments,
       COUNT(DISTINCT CASE
         WHEN u.last_login_at >= date_trunc('month', e.enrolled_at)
          AND u.last_login_at < date_trunc('month', e.enrolled_at) + INTERVAL '1 month'
         THEN u.id END)::bigint AS active_learners,
       ROUND(AVG(COALESCE(cp.progress, 0))::numeric, 1) AS completion_rate
     FROM enrollments e
     JOIN users u ON u.id = e.user_id AND u.role IN ('learner', 'learner_plus')
     JOIN team_members tm ON tm.user_id = e.user_id
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.tenant_id = $1
       AND e.is_active = true
       AND e.enrolled_at >= $2
       AND e.enrolled_at <= $3
       AND og.tenant_id = $1
       ${scopeFilter}
     GROUP BY month, og.name, sg.name, t.name
     ORDER BY month, og.name, sg.name, t.name`,
    params,
  );

  return result.rows;
}

async function writeHierarchyTrendSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const columns: ColumnDef[] = [
    { header: 'Tháng', key: 'month', width: 14 },
    { header: options.labels.group, key: 'groupName', width: 24 },
    { header: options.labels.subgroup, key: 'subgroupName', width: 26 },
    { header: options.labels.team, key: 'teamName', width: 28 },
    { header: 'Lượt ghi danh', key: 'enrollments', width: 16 },
    { header: 'Học viên hoạt động', key: 'activeLearners', width: 20 },
    { header: 'Tỉ lệ hoàn thành', key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(
    workbook,
    `Xu hướng theo ${options.labels.team}`,
    `Xu hướng theo ${lowerLabel(options.labels.team)} - năm ${options.year}`,
    subtitle,
    columns,
  );
  const rows = await fetchHierarchyTrendRows(options);

  rows.forEach((item, index) => {
    const row = worksheet.addRow([
      MONTH_LABELS[item.month],
      item.group_name,
      item.subgroup_name,
      item.team_name,
      toNumber(item.total_enrollments),
      toNumber(item.active_learners),
      roundPercent(item.completion_rate) / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i >= 5 ? 'center' : 'left' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
    row.getCell(7).numFmt = '0.0%';
    row.commit();
  });

  worksheet.commit();
}

async function fetchTeamBreakdownRows(options: ReportExcelExportOptions): Promise<TeamBreakdownRow[]> {
  const snapshotEndDate = getSnapshotEndDate(options.year, options.month);
  const { startDate, endDate } = getPeriodRange(options.year);
  const params: unknown[] = [options.tenantId, snapshotEndDate, startDate, endDate];
  const scopeFilter = appendScopeFilter(params, options.scope);

  const result = await query<TeamBreakdownRow>(
    `WITH scoped_teams AS (
       SELECT t.id AS team_id, t.name AS team_name, sg.name AS subgroup_name, og.name AS group_name
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE og.tenant_id = $1
       ${scopeFilter}
     ),
     members AS (
       SELECT st.team_id, COUNT(DISTINCT u.id)::bigint AS member_count
       FROM scoped_teams st
       LEFT JOIN team_members tm ON tm.team_id = st.team_id
       LEFT JOIN users u ON u.id = tm.user_id
        AND u.tenant_id = $1
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
        AND u.created_at <= $2
       GROUP BY st.team_id
     ),
      visible_courses AS (
        SELECT st.team_id, tc.course_id
        FROM scoped_teams st
        JOIN team_courses tc ON tc.team_id = st.team_id

        UNION

        SELECT st.team_id, ccc.course_id
        FROM scoped_teams st
        JOIN team_course_categories tcc ON tcc.team_id = st.team_id
        JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id

        UNION

        SELECT st.team_id, c.id AS course_id
        FROM scoped_teams st
        JOIN courses c ON c.tenant_id = $1
         AND c.deleted_at IS NULL
         AND c.visible_to_staff_only = false
         AND COALESCE(c.is_public, false) = true
         AND c.created_at <= $2
      ),
     status_rows AS (
       SELECT
         st.team_id,
         u.id AS user_id,
         vc.course_id,
         e.id AS enrollment_id,
         e.enrolled_at,
         CASE
           WHEN e.id IS NULL THEN 'not_started'
           WHEN (
             COALESCE(cp.progress, 0) >= 100
             OR COALESCE(cp.is_completed, false) = true
           ) AND (cp.completed_at IS NULL OR cp.completed_at <= $2) THEN 'completed'
           ELSE 'learning'
         END AS status,
         CASE WHEN e.id IS NULL THEN NULL ELSE COALESCE(cp.progress, 0) END AS progress
       FROM scoped_teams st
       JOIN team_members tm ON tm.team_id = st.team_id
       JOIN users u ON u.id = tm.user_id
        AND u.tenant_id = $1
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
        AND u.created_at <= $2
       JOIN visible_courses vc ON vc.team_id = st.team_id
       JOIN courses c ON c.id = vc.course_id
        AND c.tenant_id = $1
        AND c.deleted_at IS NULL
        AND c.visible_to_staff_only = false
        AND c.created_at <= $2
       LEFT JOIN enrollments e
        ON e.tenant_id = $1
       AND e.user_id = u.id
       AND e.course_id = vc.course_id
       AND e.is_active = true
       AND e.enrolled_at <= $2
       LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     )
     SELECT
       st.group_name,
       st.subgroup_name,
       st.team_name,
       COALESCE(m.member_count, 0)::bigint AS member_count,
       COUNT(DISTINCT sr.course_id)::bigint AS visible_courses,
       COUNT(DISTINCT sr.enrollment_id) FILTER (WHERE sr.enrolled_at >= $3 AND sr.enrolled_at <= $4)::bigint AS total_enrollments,
       COUNT(sr.course_id) FILTER (WHERE sr.status = 'completed')::bigint AS completed_count,
       COUNT(sr.course_id) FILTER (WHERE sr.status = 'learning')::bigint AS learning_count,
       COUNT(sr.course_id) FILTER (WHERE sr.status = 'not_started')::bigint AS not_started_count,
       ROUND(
         (COUNT(sr.course_id) FILTER (WHERE sr.status = 'completed')::numeric * 100)
         / NULLIF(COUNT(sr.course_id), 0),
         1
       ) AS completion_rate
     FROM scoped_teams st
     LEFT JOIN members m ON m.team_id = st.team_id
     LEFT JOIN status_rows sr ON sr.team_id = st.team_id
     GROUP BY st.group_name, st.subgroup_name, st.team_name, m.member_count
     ORDER BY st.group_name, st.subgroup_name, st.team_name`,
    params,
  );

  return result.rows;
}

async function writeTeamBreakdownSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const columns: ColumnDef[] = [
    { header: options.labels.group, key: 'groupName', width: 24 },
    { header: options.labels.subgroup, key: 'subgroupName', width: 26 },
    { header: options.labels.team, key: 'teamName', width: 28 },
    { header: 'Số học viên', key: 'memberCount', width: 15 },
    { header: 'Số khóa được phân', key: 'visibleCourses', width: 18 },
    { header: 'Lượt ghi danh năm', key: 'enrollments', width: 18 },
    { header: 'Đã học', key: 'completed', width: 12 },
    { header: 'Đang học', key: 'learning', width: 12 },
    { header: 'Chưa học', key: 'notStarted', width: 12 },
    { header: 'Tỉ lệ hoàn thành', key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(
    workbook,
    `Chi tiết ${options.labels.team}`,
    `Chi tiết ${lowerLabel(options.labels.team)}`,
    subtitle,
    columns,
  );
  const rows = await fetchTeamBreakdownRows(options);

  rows.forEach((item, index) => {
    const rate = roundPercent(item.completion_rate);
    const row = worksheet.addRow([
      item.group_name,
      item.subgroup_name,
      item.team_name,
      toNumber(item.member_count),
      toNumber(item.visible_courses),
      toNumber(item.total_enrollments),
      toNumber(item.completed_count),
      toNumber(item.learning_count),
      toNumber(item.not_started_count),
      rate / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i >= 4 ? 'center' : 'left' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
    row.getCell(10).numFmt = '0.0%';
    row.getCell(10).font = {
      name: 'Arial',
      size: 10,
      bold: true,
      color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red },
    };
    row.commit();
  });

  worksheet.commit();
}

async function fetchCourseRankingRows(options: ReportExcelExportOptions): Promise<CourseRankingExportRow[]> {
  const snapshotEndDate = getSnapshotEndDate(options.year, options.month);
  const params: unknown[] = [options.tenantId, snapshotEndDate];
  const scopeFilter = appendScopeFilter(params, options.scope);

  const result = await query<CourseRankingExportRow>(
    `WITH
      ${buildVisibleCourseUsersCte({
        tenantParam: '$1',
        snapshotParam: '$2',
        extraFilterSql: scopeFilter,
      })},
      learner_status AS (
        SELECT
          v.course_id,
          v.name,
          v.user_id,
          CASE
            WHEN e.id IS NULL THEN 'not_started'
            WHEN (
              COALESCE(cp.progress, 0) >= 100
              OR COALESCE(cp.is_completed, false) = true
            ) AND (cp.completed_at IS NULL OR cp.completed_at <= $2) THEN 'completed'
            ELSE 'learning'
          END AS status
        FROM visible_course_users v
        LEFT JOIN enrollments e
          ON e.tenant_id = $1
         AND e.course_id = v.course_id
         AND e.user_id = v.user_id
         AND e.is_active = true
         AND e.enrolled_at <= $2
        LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
      )
     SELECT
       course_id,
       name,
       COUNT(*)::bigint AS visible_learners,
       COUNT(*) FILTER (WHERE status = 'learning')::bigint AS learning_count,
       COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed_count,
       COUNT(*) FILTER (WHERE status = 'not_started')::bigint AS not_started_count,
       ROUND(
         (COUNT(*) FILTER (WHERE status = 'completed')::numeric * 100)
         / NULLIF(COUNT(*), 0),
         1
       ) AS completion_rate
     FROM learner_status
     GROUP BY course_id, name
     ORDER BY completion_rate DESC NULLS LAST, completed_count DESC, visible_learners DESC, name ASC`,
    params,
  );

  return result.rows;
}

async function writeCourseRankingSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<CourseRankingExportRow[]> {
  const columns: ColumnDef[] = [
    { header: 'Hạng', key: 'rank', width: 10 },
    { header: 'Khóa học', key: 'courseName', width: 46 },
    { header: 'Course ID', key: 'courseId', width: 38 },
    { header: 'Học viên được phân', key: 'visibleLearners', width: 20 },
    { header: 'Đã học', key: 'completed', width: 13 },
    { header: 'Đang học', key: 'learning', width: 13 },
    { header: 'Chưa học', key: 'notStarted', width: 13 },
    { header: 'Tỉ lệ hoàn thành', key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(
    workbook,
    'Xếp hạng khóa học',
    'Bảng xếp hạng tỉ lệ hoàn thành từng khóa học',
    subtitle,
    columns,
  );
  const rows = await fetchCourseRankingRows(options);

  rows.forEach((item, index) => {
    const rate = roundPercent(item.completion_rate);
    const row = worksheet.addRow([
      index + 1,
      item.name,
      item.course_id,
      toNumber(item.visible_learners),
      toNumber(item.completed_count),
      toNumber(item.learning_count),
      toNumber(item.not_started_count),
      rate / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i >= 4 || i === 1 ? 'center' : 'left' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy }, bold: i === 1 || (index < 3 && i === 2) };
    }
    row.getCell(8).numFmt = '0.0%';
    row.getCell(8).font = {
      name: 'Arial',
      size: 10,
      bold: true,
      color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red },
    };
    row.commit();
  });

  worksheet.commit();
  return rows;
}

async function fetchLearnerSummaryBatch(
  options: ReportExcelExportOptions,
  lastUserId: string | null,
): Promise<LearnerSummaryRow[]> {
  const snapshotEndDate = getSnapshotEndDate(options.year, options.month);
  const params: unknown[] = [options.tenantId, lastUserId, STREAM_BATCH_SIZE, snapshotEndDate];
  const scopeFilter = appendScopeFilter(params, options.scope);

  const result = await query<LearnerSummaryRow>(
    `WITH scoped_users AS (
       SELECT DISTINCT u.id, u.username, u.email, u.full_name
       FROM users u
       JOIN team_members tm ON tm.user_id = u.id
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE u.tenant_id = $1
         AND u.is_active = true
         AND u.role IN ('learner', 'learner_plus')
         AND u.created_at <= $4
         AND ($2::uuid IS NULL OR u.id > $2::uuid)
         AND og.tenant_id = $1
         ${scopeFilter}
       ORDER BY u.id
       LIMIT $3
     ),
     memberships AS (
       SELECT
         tm.user_id,
         string_agg(DISTINCT og.name, ', ' ORDER BY og.name) AS group_names,
         string_agg(DISTINCT sg.name, ', ' ORDER BY sg.name) AS subgroup_names,
         string_agg(DISTINCT t.name, ', ' ORDER BY t.name) AS team_names
       FROM scoped_users su
       JOIN team_members tm ON tm.user_id = su.id
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE og.tenant_id = $1
       ${scopeFilter}
       GROUP BY tm.user_id
     ),
      visible_course_users AS (
        SELECT su.id AS user_id, c.id AS course_id
        FROM scoped_users su
        JOIN team_members tm ON tm.user_id = su.id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        JOIN team_courses tc ON tc.team_id = t.id
        JOIN courses c ON c.id = tc.course_id
        WHERE og.tenant_id = $1
          AND c.tenant_id = $1
          AND c.deleted_at IS NULL
          AND c.visible_to_staff_only = false
          AND c.created_at <= $4
          ${scopeFilter}

        UNION

        SELECT su.id AS user_id, c.id AS course_id
        FROM scoped_users su
        JOIN team_members tm ON tm.user_id = su.id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        JOIN team_course_categories tcc ON tcc.team_id = t.id
        JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
        JOIN courses c ON c.id = ccc.course_id
        WHERE og.tenant_id = $1
          AND c.tenant_id = $1
          AND c.deleted_at IS NULL
          AND c.visible_to_staff_only = false
          AND c.created_at <= $4
          ${scopeFilter}

        UNION

        SELECT su.id AS user_id, c.id AS course_id
        FROM scoped_users su
        JOIN courses c ON c.tenant_id = $1
        WHERE c.deleted_at IS NULL
          AND c.visible_to_staff_only = false
          AND COALESCE(c.is_public, false) = true
          AND c.created_at <= $4
      ),
     learner_status AS (
       SELECT
         v.user_id,
         v.course_id,
         e.id AS enrollment_id,
         cp.completed_at,
         CASE WHEN e.id IS NULL THEN NULL ELSE COALESCE(cp.progress, 0) END AS progress,
         CASE
           WHEN e.id IS NULL THEN 'not_started'
           WHEN (
             COALESCE(cp.progress, 0) >= 100
             OR COALESCE(cp.is_completed, false) = true
           ) AND (cp.completed_at IS NULL OR cp.completed_at <= $4) THEN 'completed'
           ELSE 'learning'
         END AS status
       FROM visible_course_users v
       LEFT JOIN enrollments e
        ON e.tenant_id = $1
       AND e.user_id = v.user_id
       AND e.course_id = v.course_id
       AND e.is_active = true
       AND e.enrolled_at <= $4
       LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     )
     SELECT
       su.id AS user_id,
       su.username,
       su.email,
       su.full_name,
       m.group_names,
       m.subgroup_names,
       m.team_names,
       COUNT(ls.course_id)::bigint AS visible_courses,
       COUNT(ls.enrollment_id)::bigint AS enrolled_courses,
       COUNT(*) FILTER (WHERE ls.status = 'completed')::bigint AS completed_courses,
       COUNT(*) FILTER (WHERE ls.status = 'learning')::bigint AS learning_courses,
       COUNT(*) FILTER (WHERE ls.status = 'not_started')::bigint AS not_started_courses,
       ROUND(AVG(ls.progress)::numeric, 1) AS average_progress,
       MAX(ls.completed_at) AS last_completion_at,
       CASE
         WHEN COUNT(ls.course_id) > 0
          AND COUNT(*) FILTER (WHERE ls.status = 'completed') = COUNT(ls.course_id) THEN 'completed'
         WHEN COUNT(ls.enrollment_id) > 0 THEN 'learning'
         ELSE 'not_started'
       END AS status
     FROM scoped_users su
     LEFT JOIN memberships m ON m.user_id = su.id
     LEFT JOIN learner_status ls ON ls.user_id = su.id
     GROUP BY su.id, su.username, su.email, su.full_name, m.group_names, m.subgroup_names, m.team_names
     ORDER BY su.id`,
    params,
  );

  return result.rows;
}

async function writeLearnerSummarySheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const columns: ColumnDef[] = [
    { header: 'Username', key: 'username', width: 26 },
    { header: 'Họ tên', key: 'fullName', width: 26 },
    { header: 'Email', key: 'email', width: 34 },
    { header: options.labels.group, key: 'groups', width: 24 },
    { header: options.labels.subgroup, key: 'subgroups', width: 28 },
    { header: options.labels.team, key: 'teams', width: 30 },
    { header: 'Số khóa được phân', key: 'visibleCourses', width: 18 },
    { header: 'Đã học', key: 'completed', width: 12 },
    { header: 'Đang học', key: 'learning', width: 12 },
    { header: 'Chưa học', key: 'notStarted', width: 12 },
    { header: 'Tiến độ TB', key: 'progress', width: 14 },
    { header: 'Hoàn thành gần nhất', key: 'lastCompletion', width: 20 },
  ];
  const writer = new SplitWorksheetWriter(
    workbook,
    'Danh sách học viên',
    'Danh sách học viên theo bộ lọc',
    subtitle,
    columns,
  );

  let lastUserId: string | null = null;
  for (;;) {
    const rows = await fetchLearnerSummaryBatch(options, lastUserId);
    if (rows.length === 0) break;

    for (const item of rows) {
      const progress = roundPercent(item.average_progress);
      writer.addRow([
        item.username,
        item.full_name || '',
        item.email,
        item.group_names || '',
        item.subgroup_names || '',
        item.team_names || '',
        toNumber(item.visible_courses),
        toNumber(item.completed_courses),
        toNumber(item.learning_courses),
        toNumber(item.not_started_courses),
        progress / 100,
        item.last_completion_at,
      ], (row) => {
        row.getCell(11).numFmt = '0.0%';
        row.getCell(11).font = {
          name: 'Arial',
          size: 10,
          bold: true,
          color: { argb: progress >= 80 ? COLORS.emerald : progress >= 50 ? COLORS.amber : COLORS.red },
        };
        row.getCell(12).numFmt = 'dd/mm/yyyy hh:mm';
      });
    }

    lastUserId = rows[rows.length - 1].user_id;
    if (rows.length < STREAM_BATCH_SIZE) break;
  }

  writer.finish();
}

async function fetchCourseLearnerBatch(
  options: ReportExcelExportOptions,
  courseId: string,
  lastUserId: string | null,
): Promise<CourseLearnerRow[]> {
  const snapshotEndDate = getSnapshotEndDate(options.year, options.month);
  const params: unknown[] = [options.tenantId, snapshotEndDate, courseId, lastUserId, STREAM_BATCH_SIZE];
  const scopeFilter = appendScopeFilter(params, options.scope);

  const result = await query<CourseLearnerRow>(
    `WITH
      ${buildVisibleCourseUsersCte({
        tenantParam: '$1',
        snapshotParam: '$2',
        extraFilterSql: `AND c.id = $3 ${scopeFilter}`,
      })},
      selected_users AS (
        SELECT v.user_id, v.course_id, v.name
        FROM visible_course_users v
        WHERE ($4::uuid IS NULL OR v.user_id > $4::uuid)
        ORDER BY v.user_id
        LIMIT $5
      ),
      memberships AS (
        SELECT
          tm.user_id,
          string_agg(DISTINCT og.name, ', ' ORDER BY og.name) AS group_names,
          string_agg(DISTINCT sg.name, ', ' ORDER BY sg.name) AS subgroup_names,
          string_agg(DISTINCT t.name, ', ' ORDER BY t.name) AS team_names
        FROM selected_users su
        JOIN team_members tm ON tm.user_id = su.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1
        ${scopeFilter}
        GROUP BY tm.user_id
      )
     SELECT
       u.id AS user_id,
       u.username,
       u.email,
       u.full_name,
       m.group_names,
       m.subgroup_names,
       m.team_names,
       su.course_id,
       su.name AS course_name,
       e.enrolled_at,
       cp.completed_at,
       CASE
         WHEN e.id IS NULL THEN NULL
         WHEN (
           COALESCE(cp.progress, 0) >= 100
           OR COALESCE(cp.is_completed, false) = true
         ) AND (cp.completed_at IS NULL OR cp.completed_at <= $2) THEN 100
         ELSE LEAST(COALESCE(cp.progress, 0), 99.99)
       END AS progress,
       CASE
         WHEN e.id IS NULL THEN 'not_started'
         WHEN (
           COALESCE(cp.progress, 0) >= 100
           OR COALESCE(cp.is_completed, false) = true
         ) AND (cp.completed_at IS NULL OR cp.completed_at <= $2) THEN 'completed'
         ELSE 'learning'
       END AS status
     FROM selected_users su
     JOIN users u ON u.id = su.user_id
     LEFT JOIN memberships m ON m.user_id = su.user_id
     LEFT JOIN enrollments e
      ON e.tenant_id = $1
     AND e.course_id = su.course_id
     AND e.user_id = su.user_id
     AND e.is_active = true
     AND e.enrolled_at <= $2
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     ORDER BY u.id`,
    params,
  );

  return result.rows;
}

async function writeCourseLearnerDetailSheets(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
  courses: CourseRankingExportRow[],
): Promise<void> {
  const columns: ColumnDef[] = [
    { header: 'Khóa học', key: 'courseName', width: 42 },
    { header: 'Course ID', key: 'courseId', width: 38 },
    { header: 'Username', key: 'username', width: 24 },
    { header: 'Họ tên', key: 'fullName', width: 24 },
    { header: 'Email', key: 'email', width: 34 },
    { header: options.labels.group, key: 'groups', width: 24 },
    { header: options.labels.subgroup, key: 'subgroups', width: 28 },
    { header: options.labels.team, key: 'teams', width: 30 },
    { header: 'Trạng thái', key: 'status', width: 14 },
    { header: 'Tiến độ', key: 'progress', width: 12 },
    { header: 'Ngày ghi danh', key: 'enrolledAt', width: 18 },
    { header: 'Ngày hoàn thành', key: 'completedAt', width: 18 },
  ];
  const writer = new SplitWorksheetWriter(
    workbook,
    'Chi tiết khóa-học viên',
    'Chi tiết học viên theo từng khóa học',
    subtitle,
    columns,
  );

  for (const course of courses) {
    let lastUserId: string | null = null;
    for (;;) {
      const rows = await fetchCourseLearnerBatch(options, course.course_id, lastUserId);
      if (rows.length === 0) break;

      for (const item of rows) {
        const progress = item.progress === null ? null : roundPercent(item.progress);
        writer.addRow([
          item.course_name,
          item.course_id,
          item.username,
          item.full_name || '',
          item.email,
          item.group_names || '',
          item.subgroup_names || '',
          item.team_names || '',
          statusText(item.status),
          progress === null ? '' : progress / 100,
          item.enrolled_at,
          item.completed_at,
        ], (row) => {
          row.getCell(9).font = { name: 'Arial', size: 10, bold: true, color: { argb: statusColor(item.status) } };
          row.getCell(10).numFmt = '0.0%';
          row.getCell(10).font = {
            name: 'Arial',
            size: 10,
            bold: true,
            color: { argb: progress === null ? COLORS.slate : progress >= 80 ? COLORS.emerald : progress >= 50 ? COLORS.amber : COLORS.red },
          };
          row.getCell(11).numFmt = 'dd/mm/yyyy hh:mm';
          row.getCell(12).numFmt = 'dd/mm/yyyy hh:mm';
        });
      }

      lastUserId = rows[rows.length - 1].user_id;
      if (rows.length < STREAM_BATCH_SIZE) break;
    }
  }

  writer.finish();
}

export async function streamReportExcel(options: ReportExcelExportOptions): Promise<void> {
  const scopeNames = await resolveScopeNames(options.tenantId, options.scope);
  const selectedPeriodText = options.month ? `${MONTH_LABELS[options.month]}/${options.year}` : `Năm ${options.year}`;
  const yearlyPeriodText = `Năm ${options.year}`;
  const buildSubtitle = (periodText: string): string => [
    `Kỳ dữ liệu: ${periodText}`,
    `${options.labels.group}: ${scopeNames.groupName}`,
    `${options.labels.subgroup}: ${scopeNames.subgroupName}`,
    `${options.labels.team}: ${scopeNames.teamName}`,
    `Người xuất: ${options.exporterName}`,
  ].join(' | ');
  const selectedPeriodSubtitle = buildSubtitle(selectedPeriodText);
  const yearlySubtitle = buildSubtitle(yearlyPeriodText);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: options.stream,
    useStyles: true,
    useSharedStrings: false,
  });

  workbook.creator = 'Landa';
  workbook.lastModifiedBy = options.exporterName || 'Landa';
  workbook.created = new Date();
  workbook.modified = new Date();

  await writeInfoSheet(workbook, options, scopeNames, selectedPeriodSubtitle);
  await writeMonthlyOverviewSheet(workbook, options, yearlySubtitle);
  await writeHierarchyTrendSheet(workbook, options, yearlySubtitle);
  await writeTeamBreakdownSheet(workbook, options, yearlySubtitle);
  const courseRows = await writeCourseRankingSheet(workbook, options, selectedPeriodSubtitle);
  await writeLearnerSummarySheet(workbook, options, selectedPeriodSubtitle);
  await writeCourseLearnerDetailSheets(workbook, options, selectedPeriodSubtitle, courseRows);

  await workbook.commit();
}
