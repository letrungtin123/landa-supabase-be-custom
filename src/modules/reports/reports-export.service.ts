import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { env } from '../../config/env.js';
import {
  forEachReportsCursorBatch,
  reportsQuery,
  throwIfReportsAborted,
  withReportsSnapshot,
} from '../../config/reports-database.js';
import { spoolReportExport, trackWorkbookBacklog, waitForWorkbookRoom } from './report-export-flow.js';
import { loadReportPeriodOverviews, type ReportPeriodRange } from './report-period-summaries.repository.js';
import {
  createReportsExportRepository,
  type CourseLearnerRow,
  type HierarchyTrendRow,
  type ReportExportInput,
  type ScopeNames,
} from './reports-export.repository.js';
import type { ReportDateRange, ReportSummary } from './reports.service.js';

// Every read joins the export's snapshot (withReportsSnapshot) through reportsQuery.
const repository = createReportsExportRepository({ query: reportsQuery, forEachCursorBatch: forEachReportsCursorBatch });

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
  locale: ReportExcelLocale;
  /** Aborted when the client goes away: the export stops reading and writing. */
  signal?: AbortSignal;
};

export type CourseLearnerExcelExportOptions = ReportExcelExportOptions & {
  courseId: string;
  courseName: string;
};

export type ReportExcelLocale = 'vi' | 'en';

type ColumnDef = {
  header: string;
  key: string;
  width: number;
};

type ReportExcelCopy = {
  all: string;
  dateRangeSeparator: string;
  year: string;
  dataPeriod: string;
  aggregationPeriod: string;
  aggregationYear: string;
  exportedBy: string;
  exportedAt: string;
  notes: string;
  notesValue: string;
  item: string;
  value: string;
  information: string;
  reportFileInformation: string;
  dateRange: string;
  month: string;
  totalLearners: string;
  activeLearners: string;
  periodEnrollments: string;
  enrollments: string;
  completed: string;
  incomplete: string;
  averageCompletionRate: string;
  overviewForPeriod: string;
  overviewByDateRange: string;
  monthlyOverview: string;
  monthlyOverviewTitle: string;
  totalPeriodEnrollments: string;
  totalYearEnrollments: string;
  completedInYear: string;
  incompleteInYear: string;
  averageCompletionRateInYear: string;
  trendBy: string;
  teamBreakdown: string;
  /** Header of the member count, naming the team level with its label (lowercased). */
  currentTeamMembers: (team: string) => string;
  averageProgress: string;
  rank: string;
  course: string;
  courseRanking: string;
  courseCompletionRanking: string;
  username: string;
  fullName: string;
  learnerList: string;
  learnerListInScope: string;
  latestCompletion: string;
  courseLearnerDetail: string;
  courseEnrollmentDetail: string;
  status: string;
  progress: string;
  completedInPeriod: string;
  enrolledAt: string;
  completedAt: string;
  yes: string;
  no: string;
  statuses: Record<'completed' | 'learning' | 'not_started', string>;
  months: string[];
};

