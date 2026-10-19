// Report export options and wording: the options types, the vi/en copy of
// the workbook, the level labels and the file names. Pure; moved unchanged
// from reports-export.service.ts, which re-exports them.

import type { Writable } from 'node:stream';
import type { ReportDateRange } from './reports.service.js';

export type ExportScope = {
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
