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
  type ReportExportInput,
  type ScopeNames,
} from './reports-export.repository.js';
import type { ReportSummary } from './reports.service.js';
import {
  type ExportScope,
  type ReportExcelExportOptions,
  type CourseLearnerExcelExportOptions,
  type ReportExcelLocale,
  getReportExcelCopy,
} from './reports-export-copy.logic.js';
import {
  type ColumnDef,
  COLORS,
  thinBorder,
  getMonthRange,
  getExportPeriodRange,
  getExportPeriodLabel,
  dateTimeNumberFormat,
  formatHierarchyPeriodLabel,
  toNumber,
  roundPercent,
  statusText,
  statusColor,
  lowerLabel,
  addStyledRow,
  addWorksheetChrome,
  SplitWorksheetWriter,
} from './reports-export-sheet.js';
// The export wording and the workbook building blocks live in their own files; these names stay importable here.
export {
  normalizeReportExcelLocale,
  getReportExcelCopy,
  resolveReportExcelLabels,
  buildReportExcelFileName,
  buildCourseLearnerExcelFileName,
} from './reports-export-copy.logic.js';
export type {
  ReportExcelExportOptions,
  CourseLearnerExcelExportOptions,
  ReportExcelLocale,
} from './reports-export-copy.logic.js';

// Every read joins the export's snapshot (withReportsSnapshot) through reportsQuery.
const repository = createReportsExportRepository({ query: reportsQuery, forEachCursorBatch: forEachReportsCursorBatch });
const STREAM_BATCH_SIZE = 5_000;

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