const REPORT_EXCEL_COPY: Record<ReportExcelLocale, ReportExcelCopy> = {
  vi: {
    all: 'Tất cả', dateRangeSeparator: 'đến', year: 'Năm', dataPeriod: 'Kỳ dữ liệu', aggregationPeriod: 'Khoảng tổng hợp', aggregationYear: 'Năm tổng hợp', exportedBy: 'Người xuất', exportedAt: 'Thời gian xuất', notes: 'Ghi chú', notesValue: 'Dữ liệu được tính theo tenant và bộ lọc phân quyền hiện tại.', item: 'Mục', value: 'Giá trị', information: 'Thông tin', reportFileInformation: 'Thông tin file báo cáo', dateRange: 'Khoảng ngày', month: 'Tháng', totalLearners: 'Tổng học viên đã tạo', activeLearners: 'Học viên có hoạt động học', periodEnrollments: 'Lượt ghi danh trong kỳ', enrollments: 'Lượt ghi danh', completed: 'Đã hoàn thành', incomplete: 'Chưa hoàn thành', averageCompletionRate: 'Tỷ lệ hoàn thành trung bình của học viên', overviewForPeriod: 'Tổng quan kỳ', overviewByDateRange: 'Tổng quan theo khoảng ngày', monthlyOverview: 'Tổng quan tháng', monthlyOverviewTitle: 'Tổng quan theo tháng - năm', totalPeriodEnrollments: 'Tổng lượt ghi danh trong khoảng', totalYearEnrollments: 'Tổng lượt ghi danh trong năm', completedInYear: 'Đã hoàn thành trong năm', incompleteInYear: 'Chưa hoàn thành trong năm', averageCompletionRateInYear: 'Tỷ lệ hoàn thành trung bình của học viên trong năm', trendBy: 'Xu hướng theo', teamBreakdown: 'Chi tiết', currentTeamMembers: (team) => `Học viên hiện thuộc ${team}`, averageProgress: 'Tiến độ trung bình', rank: 'Hạng', course: 'Khóa học', courseRanking: 'Xếp hạng khóa học', courseCompletionRanking: 'Bảng xếp hạng tỉ lệ hoàn thành từng khóa học', username: 'Username', fullName: 'Họ tên', learnerList: 'Danh sách học viên', learnerListInScope: 'Danh sách học viên trong phạm vi đang lọc', latestCompletion: 'Hoàn thành gần nhất', courseLearnerDetail: 'Chi tiết khóa-học viên', courseEnrollmentDetail: 'Chi tiết lượt ghi danh theo từng khóa học', status: 'Trạng thái', progress: 'Tiến độ', completedInPeriod: 'Hoàn thành trong kỳ', enrolledAt: 'Ngày ghi danh', completedAt: 'Ngày hoàn thành', yes: 'Có', no: 'Chưa', statuses: { completed: 'Đã học', learning: 'Đang học', not_started: 'Chưa học' }, months: ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'],
  },
  en: {
    all: 'All', dateRangeSeparator: 'to', year: 'Year', dataPeriod: 'Data period', aggregationPeriod: 'Aggregation period', aggregationYear: 'Aggregation year', exportedBy: 'Exported by', exportedAt: 'Exported at', notes: 'Notes', notesValue: 'Data is calculated using the current tenant and authorized report filters.', item: 'Item', value: 'Value', information: 'Information', reportFileInformation: 'Report file information', dateRange: 'Date range', month: 'Month', totalLearners: 'Total learners created', activeLearners: 'Learners with learning activity', periodEnrollments: 'Period enrollments', enrollments: 'Enrollments', completed: 'Completed', incomplete: 'Incomplete', averageCompletionRate: 'Average learner completion rate', overviewForPeriod: 'Period overview', overviewByDateRange: 'Overview by date range', monthlyOverview: 'Monthly overview', monthlyOverviewTitle: 'Monthly overview - year', totalPeriodEnrollments: 'Total enrollments in range', totalYearEnrollments: 'Total enrollments in year', completedInYear: 'Completed in year', incompleteInYear: 'Incomplete in year', averageCompletionRateInYear: 'Average learner completion rate in year', trendBy: 'Trend by', teamBreakdown: 'Breakdown', currentTeamMembers: (team) => `Current ${team} members`, averageProgress: 'Average progress', rank: 'Rank', course: 'Course', courseRanking: 'Course ranking', courseCompletionRanking: 'Course completion ranking', username: 'Username', fullName: 'Full name', learnerList: 'Learner list', learnerListInScope: 'Learners in the selected scope', latestCompletion: 'Latest completion', courseLearnerDetail: 'Course-learner detail', courseEnrollmentDetail: 'Course enrollment detail', status: 'Status', progress: 'Progress', completedInPeriod: 'Completed in period', enrolledAt: 'Enrolled at', completedAt: 'Completed at', yes: 'Yes', no: 'No', statuses: { completed: 'Completed', learning: 'In progress', not_started: 'Not started' }, months: ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  },
};

