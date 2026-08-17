import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { query } from '../../config/database.js';
import { buildActiveLearnerEventsCte, buildReportEnrollmentCte, buildReportLearnerRosterCte, getReportSummary, type ReportDateRange, type ReportSummary } from './reports.service.js';

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
  dateRange?: ReportDateRange;
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
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string;
};

type TeamBreakdownRow = {
  group_name: string;
  subgroup_name: string;
  team_name: string;
  member_count: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string | null;
};

type HierarchyTrendRow = {
  period_label: string;
  group_name: string;
  subgroup_name: string;
  team_name: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
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
  enrolled_courses: string;
  completed_courses: string;
  incomplete_courses: string;
  completion_rate: string | null;
  last_completion_at: Date | null;
  status: 'not_started' | 'learning' | 'completed';
};

type CourseLearnerRow = {
  enrollment_id: string;
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
  is_completed: boolean;
  progress: string;
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



function getExportPeriodRange(options: ReportExcelExportOptions): { startDate: Date; endDate: Date } {
  if (options.dateRange) return options.dateRange;
  return getPeriodRange(options.year, options.month);
}



function getExportPeriodLabel(options: ReportExcelExportOptions): string {
  if (options.dateRange) return `${options.dateRange.dateFrom} đến ${options.dateRange.dateTo}`;
  return options.month ? `${MONTH_LABELS[options.month]}/${options.year}` : `Năm ${options.year}`;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundPercent(value: unknown): number {
  return Math.round(Math.min(Math.max(toNumber(value), 0), 100) * 100) / 100;
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
  const periodLabel = getExportPeriodLabel(options);

  const rows: Array<[string, unknown]> = [
    ['Kỳ dữ liệu', periodLabel],
    [options.dateRange ? 'Khoảng tổng hợp' : 'Năm tổng hợp', options.dateRange ? periodLabel : options.year],
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
    { header: options.dateRange ? 'Khoảng ngày' : 'Tháng', key: 'month', width: 22 },
    { header: 'Tổng học viên đã tạo', key: 'totalLearners', width: 22 },
    { header: 'Học viên có hoạt động học', key: 'activeLearners', width: 24 },
    { header: 'Lượt ghi danh trong kỳ', key: 'enrollments', width: 20 },
    { header: 'Đã hoàn thành', key: 'completedEnrollments', width: 18 },
    { header: 'Chưa hoàn thành', key: 'incompleteEnrollments', width: 18 },
    { header: 'Tỷ lệ hoàn thành trung bình của học viên', key: 'completionRate', width: 36 },
  ];
  const worksheet = addWorksheetChrome(
    workbook,
    options.dateRange ? 'Tổng quan kỳ' : 'Tổng quan tháng',
    options.dateRange ? 'Tổng quan theo khoảng ngày' : `Tổng quan theo tháng - năm ${options.year}`,
    subtitle,
    columns,
  );

  const addOverviewRow = (label: string, summary: ReportSummary | null, index: number): void => {
    const rate = summary ? roundPercent(summary.overview.completion_rate) : null;
    const row = worksheet.addRow([
      label,
      summary?.overview.total_learners ?? '',
      summary?.overview.active_learners ?? '',
      summary?.overview.total_enrollments ?? '',
      summary?.overview.completed_enrollments ?? '',
      summary?.overview.incomplete_enrollments ?? '',
      rate === null ? '' : rate / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'center' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft } };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy }, bold: i === 1 };
    }
    if (rate !== null) {
      row.getCell(7).numFmt = '0.00%';
      row.getCell(7).font = { name: 'Arial', size: 10, bold: true, color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red } };
    }
    row.commit();
  };

  if (options.dateRange) {
    const summary = await getReportSummary(
      options.tenantId, undefined, undefined, options.scope.groupId, options.scope.subgroupId, options.scope.teamId, options.dateRange,
    );
    addOverviewRow(getExportPeriodLabel(options), summary, 0);
    addStyledRow(worksheet, [], columns.length, 'spacer');
    addStyledRow(worksheet, ['Tổng lượt ghi danh trong khoảng', summary.overview.total_enrollments], columns.length, 'summary');
    addStyledRow(worksheet, ['Đã hoàn thành', summary.overview.completed_enrollments], columns.length, 'summary');
    addStyledRow(worksheet, ['Chưa hoàn thành', summary.overview.incomplete_enrollments], columns.length, 'summary');
    addStyledRow(worksheet, ['Tỷ lệ hoàn thành trung bình của học viên', `${roundPercent(summary.overview.completion_rate).toFixed(2)}%`], columns.length, 'summary');
    worksheet.commit();
    return;
  }

  const now = new Date();
  const maxMonth = options.year > now.getFullYear() ? 0 : options.year === now.getFullYear() ? now.getMonth() + 1 : 12;
  let totalEnrollments = 0;
  let completedEnrollments = 0;
  let incompleteEnrollments = 0;

  for (let month = 1; month <= 12; month++) {
    const summary = month > maxMonth
      ? null
      : await getReportSummary(options.tenantId, month, options.year, options.scope.groupId, options.scope.subgroupId, options.scope.teamId);
    if (summary) {
      totalEnrollments += summary.overview.total_enrollments;
      completedEnrollments += summary.overview.completed_enrollments;
      incompleteEnrollments += summary.overview.incomplete_enrollments;
    }
    addOverviewRow(MONTH_LABELS[month], summary, month - 1);
  }

  const annualRange = maxMonth === 0 ? null : (() => {
    const startDate = new Date(options.year, 0, 1);
    const endDate = getMonthRange(options.year, maxMonth).endDate;
    return {
      startDate,
      endDate,
      dateFrom: `${options.year}-01-01`,
      dateTo: `${options.year}-${String(maxMonth).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`,
    };
  })();
  const annualSummary = annualRange
    ? await getReportSummary(
      options.tenantId,
      undefined,
      undefined,
      options.scope.groupId,
      options.scope.subgroupId,
      options.scope.teamId,
      annualRange,
    )
    : null;
  const yearlyRate = annualSummary?.overview.completion_rate ?? 0;  addStyledRow(worksheet, [], columns.length, 'spacer');
  addStyledRow(worksheet, ['Tổng lượt ghi danh trong năm', totalEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, ['Đã hoàn thành trong năm', completedEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, ['Chưa hoàn thành trong năm', incompleteEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, ['Tỷ lệ hoàn thành trung bình của học viên trong năm', `${yearlyRate.toFixed(2)}%`], columns.length, 'summary');
  worksheet.commit();
}
async function fetchHierarchyTrendRows(options: ReportExcelExportOptions): Promise<HierarchyTrendRow[]> {
  const { startDate, endDate } = getExportPeriodRange(options);
  const params: unknown[] = [options.tenantId, startDate, endDate];
  const scopeFilter = appendScopeFilter(params, options.scope);
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3', scopeParamStart: 4,
  });
  const result = await query<HierarchyTrendRow>(
    `WITH ${buildActiveLearnerEventsCte({ tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3' })},
      ${cohort.sql},
      enrollment_metrics AS (
        SELECT
          date_trunc('month', re.enrolled_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS period_start,
          og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id,
          og.name AS group_name, sg.name AS subgroup_name, t.name AS team_name,
          COUNT(DISTINCT re.enrollment_id)::bigint AS total_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
        FROM report_enrollments re
        JOIN team_members tm ON tm.user_id = re.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${scopeFilter}
        GROUP BY period_start, og.id, sg.id, t.id, og.name, sg.name, t.name
      ),
      activity_metrics AS (
        SELECT
          date_trunc('month', ae.activity_date::timestamp) AS period_start,
          og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id,
          og.name AS group_name, sg.name AS subgroup_name, t.name AS team_name,
          COUNT(DISTINCT ae.user_id)::bigint AS active_learners
        FROM active_learner_events ae
        JOIN users u ON u.id = ae.user_id
        JOIN team_members tm ON tm.user_id = ae.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          AND og.tenant_id = $1 ${scopeFilter}
        GROUP BY period_start, og.id, sg.id, t.id, og.name, sg.name, t.name
      )
      SELECT
        'Tháng ' || EXTRACT(MONTH FROM COALESCE(em.period_start, am.period_start))::int || '/' || EXTRACT(YEAR FROM COALESCE(em.period_start, am.period_start))::int AS period_label,
        COALESCE(em.group_name, am.group_name) AS group_name,
        COALESCE(em.subgroup_name, am.subgroup_name) AS subgroup_name,
        COALESCE(em.team_name, am.team_name) AS team_name,
        COALESCE(em.total_enrollments, 0)::bigint AS total_enrollments,
        COALESCE(em.completed_enrollments, 0)::bigint AS completed_enrollments,
        COALESCE(em.incomplete_enrollments, 0)::bigint AS incomplete_enrollments,
        COALESCE(am.active_learners, 0)::bigint AS active_learners,
        em.completion_rate
      FROM enrollment_metrics em
      FULL OUTER JOIN activity_metrics am
        ON am.period_start = em.period_start AND am.group_id = em.group_id AND am.subgroup_id = em.subgroup_id AND am.team_id = em.team_id
      ORDER BY COALESCE(em.period_start, am.period_start), COALESCE(em.group_name, am.group_name), COALESCE(em.subgroup_name, am.subgroup_name), COALESCE(em.team_name, am.team_name)`,
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
    { header: options.dateRange ? 'Khoảng ngày' : 'Tháng', key: 'month', width: 22 },
    { header: options.labels.group, key: 'groupName', width: 24 },
    { header: options.labels.subgroup, key: 'subgroupName', width: 26 },
    { header: options.labels.team, key: 'teamName', width: 28 },
    { header: 'Lượt ghi danh', key: 'enrollments', width: 16 },
    { header: 'Đã hoàn thành', key: 'completedEnrollments', width: 16 },
    { header: 'Chưa hoàn thành', key: 'incompleteEnrollments', width: 16 },
    { header: 'Học viên có hoạt động học', key: 'activeLearners', width: 22 },
    { header: 'Tiến độ trung bình', key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(workbook, `Xu hướng theo ${options.labels.team}`, `Xu hướng theo ${lowerLabel(options.labels.team)} - ${getExportPeriodLabel(options)}`, subtitle, columns);
  const rows = await fetchHierarchyTrendRows(options);
  rows.forEach((item, index) => {
    const row = worksheet.addRow([
      item.period_label, item.group_name, item.subgroup_name, item.team_name,
      toNumber(item.total_enrollments), toNumber(item.completed_enrollments), toNumber(item.incomplete_enrollments), toNumber(item.active_learners), roundPercent(item.completion_rate) / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i >= 5 ? 'center' : 'left' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft } };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
    row.getCell(9).numFmt = '0.00%';
    row.commit();
  });
  worksheet.commit();
}
async function fetchTeamBreakdownRows(options: ReportExcelExportOptions): Promise<TeamBreakdownRow[]> {
  const { startDate, endDate } = getExportPeriodRange(options);
  const params: unknown[] = [options.tenantId, startDate, endDate];
  const scopeFilter = appendScopeFilter(params, options.scope);
  const cohort = buildReportEnrollmentCte({ tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3', scopeParamStart: 4 });
  const result = await query<TeamBreakdownRow>(
    `WITH ${cohort.sql},
      scoped_teams AS (
        SELECT t.id AS team_id, t.name AS team_name, sg.name AS subgroup_name, og.name AS group_name
        FROM teams t
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${scopeFilter}
      ),
      members AS (
        SELECT st.team_id, COUNT(DISTINCT u.id)::bigint AS member_count
        FROM scoped_teams st
        LEFT JOIN team_members tm ON tm.team_id = st.team_id
        LEFT JOIN users u ON u.id = tm.user_id AND u.tenant_id = $1 AND u.is_active = true AND u.role IN ('learner', 'learner_plus')
        GROUP BY st.team_id
      ),
      enrollment_metrics AS (
        SELECT
          st.team_id,
          COUNT(DISTINCT re.enrollment_id)::bigint AS total_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
        FROM scoped_teams st
        LEFT JOIN team_members tm ON tm.team_id = st.team_id
        LEFT JOIN report_enrollments re ON re.user_id = tm.user_id
        GROUP BY st.team_id
      )
      SELECT
        st.group_name, st.subgroup_name, st.team_name,
        COALESCE(m.member_count, 0)::bigint AS member_count,
        COALESCE(em.total_enrollments, 0)::bigint AS total_enrollments,
        COALESCE(em.completed_enrollments, 0)::bigint AS completed_enrollments,
        COALESCE(em.incomplete_enrollments, 0)::bigint AS incomplete_enrollments,
        COALESCE(em.completion_rate, 0) AS completion_rate
      FROM scoped_teams st
      LEFT JOIN members m ON m.team_id = st.team_id
      LEFT JOIN enrollment_metrics em ON em.team_id = st.team_id
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
    { header: 'Học viên hiện thuộc đội', key: 'memberCount', width: 22 },
    { header: 'Lượt ghi danh trong kỳ', key: 'enrollments', width: 20 },
    { header: 'Đã hoàn thành', key: 'completed', width: 18 },
    { header: 'Chưa hoàn thành', key: 'incomplete', width: 18 },
    { header: 'Tiến độ trung bình', key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(workbook, `Chi tiết ${options.labels.team}`, `Chi tiết ${lowerLabel(options.labels.team)}`, subtitle, columns);
  const rows = await fetchTeamBreakdownRows(options);
  rows.forEach((item, index) => {
    const rate = roundPercent(item.completion_rate);
    const row = worksheet.addRow([
      item.group_name, item.subgroup_name, item.team_name, toNumber(item.member_count), toNumber(item.total_enrollments),
      toNumber(item.completed_enrollments), toNumber(item.incomplete_enrollments), rate / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i >= 4 ? 'center' : 'left' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft } };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
    row.getCell(8).numFmt = '0.00%';
    row.getCell(8).font = { name: 'Arial', size: 10, bold: true, color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red } };
    row.commit();
  });
  worksheet.commit();
}
async function fetchCourseRankingRows(options: ReportExcelExportOptions): Promise<CourseRankingExportRow[]> {
  const { startDate, endDate } = getExportPeriodRange(options);
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3',
    groupId: options.scope.groupId, subgroupId: options.scope.subgroupId, teamId: options.scope.teamId, scopeParamStart: 4,
  });
  const result = await query<CourseRankingExportRow>(
    `WITH ${cohort.sql}
     SELECT
       re.course_id,
       MAX(re.course_name) AS name,
       COUNT(*)::bigint AS total_enrollments,
       COUNT(*) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
       COUNT(*) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
       COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
     FROM report_enrollments re
     GROUP BY re.course_id
     ORDER BY completion_rate DESC NULLS LAST, completed_enrollments DESC, total_enrollments DESC, name ASC`,
    [options.tenantId, startDate, endDate, ...cohort.params],
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
    { header: 'Lượt ghi danh trong kỳ', key: 'enrollments', width: 20 },
    { header: 'Đã hoàn thành', key: 'completed', width: 18 },
    { header: 'Chưa hoàn thành', key: 'incomplete', width: 18 },
    { header: 'Tiến độ trung bình', key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(
    workbook, 'Xếp hạng khóa học', 'Bảng xếp hạng tỉ lệ hoàn thành từng khóa học', subtitle, columns,
  );
  const rows = await fetchCourseRankingRows(options);
  rows.forEach((item, index) => {
    const rate = roundPercent(item.completion_rate);
    const row = worksheet.addRow([
      index + 1, item.name, item.course_id, toNumber(item.total_enrollments),
      toNumber(item.completed_enrollments), toNumber(item.incomplete_enrollments), rate / 100,
    ]);
    row.height = 22;
    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: i >= 4 || i === 1 ? 'center' : 'left' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 === 0 ? COLORS.white : COLORS.slateSoft } };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy }, bold: i === 1 || (index < 3 && i === 2) };
    }
    row.getCell(7).numFmt = '0.00%';
    row.getCell(7).font = { name: 'Arial', size: 10, bold: true, color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red } };
    row.commit();
  });
  worksheet.commit();
  return rows;
}
async function fetchLearnerSummaryBatch(
  options: ReportExcelExportOptions,
  lastUserId: string | null,
): Promise<LearnerSummaryRow[]> {
  const { startDate, endDate } = getExportPeriodRange(options);
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3',
    groupId: options.scope.groupId, subgroupId: options.scope.subgroupId, teamId: options.scope.teamId, scopeParamStart: 4,
  });
  const roster = buildReportLearnerRosterCte({
    tenantParam: '$1',
    groupId: options.scope.groupId,
    subgroupId: options.scope.subgroupId,
    teamId: options.scope.teamId,
    scopeParamStart: 4,
  });
  const cursorParam = 4 + cohort.params.length;
  const limitParam = cursorParam + 1;
  const membershipScope = options.scope.teamId
    ? 'AND t.id = $4'
    : options.scope.subgroupId
      ? 'AND sg.id = $4'
      : options.scope.groupId
        ? 'AND og.id = $4'
        : '';
  const result = await query<LearnerSummaryRow>(
    `WITH ${cohort.sql},
      ${roster.sql},
      selected_users AS (
        SELECT rl.user_id
        FROM report_learners rl
        WHERE ($${cursorParam}::uuid IS NULL OR rl.user_id > $${cursorParam}::uuid)
        ORDER BY rl.user_id
        LIMIT $${limitParam}
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
        WHERE og.tenant_id = $1 ${membershipScope}
        GROUP BY tm.user_id
      )
      SELECT
        su.user_id,
        u.username,
        u.email,
        u.full_name,
        m.group_names,
        m.subgroup_names,
        m.team_names,
        COUNT(re.enrollment_id)::bigint AS enrolled_courses,
        COUNT(re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_courses,
        COUNT(re.enrollment_id) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_courses,
        COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate,
        MAX(re.completed_at) FILTER (WHERE re.is_completed) AS last_completion_at,
        CASE
          WHEN COALESCE(AVG(re.progress), 0) >= 100 THEN 'completed'
          WHEN COALESCE(AVG(re.progress), 0) > 0 THEN 'learning'
          ELSE 'not_started'
        END AS status
      FROM selected_users su
      JOIN users u ON u.id = su.user_id
      LEFT JOIN report_enrollments re ON re.user_id = su.user_id
      LEFT JOIN memberships m ON m.user_id = su.user_id
      GROUP BY su.user_id, u.username, u.email, u.full_name, m.group_names, m.subgroup_names, m.team_names
      ORDER BY su.user_id`,
    [options.tenantId, startDate, endDate, ...cohort.params, lastUserId, STREAM_BATCH_SIZE],
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
    { header: 'Lượt ghi danh trong kỳ', key: 'enrollments', width: 20 },
    { header: 'Đã hoàn thành', key: 'completed', width: 18 },
    { header: 'Chưa hoàn thành', key: 'incomplete', width: 18 },
    { header: 'Tiến độ trung bình', key: 'completionRate', width: 18 },
    { header: 'Hoàn thành gần nhất', key: 'lastCompletion', width: 20 },
  ];
  const writer = new SplitWorksheetWriter(workbook, 'Danh sách học viên', 'Danh sách học viên trong phạm vi đang lọc', subtitle, columns);
  let lastUserId: string | null = null;
  for (;;) {
    const rows = await fetchLearnerSummaryBatch(options, lastUserId);
    if (rows.length === 0) break;
    for (const item of rows) {
      const rate = roundPercent(item.completion_rate);
      writer.addRow([
        item.username, item.full_name || '', item.email, item.group_names || '', item.subgroup_names || '', item.team_names || '',
        toNumber(item.enrolled_courses), toNumber(item.completed_courses), toNumber(item.incomplete_courses), rate / 100, item.last_completion_at,
      ], (row) => {
        row.getCell(10).numFmt = '0.00%';
        row.getCell(10).font = { name: 'Arial', size: 10, bold: true, color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red } };
        row.getCell(11).numFmt = 'dd/mm/yyyy hh:mm';
      });
    }
    lastUserId = rows[rows.length - 1].user_id;
    if (rows.length < STREAM_BATCH_SIZE) break;
  }
  writer.finish();
}
async function fetchCourseLearnerBatch(
  options: ReportExcelExportOptions,
  lastEnrolledAt: Date | null,
  lastEnrollmentId: string | null,
): Promise<CourseLearnerRow[]> {
  const { startDate, endDate } = getExportPeriodRange(options);
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3',
    groupId: options.scope.groupId, subgroupId: options.scope.subgroupId, teamId: options.scope.teamId, scopeParamStart: 4,
  });
  const cursorDateParam = 4 + cohort.params.length;
  const cursorIdParam = cursorDateParam + 1;
  const limitParam = cursorIdParam + 1;
  const membershipScope = options.scope.teamId
    ? 'AND t.id = $4'
    : options.scope.subgroupId
      ? 'AND sg.id = $4'
      : options.scope.groupId
        ? 'AND og.id = $4'
        : '';
  const result = await query<CourseLearnerRow>(
    `WITH ${cohort.sql},
      selected_enrollments AS (
        SELECT re.*
        FROM report_enrollments re
        WHERE (
          $${cursorDateParam}::timestamptz IS NULL
          OR re.enrolled_at > $${cursorDateParam}
          OR (re.enrolled_at = $${cursorDateParam} AND re.enrollment_id > $${cursorIdParam}::uuid)
        )
        ORDER BY re.enrolled_at, re.enrollment_id
        LIMIT $${limitParam}
      ),
      memberships AS (
        SELECT
          tm.user_id,
          string_agg(DISTINCT og.name, ', ' ORDER BY og.name) AS group_names,
          string_agg(DISTINCT sg.name, ', ' ORDER BY sg.name) AS subgroup_names,
          string_agg(DISTINCT t.name, ', ' ORDER BY t.name) AS team_names
        FROM selected_enrollments se
        JOIN team_members tm ON tm.user_id = se.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${membershipScope}
        GROUP BY tm.user_id
      )
      SELECT
        se.enrollment_id,
        se.user_id,
        u.username,
        u.email,
        u.full_name,
        m.group_names,
        m.subgroup_names,
        m.team_names,
        se.course_id,
        se.course_name,
        se.enrolled_at,
        se.completed_at,
        se.is_completed,
        se.progress,
        CASE WHEN se.is_completed THEN 'completed' WHEN se.has_started THEN 'learning' ELSE 'not_started' END AS status
      FROM selected_enrollments se
      JOIN users u ON u.id = se.user_id
      LEFT JOIN memberships m ON m.user_id = se.user_id
      ORDER BY se.enrolled_at, se.enrollment_id`,
    [options.tenantId, startDate, endDate, ...cohort.params, lastEnrolledAt, lastEnrollmentId, STREAM_BATCH_SIZE],
  );
  return result.rows;
}
async function writeCourseLearnerDetailSheets(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
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
    { header: 'Trạng thái', key: 'status', width: 16 },
    { header: 'Tiến độ', key: 'progress', width: 14 },
    { header: 'Hoàn thành trong kỳ', key: 'completed', width: 20 },
    { header: 'Ngày ghi danh', key: 'enrolledAt', width: 18 },
    { header: 'Ngày hoàn thành', key: 'completedAt', width: 18 },
  ];
  const writer = new SplitWorksheetWriter(workbook, 'Chi tiết khóa-học viên', 'Chi tiết lượt ghi danh theo từng khóa học', subtitle, columns);
  let lastEnrolledAt: Date | null = null;
  let lastEnrollmentId: string | null = null;
  for (;;) {
    const rows = await fetchCourseLearnerBatch(options, lastEnrolledAt, lastEnrollmentId);
    if (rows.length === 0) break;
    for (const item of rows) {
      writer.addRow([
        item.course_name, item.course_id, item.username, item.full_name || '', item.email,
        item.group_names || '', item.subgroup_names || '', item.team_names || '', statusText(item.status), roundPercent(item.progress) / 100, item.is_completed ? 'Có' : 'Chưa', item.enrolled_at, item.completed_at,
      ], (row) => {
        row.getCell(9).font = { name: 'Arial', size: 10, bold: true, color: { argb: statusColor(item.status) } };
        row.getCell(10).numFmt = '0.00%';
        row.getCell(12).numFmt = 'dd/mm/yyyy hh:mm';
        row.getCell(13).numFmt = 'dd/mm/yyyy hh:mm';
      });
    }
    const lastRow = rows[rows.length - 1];
    lastEnrolledAt = lastRow.enrolled_at;
    lastEnrollmentId = lastRow.enrollment_id;
    if (rows.length < STREAM_BATCH_SIZE) break;
  }
  writer.finish();
}
export async function streamReportExcel(options: ReportExcelExportOptions): Promise<void> {
  const scopeNames = await resolveScopeNames(options.tenantId, options.scope);
  const selectedPeriodText = getExportPeriodLabel(options);
  const yearlyPeriodText = getExportPeriodLabel(options);
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
  await writeCourseRankingSheet(workbook, options, selectedPeriodSubtitle);
  await writeLearnerSummarySheet(workbook, options, selectedPeriodSubtitle);
  await writeCourseLearnerDetailSheets(workbook, options, selectedPeriodSubtitle);

  await workbook.commit();
}