export function normalizeReportExcelLocale(value: unknown): ReportExcelLocale {
  return value === 'en' ? 'en' : 'vi';
}

export function getReportExcelCopy(locale: ReportExcelLocale): ReportExcelCopy {
  return REPORT_EXCEL_COPY[locale];
}

/** Localized default level names, as the dashboard shows them without tenant labels. */
const DEFAULT_EXCEL_LEVEL_LABELS: Record<ReportExcelLocale, ExportLabels> = {
  vi: { group: 'Công ty', subgroup: 'Chi nhánh', team: 'Phòng ban' },
  en: { group: 'Company', subgroup: 'Branch', team: 'Department' },
};

/**
 * Level names of the Excel export: the tenant's configured label (the name
 * every screen shows) first, then the name the client sent, then the
 * localized default.
 */
export function resolveReportExcelLabels(
  tenantLabels: Partial<Record<keyof ExportLabels, string>>,
  requested: Partial<Record<keyof ExportLabels, unknown>>,
  locale: ReportExcelLocale,
): ExportLabels {
  const pick = (key: keyof ExportLabels): string => {
    const configured = tenantLabels[key]?.trim();
    if (configured) return configured;
    const sent = requested[key];
    return (typeof sent === 'string' && sent.trim()) || DEFAULT_EXCEL_LEVEL_LABELS[locale][key];
  };
  return { group: pick('group'), subgroup: pick('subgroup'), team: pick('team') };
}

export function buildReportExcelFileName(
  locale: ReportExcelLocale,
  dateRange: ReportDateRange | undefined,
  month: number | undefined,
  year: number,
): string {
  const prefix = locale === 'en' ? 'learning-report' : 'bao-cao-tong-hop';
  if (dateRange) return `${prefix}-${dateRange.dateFrom}-${locale === 'en' ? 'to' : 'den'}-${dateRange.dateTo}.xlsx`;
  return `${prefix}-${month ? `${month}-` : ''}${year}.xlsx`;
}

function courseNameSlug(courseName: string): string {
  const slug = courseName
    .replace(/[Đđ]/g, character => character === 'Đ' ? 'D' : 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'khoa-hoc';
}

export function buildCourseLearnerExcelFileName(
  locale: ReportExcelLocale,
  courseName: string,
  dateRange: ReportDateRange | undefined,
  month: number | undefined,
  year: number,
): string {
  const prefix = locale === 'en' ? 'course-learners' : 'chi-tiet-hoc-vien';
  const period = dateRange
    ? `${dateRange.dateFrom}-${locale === 'en' ? 'to' : 'den'}-${dateRange.dateTo}`
    : `${month ? `${month}-` : ''}${year}`;
  return `${prefix}-${courseNameSlug(courseName)}-${period}.xlsx`;
}

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
  const copy = getReportExcelCopy(options.locale);
  if (options.dateRange) {
    return `${formatExportDate(options.dateRange.dateFrom, options.locale)} ${copy.dateRangeSeparator} ${formatExportDate(options.dateRange.dateTo, options.locale)}`;
  }
  return options.month ? `${copy.months[options.month]}/${options.year}` : `${copy.year} ${options.year}`;
}

function formatExportDate(value: string, locale: ReportExcelLocale): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: locale === 'en' ? 'short' : '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function dateTimeNumberFormat(locale: ReportExcelLocale): string {
  return locale === 'en' ? 'dd mmm yyyy hh:mm' : 'dd/mm/yyyy hh:mm';
}

function formatHierarchyPeriodLabel(item: HierarchyTrendRow, locale: ReportExcelLocale): string {
  const copy = getReportExcelCopy(locale);
  const month = Number(item.period_month);
  const year = Number(item.period_year);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return '';
  return locale === 'en' ? `${copy.months[month]} ${year}` : `${copy.months[month]}/${year}`;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundPercent(value: unknown): number {
  return Math.round(Math.min(Math.max(toNumber(value), 0), 100) * 100) / 100;
}

function statusText(status: string, locale: ReportExcelLocale): string {
  const statuses = getReportExcelCopy(locale).statuses;
  if (status === 'completed') return statuses.completed;
  if (status === 'learning') return statuses.learning;
  return statuses.not_started;
}

function statusColor(status: string): string {
  if (status === 'completed') return COLORS.emerald;
  if (status === 'learning') return COLORS.amber;
  return COLORS.slate;
}

function safeSheetName(baseName: string, index?: number): string {
  const suffix = index && index > 1 ? ` ${index}` : '';
  return `${baseName}${suffix}`.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31);
}

function lowerLabel(label: string, locale: ReportExcelLocale): string {
  return label.trim().toLocaleLowerCase(locale === 'en' ? 'en-US' : 'vi-VN');
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

async function resolveScopeNames(tenantId: string, scope: ExportScope, locale: ReportExcelLocale): Promise<ScopeNames> {
  const all = getReportExcelCopy(locale).all;
  if (scope.teamId) {
    return (await repository.findTeamNames(scope.teamId, tenantId)) || { groupName: all, subgroupName: all, teamName: all };
  }

  if (scope.subgroupId) {
    const row = await repository.findSubgroupNames(scope.subgroupId, tenantId);
    return { groupName: row?.groupName || all, subgroupName: row?.subgroupName || all, teamName: all };
  }

  if (scope.groupId) {
    const row = await repository.findGroupName(scope.groupId, tenantId);
    return { groupName: row?.groupName || all, subgroupName: all, teamName: all };
  }

  return { groupName: all, subgroupName: all, teamName: all };
}

async function writeInfoSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  scopeNames: ScopeNames,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns: ColumnDef[] = [
    { header: copy.item, key: 'label', width: 30 },
    { header: copy.value, key: 'value', width: 78 },
  ];
  const worksheet = addWorksheetChrome(workbook, copy.information, copy.reportFileInformation, subtitle, columns);
  const periodLabel = getExportPeriodLabel(options);

  const rows: Array<[string, unknown]> = [
    [copy.dataPeriod, periodLabel],
    [options.dateRange ? copy.aggregationPeriod : copy.aggregationYear, options.dateRange ? periodLabel : options.year],
    [options.labels.group, scopeNames.groupName],
    [options.labels.subgroup, scopeNames.subgroupName],
    [options.labels.team, scopeNames.teamName],
    [copy.exportedBy, options.exporterName],
    [copy.exportedAt, new Date()],
    [copy.notes, copy.notesValue],
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
      if (item[0] === copy.exportedAt && i === 2) cell.numFmt = dateTimeNumberFormat(options.locale);
    }
    row.commit();
  });

  worksheet.commit();
}

type ReportOverview = ReportSummary['overview'];

/** Overview figures of each range in the export's scope (one statement for all of them). */
function loadExportOverviews(options: ReportExcelExportOptions, ranges: ReportPeriodRange[]): Promise<ReportOverview[]> {
  return loadReportPeriodOverviews({
    tenantId: options.tenantId,
    ranges,
    groupId: options.scope.groupId,
    subgroupId: options.scope.subgroupId,
    teamId: options.scope.teamId,
  });
}

async function writeMonthlyOverviewSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns: ColumnDef[] = [
    { header: options.dateRange ? copy.dateRange : copy.month, key: 'month', width: 22 },
    { header: copy.totalLearners, key: 'totalLearners', width: 22 },
    { header: copy.activeLearners, key: 'activeLearners', width: 24 },
    { header: copy.periodEnrollments, key: 'enrollments', width: 20 },
    { header: copy.completed, key: 'completedEnrollments', width: 18 },
    { header: copy.incomplete, key: 'incompleteEnrollments', width: 18 },
    { header: copy.averageCompletionRate, key: 'completionRate', width: 36 },
  ];
  const worksheet = addWorksheetChrome(
    workbook,
    options.dateRange ? copy.overviewForPeriod : copy.monthlyOverview,
    options.dateRange ? copy.overviewByDateRange : `${copy.monthlyOverviewTitle} ${options.year}`,
    subtitle,
    columns,
  );

  const addOverviewRow = (label: string, overview: ReportOverview | null, index: number): void => {
    const rate = overview ? roundPercent(overview.completion_rate) : null;
    const row = worksheet.addRow([
      label,
      overview?.total_learners ?? '',
      overview?.active_learners ?? '',
      overview?.total_enrollments ?? '',
      overview?.completed_enrollments ?? '',
      overview?.incomplete_enrollments ?? '',
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
    const [overview] = await loadExportOverviews(options, [options.dateRange]);
    addOverviewRow(getExportPeriodLabel(options), overview, 0);
    addStyledRow(worksheet, [], columns.length, 'spacer');
    addStyledRow(worksheet, [copy.totalPeriodEnrollments, overview.total_enrollments], columns.length, 'summary');
    addStyledRow(worksheet, [copy.completed, overview.completed_enrollments], columns.length, 'summary');
    addStyledRow(worksheet, [copy.incomplete, overview.incomplete_enrollments], columns.length, 'summary');
    addStyledRow(worksheet, [copy.averageCompletionRate, `${roundPercent(overview.completion_rate).toFixed(2)}%`], columns.length, 'summary');
    worksheet.commit();
    return;
  }

  const now = new Date();
  const maxMonth = options.year > now.getFullYear() ? 0 : options.year === now.getFullYear() ? now.getMonth() + 1 : 12;
  let totalEnrollments = 0;
  let completedEnrollments = 0;
  let incompleteEnrollments = 0;

  // The months up to maxMonth and the year so far (January to the end of
  // maxMonth), all in one statement; months after maxMonth stay empty.
  const monthRanges: ReportPeriodRange[] = [];
  for (let month = 1; month <= maxMonth; month++) monthRanges.push(getMonthRange(options.year, month));
  const annualRange: ReportPeriodRange | null = maxMonth === 0
    ? null
    : { startDate: new Date(options.year, 0, 1), endDate: getMonthRange(options.year, maxMonth).endDate };
  const overviews = await loadExportOverviews(options, annualRange ? [...monthRanges, annualRange] : monthRanges);

  for (let month = 1; month <= 12; month++) {
    const overview = month > maxMonth ? null : overviews[month - 1];
    if (overview) {
      totalEnrollments += overview.total_enrollments;
      completedEnrollments += overview.completed_enrollments;
      incompleteEnrollments += overview.incomplete_enrollments;
    }
    addOverviewRow(copy.months[month], overview, month - 1);
  }

  const annualOverview = annualRange ? overviews[maxMonth] : null;
  const yearlyRate = annualOverview?.completion_rate ?? 0;
  addStyledRow(worksheet, [], columns.length, 'spacer');
  addStyledRow(worksheet, [copy.totalYearEnrollments, totalEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, [copy.completedInYear, completedEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, [copy.incompleteInYear, incompleteEnrollments], columns.length, 'summary');
  addStyledRow(worksheet, [copy.averageCompletionRateInYear, `${yearlyRate.toFixed(2)}%`], columns.length, 'summary');
  worksheet.commit();
}
async function writeHierarchyTrendSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns: ColumnDef[] = [
    { header: options.dateRange ? copy.dateRange : copy.month, key: 'month', width: 22 },
    { header: options.labels.group, key: 'groupName', width: 24 },
    { header: options.labels.subgroup, key: 'subgroupName', width: 26 },
    { header: options.labels.team, key: 'teamName', width: 28 },
    { header: copy.enrollments, key: 'enrollments', width: 16 },
    { header: copy.completed, key: 'completedEnrollments', width: 16 },
    { header: copy.incomplete, key: 'incompleteEnrollments', width: 16 },
    { header: copy.activeLearners, key: 'activeLearners', width: 22 },
    { header: copy.averageProgress, key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(workbook, `${copy.trendBy} ${options.labels.team}`, `${copy.trendBy} ${lowerLabel(options.labels.team, options.locale)} - ${getExportPeriodLabel(options)}`, subtitle, columns);
  const rows = await repository.selectHierarchyTrend(exportInput(options));
  rows.forEach((item, index) => {
    const row = worksheet.addRow([
      formatHierarchyPeriodLabel(item, options.locale), item.group_name, item.subgroup_name, item.team_name,
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
async function writeTeamBreakdownSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns: ColumnDef[] = [
    { header: options.labels.group, key: 'groupName', width: 24 },
    { header: options.labels.subgroup, key: 'subgroupName', width: 26 },
    { header: options.labels.team, key: 'teamName', width: 28 },
    { header: copy.currentTeamMembers(lowerLabel(options.labels.team, options.locale)), key: 'memberCount', width: 22 },
    { header: copy.periodEnrollments, key: 'enrollments', width: 20 },
    { header: copy.completed, key: 'completed', width: 18 },
    { header: copy.incomplete, key: 'incomplete', width: 18 },
    { header: copy.averageProgress, key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(workbook, `${copy.teamBreakdown} ${options.labels.team}`, `${copy.teamBreakdown} ${lowerLabel(options.labels.team, options.locale)}`, subtitle, columns);
  const rows = await repository.selectTeamBreakdown(exportInput(options));
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
async function writeCourseRankingSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns: ColumnDef[] = [
    { header: copy.rank, key: 'rank', width: 10 },
    { header: copy.course, key: 'courseName', width: 46 },
    { header: 'Course ID', key: 'courseId', width: 38 },
    { header: copy.periodEnrollments, key: 'enrollments', width: 20 },
    { header: copy.completed, key: 'completed', width: 18 },
    { header: copy.incomplete, key: 'incomplete', width: 18 },
    { header: copy.averageProgress, key: 'completionRate', width: 18 },
  ];
  const worksheet = addWorksheetChrome(
    workbook, copy.courseRanking, copy.courseCompletionRanking, subtitle, columns,
  );
  const rows = await repository.selectCourseRanking(exportInput(options));
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
}
async function writeLearnerSummarySheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns: ColumnDef[] = [
    { header: copy.username, key: 'username', width: 26 },
    { header: copy.fullName, key: 'fullName', width: 26 },
    { header: 'Email', key: 'email', width: 34 },
    { header: options.labels.group, key: 'groups', width: 24 },
    { header: options.labels.subgroup, key: 'subgroups', width: 28 },
    { header: options.labels.team, key: 'teams', width: 30 },
    { header: copy.periodEnrollments, key: 'enrollments', width: 20 },
    { header: copy.completed, key: 'completed', width: 18 },
    { header: copy.incomplete, key: 'incomplete', width: 18 },
    { header: copy.averageProgress, key: 'completionRate', width: 18 },
    { header: copy.latestCompletion, key: 'lastCompletion', width: 20 },
  ];
  const writer = new SplitWorksheetWriter(workbook, copy.learnerList, copy.learnerListInScope, subtitle, columns);
  await repository.streamLearnerSummary(exportInput(options), { batchSize: STREAM_BATCH_SIZE, signal: options.signal }, async (rows) => {
    await waitForWorkbookRoom(workbook, options.signal);
    for (const item of rows) {
      const rate = roundPercent(item.completion_rate);
      writer.addRow([
        item.username, item.full_name || '', item.email, item.group_names || '', item.subgroup_names || '', item.team_names || '',
        toNumber(item.enrolled_courses), toNumber(item.completed_courses), toNumber(item.incomplete_courses), rate / 100, item.last_completion_at,
      ], (row) => {
        row.getCell(10).numFmt = '0.00%';
        row.getCell(10).font = { name: 'Arial', size: 10, bold: true, color: { argb: rate >= 80 ? COLORS.emerald : rate >= 50 ? COLORS.amber : COLORS.red } };
        row.getCell(11).numFmt = dateTimeNumberFormat(options.locale);
      });
    }
  });
  writer.finish();
}
function courseLearnerColumns(options: ReportExcelExportOptions): ColumnDef[] {
  const copy = getReportExcelCopy(options.locale);
  return [
    { header: copy.course, key: 'courseName', width: 42 },
    { header: 'Course ID', key: 'courseId', width: 38 },
    { header: copy.username, key: 'username', width: 24 },
    { header: copy.fullName, key: 'fullName', width: 24 },
    { header: 'Email', key: 'email', width: 34 },
    { header: options.labels.group, key: 'groups', width: 24 },
    { header: options.labels.subgroup, key: 'subgroups', width: 28 },
    { header: options.labels.team, key: 'teams', width: 30 },
    { header: copy.status, key: 'status', width: 16 },
    { header: copy.progress, key: 'progress', width: 14 },
    { header: copy.completedInPeriod, key: 'completed', width: 20 },
    { header: copy.enrolledAt, key: 'enrolledAt', width: 18 },
    { header: copy.completedAt, key: 'completedAt', width: 18 },
  ];
}

function addCourseLearnerRow(
  writer: SplitWorksheetWriter,
  item: CourseLearnerRow,
  options: ReportExcelExportOptions,
): void {
  const copy = getReportExcelCopy(options.locale);
  writer.addRow([
    item.course_name, item.course_id, item.username, item.full_name || '', item.email,
    item.group_names || '', item.subgroup_names || '', item.team_names || '', statusText(item.status, options.locale), roundPercent(item.progress) / 100, item.is_completed ? copy.yes : copy.no, item.enrolled_at, item.completed_at,
  ], (row) => {
    row.getCell(9).font = { name: 'Arial', size: 10, bold: true, color: { argb: statusColor(item.status) } };
    row.getCell(10).numFmt = '0.00%';
    row.getCell(12).numFmt = dateTimeNumberFormat(options.locale);
    row.getCell(13).numFmt = dateTimeNumberFormat(options.locale);
  });
}

async function writeCourseLearnerDetailSheets(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  options: ReportExcelExportOptions,
  subtitle: string,
): Promise<void> {
  const copy = getReportExcelCopy(options.locale);
  const columns = courseLearnerColumns(options);
  const writer = new SplitWorksheetWriter(workbook, copy.courseLearnerDetail, copy.courseEnrollmentDetail, subtitle, columns);
  await repository.streamCourseLearners(exportInput(options), { batchSize: STREAM_BATCH_SIZE, signal: options.signal }, async (rows) => {
    await waitForWorkbookRoom(workbook, options.signal);
    for (const item of rows) addCourseLearnerRow(writer, item, options);
  });
  writer.finish();
}

/** What the repository reads for an export: tenant, period bounds and scope. */
function exportInput(options: ReportExcelExportOptions): ReportExportInput {
  const { startDate, endDate } = getExportPeriodRange(options);
  return { tenantId: options.tenantId, startDate, endDate, scope: options.scope };
}

/** Snapshot of an export: its own raised statement timeout and the client's abort signal. */
function exportSnapshotOptions(options: ReportExcelExportOptions): { statementTimeoutMs: number; signal?: AbortSignal } {
  return { statementTimeoutMs: env.REPORTS_EXPORT_STATEMENT_TIMEOUT_MS, signal: options.signal };
}

/** A streaming workbook on `stream` whose sheet backlog the cursor sheets wait on (report-export-flow.ts). */
function createExportWorkbook(stream: Writable, exporterName: string): ExcelJS.stream.xlsx.WorkbookWriter {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: false,
  });
  trackWorkbookBacklog(writer);
  writer.creator = 'Landa';
  writer.lastModifiedBy = exporterName || 'Landa';
  writer.created = new Date();
  writer.modified = new Date();
  return writer;
}

/**
 * The file is generated into a temp file and sent to options.stream as it
 * grows, at the client's pace (report-export-flow.ts); the export stops when
 * options.signal aborts or the stream goes away.
 */
export async function streamCourseLearnerExcel(options: CourseLearnerExcelExportOptions): Promise<void> {
  await spoolReportExport(options.stream, options.signal, (sink, signal) => writeCourseLearnerWorkbook({ ...options, stream: sink, signal }));
}

export async function streamReportExcel(options: ReportExcelExportOptions): Promise<void> {
  await spoolReportExport(options.stream, options.signal, (sink, signal) => writeReportWorkbook({ ...options, stream: sink, signal }));
}

/**
 * Every read of the file runs in one READ ONLY REPEATABLE READ snapshot on
 * the reports pool; its connection is released before the zip is finalized.
 */
async function writeCourseLearnerWorkbook(options: CourseLearnerExcelExportOptions): Promise<void> {
  const workbook = await withReportsSnapshot(exportSnapshotOptions(options), async () => {
    const copy = getReportExcelCopy(options.locale);
    const scopeNames = await resolveScopeNames(options.tenantId, options.scope, options.locale);
    const subtitle = [
      `${copy.course}: ${options.courseName}`,
      `${copy.dataPeriod}: ${getExportPeriodLabel(options)}`,
      `${options.labels.group}: ${scopeNames.groupName}`,
      `${options.labels.subgroup}: ${scopeNames.subgroupName}`,
      `${options.labels.team}: ${scopeNames.teamName}`,
      `${copy.exportedBy}: ${options.exporterName}`,
    ].join(' | ');
    const writer = createExportWorkbook(options.stream, options.exporterName);

    const sheet = new SplitWorksheetWriter(
      writer,
      copy.courseLearnerDetail,
      copy.courseEnrollmentDetail,
      subtitle,
      courseLearnerColumns(options),
    );
    const courseInput = { ...exportInput(options), courseId: options.courseId };
    await repository.streamSingleCourseLearners(courseInput, { batchSize: STREAM_BATCH_SIZE, signal: options.signal }, async (rows) => {
      await waitForWorkbookRoom(writer, options.signal);
      for (const item of rows) addCourseLearnerRow(sheet, item, options);
    });
    sheet.finish();
    return writer;
  });
  throwIfReportsAborted(options.signal);
  await workbook.commit();
}

async function writeReportWorkbook(options: ReportExcelExportOptions): Promise<void> {
  const workbook = await withReportsSnapshot(exportSnapshotOptions(options), async () => {
    const copy = getReportExcelCopy(options.locale);
    const scopeNames = await resolveScopeNames(options.tenantId, options.scope, options.locale);
    const selectedPeriodText = getExportPeriodLabel(options);
    const yearlyPeriodText = getExportPeriodLabel(options);
    const buildSubtitle = (periodText: string): string => [
      `${copy.dataPeriod}: ${periodText}`,
      `${options.labels.group}: ${scopeNames.groupName}`,
      `${options.labels.subgroup}: ${scopeNames.subgroupName}`,
      `${options.labels.team}: ${scopeNames.teamName}`,
      `${copy.exportedBy}: ${options.exporterName}`,
    ].join(' | ');
    const selectedPeriodSubtitle = buildSubtitle(selectedPeriodText);
    const yearlySubtitle = buildSubtitle(yearlyPeriodText);

    const writer = createExportWorkbook(options.stream, options.exporterName);

    // The export stops between sheets once the client has gone away.
    const sheets: Array<() => Promise<unknown>> = [
      () => writeInfoSheet(writer, options, scopeNames, selectedPeriodSubtitle),
      () => writeMonthlyOverviewSheet(writer, options, yearlySubtitle),
      () => writeHierarchyTrendSheet(writer, options, yearlySubtitle),
      () => writeTeamBreakdownSheet(writer, options, yearlySubtitle),
      () => writeCourseRankingSheet(writer, options, selectedPeriodSubtitle),
      () => writeLearnerSummarySheet(writer, options, selectedPeriodSubtitle),
      () => writeCourseLearnerDetailSheets(writer, options, selectedPeriodSubtitle),
    ];
    for (const writeSheet of sheets) {
      throwIfReportsAborted(options.signal);
      await writeSheet();
    }
    return writer;
  });
  throwIfReportsAborted(options.signal);
  await workbook.commit();
}
