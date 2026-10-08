// Synthetic report snapshots for report-PDF tests and visual samples. All
// tenants, courses and units are fictional. Snapshots are assembled through
// the production createReportSnapshot so metrics and signals stay consistent.
import {
  createReportSnapshot,
  getReportSnapshotHash,
  type ReportChatSnapshot,
  type ReportSnapshotExtensions,
  type StoredReportChatSnapshot,
} from './report-chat.service.js';
import type { ReportCoursePerformance, ReportSummary } from '../reports/reports.service.js';
import type { ReportUnitBreakdownRow, ReportUnitLevel } from './report-unit-breakdown.logic.js';

type CourseSpec = [name: string, enrollments: number, completed: number, inProgress: number, notStarted: number, rate: number];

export interface ReportPdfFixture {
  name: string;
  tenantName: string;
  locale: 'vi' | 'en';
  snapshot: StoredReportChatSnapshot;
  snapshotHash: string;
  storedNarrative?: unknown;
}

function summary(dateFrom: string, dateTo: string, overview: ReportSummary['overview']): ReportSummary {
  const [year, month] = dateFrom.split('-').map(Number);
  return { meta: { month, year, month_label: `${String(month).padStart(2, '0')}/${year}`, is_current_month: false, date_from: dateFrom, date_to: dateTo }, overview };
}

function portfolio(specs: CourseSpec[]): ReportCoursePerformance[] {
  return specs.map(([name, total, completed, inProgress, notStarted, rate], index) => {
    if (completed + inProgress + notStarted !== total) throw new Error(`Fixture course ${name} does not reconcile`);
    return {
      course_id: `course-${String(index + 1).padStart(2, '0')}`,
      name,
      total_enrollments: total,
      completed_enrollments: completed,
      incomplete_enrollments: total - completed,
      not_started_enrollments: notStarted,
      in_progress_enrollments: inProgress,
      completion_rate: rate,
    };
  });
}

function daily(year: number, month: number, values: number[]): Array<{ bucket: string; label: string; value: number }> {
  return values.map((value, index) => {
    const day = String(index + 1).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return { bucket: `${year}-${mm}-${day}`, label: `${day}/${mm}/${year}`, value };
  });
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Comparison-period series in the snapshot's stored shape. */
function previousSeries(year: number, month: number, values: number[]): Array<{ bucket: string; value: number }> {
  return daily(year, month, values).map(({ bucket, value }) => ({ bucket, value }));
}

type UnitSpec = [name: string, learners: number, active: number, enrollments: number, completed: number, rate: number, previousEnrollments: number, previousRate: number | null];

function unitRows(specs: UnitSpec[], idPrefix: string): ReportUnitBreakdownRow[] {
  return specs.map(([name, learners, active, enrollments, completed, rate, previousEnrollments, previousRate], index) => ({
    kind: 'unit',
    unit_id: `${idPrefix}-${String(index + 1).padStart(2, '0')}`,
    name,
    learners,
    active_learners: active,
    enrollments,
    completed_enrollments: completed,
    completion_rate: rate,
    previous_enrollments: previousEnrollments,
    previous_completion_rate: previousRate,
  }));
}

function breakdown(level: ReportUnitLevel, rows: ReportUnitBreakdownRow[], scopeLearners: number): ReportSnapshotExtensions {
  return { unit_breakdown: { level, limit: 30, scope_learners: scopeLearners, rows }, unit_breakdown_status: 'available' };
}

function build(input: {
  dateFrom: string; dateTo: string; previousFrom: string; previousTo: string;
  basis: ReportChatSnapshot['comparison']['basis'];
  generatedAt: string;
  scope: { groupId?: string; subgroupId?: string; teamId?: string };
  scopeDisplay: ReportChatSnapshot['scope_display'];
  current: ReportSummary['overview']; previous: ReportSummary['overview'];
  enrollmentTrend: Array<{ bucket: string; label: string; value: number }>;
  activeTrend: Array<{ bucket: string; label: string; value: number }>;
  courses: ReportCoursePerformance[];
  availability?: ReportChatSnapshot['availability']['state'];
  extensions?: ReportSnapshotExtensions;
}): ReportChatSnapshot {
  const status = input.courses.reduce((acc, course) => ({
    completed: acc.completed + course.completed_enrollments,
    in_progress: acc.in_progress + course.in_progress_enrollments,
    not_started: acc.not_started + course.not_started_enrollments,
  }), { completed: 0, in_progress: 0, not_started: 0 });
  return createReportSnapshot(
    {
      version: 2,
      generated_at: input.generatedAt,
      timezone: 'Asia/Ho_Chi_Minh',
      filter: {
        date_from: input.dateFrom, date_to: input.dateTo,
        ...(input.scope.groupId ? { group_id: input.scope.groupId } : {}),
        ...(input.scope.subgroupId ? { subgroup_id: input.scope.subgroupId } : {}),
        ...(input.scope.teamId ? { team_id: input.scope.teamId } : {}),
      },
      scope: { groupId: input.scope.groupId, subgroupId: input.scope.subgroupId, teamId: input.scope.teamId },
      comparison: { date_from: input.previousFrom, date_to: input.previousTo, basis: input.basis },
    },
    summary(input.dateFrom, input.dateTo, input.current),
    summary(input.previousFrom, input.previousTo, input.previous),
    input.enrollmentTrend,
    input.activeTrend,
    [...input.courses].sort((left, right) => right.total_enrollments - left.total_enrollments || left.completion_rate - right.completion_rate),
    status,
    input.scopeDisplay,
    input.availability ?? 'available',
    { granularity: 'day' },
    undefined,
    input.extensions,
  );
}

function fixture(name: string, tenantName: string, locale: 'vi' | 'en', snapshot: StoredReportChatSnapshot, storedNarrative?: unknown): ReportPdfFixture {
  return { name, tenantName, locale, snapshot, snapshotHash: getReportSnapshotHash(snapshot), storedNarrative };
}

const VI_COURSES: CourseSpec[] = [
  ['An toàn lao động và 5S tại nơi làm việc', 58, 41, 12, 5, 78.4],
  ['Kỹ năng tư vấn bán hàng dược phẩm', 47, 17, 19, 11, 49.6],
  ['Quy trình GPP tại nhà thuốc', 41, 33, 6, 2, 86.9],
  ['Chăm sóc khách hàng xuất sắc', 33, 24, 7, 2, 80.2],
  ['Phòng chống tham nhũng và tuân thủ', 29, 26, 2, 1, 93.1],
  ['Lập kế hoạch kinh doanh cho quản lý cửa hàng', 24, 7, 9, 8, 41.3],
  ['Excel nâng cao cho báo cáo bán hàng', 19, 9, 8, 2, 64.5],
  ['Quản lý tồn kho và hạn dùng', 16, 10, 4, 2, 70.8],
  ['Kỹ năng lãnh đạo cho trưởng nhóm', 12, 3, 5, 4, 38.7],
  ['Hội nhập nhân viên mới 2026', 11, 11, 0, 0, 100],
  ['Bảo mật thông tin và an ninh mạng cơ bản', 9, 6, 2, 1, 74],
  ['Giao tiếp hiệu quả trong nhóm', 7, 4, 2, 1, 66.4],
  ['Sơ cấp cứu tại nơi làm việc', 5, 2, 2, 1, 52],
  ['Kiến thức sản phẩm: Nhóm thực phẩm chức năng', 4, 1, 1, 2, 35.5],
];
const VI_ENROLLMENTS = [14, 13, 9, 3, 2, 15, 14, 13, 12, 9, 2, 1, 16, 19, 34, 24, 12, 3, 2, 14, 13, 12, 9, 8, 2, 1, 11, 10, 7, 6, 5];
const VI_ACTIVE = [38, 41, 36, 12, 9, 44, 46, 43, 40, 35, 11, 8, 47, 52, 61, 55, 42, 14, 10, 45, 43, 40, 37, 33, 10, 7, 34, 31, 29, 27, 24];
/** June 2026 (starts on a Monday), 262 enrollments in total. */
const VI_PREVIOUS_ENROLLMENTS = [11, 12, 10, 11, 9, 3, 2, 12, 11, 11, 10, 10, 2, 2, 13, 12, 11, 11, 9, 3, 2, 11, 10, 12, 10, 9, 2, 3, 14, 14];
const VI_PREVIOUS_ACTIVE = [36, 39, 37, 35, 33, 11, 8, 40, 41, 38, 36, 34, 10, 9, 42, 44, 41, 39, 35, 12, 9, 38, 37, 36, 34, 31, 9, 7, 33, 35];
/**
 * Teams of the branch. No learner is in two teams, so the rows reconcile with
 * the scope: 230 learners, 198 active, 315 enrollments (194 completed), 262
 * comparison enrollments; the learner-weighted rates give 61.84% and 58.12%.
 */
const VI_UNITS: UnitSpec[] = [
  ['Cửa hàng Quận 1', 38, 36, 58, 41, 71.2, 49, 64.9],
  ['Cửa hàng Quận 3', 31, 29, 47, 30, 64.1, 40, 58.9],
  ['Cửa hàng Thủ Đức', 34, 28, 44, 24, 57.3, 41, 63.8],
  ['Cửa hàng Bình Thạnh', 29, 25, 39, 27, 66.3, 33, 61.6],
  ['Cửa hàng Gò Vấp', 27, 21, 36, 15, 46.2, 30, 49.5],
  ['Cửa hàng Tân Bình', 25, 22, 33, 22, 62.9, 28, 56.1],
  ['Phòng Chăm sóc khách hàng', 22, 19, 30, 23, 77.4, 24, 74.5],
  ['Kho vận Hồ Chí Minh', 18, 13, 22, 8, 39.5, 17, 41.2],
  ['Nhóm Đào tạo nội bộ (thí điểm)', 6, 5, 6, 4, 71, 0, null],
];

function vietnameseSnapshot(input: {
  scope: { groupId?: string; subgroupId?: string; teamId?: string };
  scopeDisplay: ReportChatSnapshot['scope_display'];
  extensions: ReportSnapshotExtensions;
}): ReportChatSnapshot {
  const courses = portfolio(VI_COURSES);
  const completed = sum(courses.map((course) => course.completed_enrollments));
  const total = sum(VI_ENROLLMENTS);
  return build({
    dateFrom: '2026-07-01', dateTo: '2026-07-31', previousFrom: '2026-06-01', previousTo: '2026-06-30', basis: 'calendar_month',
    generatedAt: '2026-08-01T01:15:00.000Z',
    scope: input.scope,
    scopeDisplay: input.scopeDisplay,
    current: { total_learners: 46, active_learners: 198, completion_rate: 61.84, total_enrollments: total, completed_enrollments: completed, incomplete_enrollments: total - completed },
    previous: { total_learners: 38, active_learners: 171, completion_rate: 58.12, total_enrollments: sum(VI_PREVIOUS_ENROLLMENTS), completed_enrollments: 151, incomplete_enrollments: sum(VI_PREVIOUS_ENROLLMENTS) - 151 },
    enrollmentTrend: daily(2026, 7, VI_ENROLLMENTS),
    activeTrend: daily(2026, 7, VI_ACTIVE),
    courses,
    extensions: {
      previous_enrollment_trend: previousSeries(2026, 6, VI_PREVIOUS_ENROLLMENTS),
      previous_active_learner_trend: previousSeries(2026, 6, VI_PREVIOUS_ACTIVE),
      ...input.extensions,
    },
  });
}

/** Production-shaped Vietnamese report (July 2026, company › branch scope, broken down by team). */
export function vietnameseReportFixture(): ReportPdfFixture {
  const snapshot = vietnameseSnapshot({
    scope: { groupId: '5b0c2f4e-1d7a-4e8b-9c3f-2a6d8e1f4b70', subgroupId: '8e3a1c9d-4f2b-4a6e-b7d1-0c5f9e2a3b84' },
    scopeDisplay: { group_name: 'Khối Kinh doanh', subgroup_name: 'Chi nhánh Hồ Chí Minh' },
    extensions: breakdown('team', unitRows(VI_UNITS, 'vi-team'), 230),
  });
  return fixture('vi', 'Công ty Cổ phần Dược phẩm An Khang', 'vi', snapshot, {
    selected_signal_ids: ['high_enrollment_low_completion'],
    interpretation: ['Mức độ tham gia tăng tốt, nhưng một số khóa học kỹ năng bán hàng cần được hỗ trợ thêm để hoàn thành.'],
    recommended_actions: [{ signal_id: 'high_enrollment_low_completion', priority: 'high', action: 'Phối hợp với quản lý chi nhánh để nhắc học viên hoàn thành các khóa kỹ năng bán hàng đang dở dang.' }],
    limitations: [],
  });
}

const EN_COURSES: CourseSpec[] = [
  ['Customer Service Fundamentals', 72, 31, 14, 27, 51.2],
  ['Point-of-Sale System Training', 64, 40, 10, 14, 70.3],
  ['Food Safety & Hygiene Certification', 55, 33, 9, 13, 68],
  ['Visual Merchandising Essentials', 41, 9, 8, 24, 31.7],
  ['Loss Prevention Awareness', 38, 21, 6, 11, 61.5],
  ['Store Manager Leadership Program', 33, 8, 10, 15, 36.2],
  ['Inventory Management Basics', 30, 12, 7, 11, 49],
  ['Workplace Health and Safety', 27, 19, 4, 4, 79.6],
  ['Data Privacy for Frontline Staff', 22, 6, 6, 10, 38.9],
  ['Upselling and Cross-selling Techniques', 19, 5, 7, 7, 44.1],
  ['New Hire Onboarding: Week One', 18, 16, 2, 0, 94.4],
  ['Conflict Resolution at the Counter', 15, 3, 5, 7, 33],
  ['Product Knowledge: Seasonal Collection', 13, 6, 4, 3, 58.8],
  ['Diversity, Equity and Inclusion Basics', 11, 4, 3, 4, 47.3],
  ['Cash Handling Procedures', 10, 6, 3, 1, 72.5],
  ['Social Media Guidelines for Employees', 8, 2, 3, 3, 40.6],
  ['Emergency Evacuation Drill Briefing', 6, 5, 1, 0, 88.3],
  ['Advanced Excel for Area Managers', 4, 1, 1, 2, 37.5],
];
const EN_ENROLLMENTS = [6, 4, 33, 46, 29, 27, 24, 5, 3, 29, 27, 25, 24, 21, 4, 3, 21, 20, 19, 17, 15, 3, 2, 15, 14, 13, 12, 11, 2, 2, 10];
const EN_ACTIVE = [22, 15, 64, 71, 66, 62, 58, 18, 12, 60, 57, 55, 52, 49, 14, 11, 47, 45, 41, 38, 36, 9, 7, 22, 19, 17, 16, 14, 5, 4, 12];
const EN_PREVIOUS_ENROLLMENTS = [15, 14, 13, 4, 3, 16, 15, 14, 14, 13, 3, 2, 16, 15, 15, 14, 13, 3, 2, 16, 15, 15, 14, 13, 3, 2, 17, 16, 15, 14, 18];

const EN_PREVIOUS_ACTIVE = [48, 46, 44, 15, 12, 52, 50, 49, 47, 45, 14, 11, 51, 50, 49, 47, 46, 13, 10, 50, 48, 47, 45, 44, 12, 10, 49, 47, 46, 45, 52];
const EN_UNITS: UnitSpec[] = [
  ['North Region Stores', 128, 86, 141, 79, 63.4, 112, 61.2],
  ['South Region Stores', 116, 61, 126, 47, 44.8, 98, 55.1],
  ['Central Distribution Center', 64, 39, 77, 41, 58.9, 61, 57.6],
  ['Head Office', 42, 31, 58, 36, 71.5, 47, 69.8],
  ['E-commerce Operations', 37, 18, 52, 17, 39.2, 44, 46],
  ['Franchise Partners Network (pilot)', 21, 6, 32, 7, 28.6, 0, null],
];

function englishSnapshot(extensions?: ReportSnapshotExtensions): ReportChatSnapshot {
  const courses = portfolio(EN_COURSES);
  const completed = sum(courses.map((course) => course.completed_enrollments));
  const total = sum(EN_ENROLLMENTS);
  return build({
    dateFrom: '2026-08-01', dateTo: '2026-08-31', previousFrom: '2026-07-01', previousTo: '2026-07-31', basis: 'calendar_month',
    generatedAt: '2026-09-01T02:30:00.000Z',
    scope: {},
    scopeDisplay: {},
    current: { total_learners: 64, active_learners: 241, completion_rate: 52.1, total_enrollments: total, completed_enrollments: completed, incomplete_enrollments: total - completed },
    previous: { total_learners: 52, active_learners: 268, completion_rate: 57.4, total_enrollments: sum(EN_PREVIOUS_ENROLLMENTS), completed_enrollments: 198, incomplete_enrollments: sum(EN_PREVIOUS_ENROLLMENTS) - 198 },
    enrollmentTrend: daily(2026, 8, EN_ENROLLMENTS),
    activeTrend: daily(2026, 8, EN_ACTIVE),
    courses,
    extensions,
  });
}

/**
 * Production-shaped English report (August 2026, whole tenant, declining
 * month) from a snapshot built before the unit breakdown existed.
 */
export function englishReportFixture(): ReportPdfFixture {
  return fixture('en', 'Northwind Retail Academy', 'en', englishSnapshot());
}

/** The same English report with the unit breakdown and the comparison series. */
export function englishExtendedReportFixture(): ReportPdfFixture {
  const snapshot = englishSnapshot({
    previous_enrollment_trend: previousSeries(2026, 7, EN_PREVIOUS_ENROLLMENTS),
    previous_active_learner_trend: previousSeries(2026, 7, EN_PREVIOUS_ACTIVE),
    ...breakdown('group', unitRows(EN_UNITS, 'en-group'), 408),
  });
  return fixture('en-extended', 'Northwind Retail Academy', 'en', snapshot);
}

const VI_PROVINCES = [
  'Hà Nội', 'Hải Phòng', 'Quảng Ninh', 'Bắc Ninh', 'Nam Định', 'Thanh Hóa', 'Nghệ An', 'Thừa Thiên Huế', 'Đà Nẵng', 'Quảng Nam',
  'Bình Định', 'Khánh Hòa', 'Đắk Lắk', 'Lâm Đồng', 'Bình Dương', 'Đồng Nai', 'Bà Rịa - Vũng Tàu', 'Long An', 'Tiền Giang', 'Cần Thơ',
  'An Giang', 'Kiên Giang', 'Cà Mau', 'Tây Ninh', 'Bến Tre', 'Vĩnh Long', 'Sóc Trăng', 'Thái Nguyên', 'Lào Cai', 'Phú Thọ',
];

/**
 * Stress case: a tenant-wide breakdown of 34 member companies, the 30 with
 * the most enrollments listed, 4 grouped as "other units", plus learners in no
 * unit. Counts are deterministic; rows are not meant to reconcile exactly.
 */
export function manyUnitsReportFixture(): ReportPdfFixture {
  const units: ReportUnitBreakdownRow[] = VI_PROVINCES.map((province, index) => {
    const enrollments = 19 - Math.floor(index / 3);
    const learners = Math.max(4, Math.round(enrollments * 0.8));
    const rate = Math.round((38 + ((index * 37) % 53)) * 10) / 10;
    const previousRate = index % 4 === 0 ? null : Math.round((rate + ((index * 13) % 11) - 4) * 10) / 10;
    return {
      kind: 'unit', unit_id: `vi-co-${String(index + 1).padStart(2, '0')}`, name: `Công ty thành viên ${province}`,
      learners, active_learners: Math.max(1, learners - (index % 3)), enrollments,
      completed_enrollments: Math.round((enrollments * rate) / 120), completion_rate: rate,
      previous_enrollments: previousRate === null ? 0 : Math.max(5, enrollments - 2), previous_completion_rate: previousRate,
    };
  });
  const aggregates: ReportUnitBreakdownRow[] = [
    { kind: 'others', unit_id: '__others__', name: 'Other units', unit_count: 4, learners: 11, active_learners: 8, enrollments: 12, completed_enrollments: 5, completion_rate: 48.3, previous_enrollments: 10, previous_completion_rate: 51 },
    { kind: 'unassigned', unit_id: '__unassigned__', name: 'Other (not in any unit)', learners: 7, active_learners: 4, enrollments: 6, completed_enrollments: 2, completion_rate: 36.9, previous_enrollments: 5, previous_completion_rate: 40.2 },
  ];
  const snapshot = vietnameseSnapshot({
    scope: {},
    scopeDisplay: {},
    extensions: breakdown('group', [...units, ...aggregates], sum([...units, ...aggregates].map((row) => row.learners))),
  });
  return fixture('many-units-vi', 'Tổng công ty Dược phẩm An Khang', 'vi', snapshot);
}

/** Very small dataset with no comparison activity. */
export function tinyReportFixture(locale: 'vi' | 'en' = 'vi'): ReportPdfFixture {
  const courses = portfolio([['Hội nhập nhân viên mới', 2, 1, 1, 0, 62.5]]);
  const snapshot = build({
    dateFrom: '2026-09-14', dateTo: '2026-09-20', previousFrom: '2026-09-07', previousTo: '2026-09-13', basis: 'calendar_week',
    generatedAt: '2026-09-21T03:00:00.000Z', scope: {}, scopeDisplay: {},
    current: { total_learners: 1, active_learners: 1, completion_rate: 31.25, total_enrollments: 2, completed_enrollments: 1, incomplete_enrollments: 1 },
    previous: { total_learners: 0, active_learners: 0, completion_rate: 0, total_enrollments: 0, completed_enrollments: 0, incomplete_enrollments: 0 },
    enrollmentTrend: daily(2026, 9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0]).slice(13),
    activeTrend: daily(2026, 9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0]).slice(13),
    courses,
    // A young tenant without organization units yet.
    extensions: { unit_breakdown_status: 'no_child_units' },
  });
  return fixture(`tiny-${locale}`, 'Công ty TNHH Khởi Nghiệp Xanh', locale, snapshot);
}

/** No data in the period (empty availability). */
export function emptyReportFixture(locale: 'vi' | 'en' = 'en'): ReportPdfFixture {
  const zero = { total_learners: 0, active_learners: 0, completion_rate: 0, total_enrollments: 0, completed_enrollments: 0, incomplete_enrollments: 0 };
  const snapshot = build({
    dateFrom: '2026-01-01', dateTo: '2026-01-31', previousFrom: '2025-12-01', previousTo: '2025-12-31', basis: 'calendar_month',
    generatedAt: '2026-02-03T08:00:00.000Z', scope: { teamId: 'f1c2d3e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f' }, scopeDisplay: { team_name: 'Quality Assurance' },
    current: zero, previous: zero, enrollmentTrend: [], activeTrend: [], courses: [], availability: 'empty',
  });
  return fixture(`empty-${locale}`, 'Northwind Retail Academy', locale, snapshot);
}

/** Stress case: 20 courses with very long names, long tenant/unit names, HTML-like text. */
export function longNamesReportFixture(locale: 'vi' | 'en' = 'vi'): ReportPdfFixture {
  const specs: CourseSpec[] = Array.from({ length: 20 }, (_, index) => {
    const total = 60 - index * 2;
    const completed = Math.round(total * (0.25 + (index % 5) * 0.12));
    const notStarted = Math.round((total - completed) * 0.4);
    return [
      `Chương trình đào tạo chuyên sâu số ${index + 1}: Quản trị vận hành chuỗi cung ứng đa kênh, tối ưu tồn kho, chất lượng dịch vụ khách hàng và tuân thủ quy định <script>alert(${index})</script> & "đặc biệt"`,
      total, completed, total - completed - notStarted, notStarted, Math.round((completed / total) * 1000) / 10 + 8,
    ];
  });
  const courses = portfolio(specs);
  const total = sum(courses.map((course) => course.total_enrollments));
  const completed = sum(courses.map((course) => course.completed_enrollments));
  const trend = Array.from({ length: 31 }, (_, index) => Math.round(total / 31 + Math.sin(index / 3) * 6 + (index === 30 ? 2 : 0)));
  trend[30] += total - sum(trend);
  const snapshot = build({
    dateFrom: '2026-05-01', dateTo: '2026-05-31', previousFrom: '2026-04-01', previousTo: '2026-04-30', basis: 'calendar_month',
    generatedAt: '2026-06-02T01:00:00.000Z',
    scope: { groupId: 'a1b2c3d4-0000-4000-8000-000000000001', subgroupId: 'a1b2c3d4-0000-4000-8000-000000000002', teamId: 'a1b2c3d4-0000-4000-8000-000000000003' },
    scopeDisplay: {
      group_name: 'Tổng công ty Đầu tư Phát triển Hạ tầng và Dịch vụ Thương mại Quốc tế Miền Nam Việt Nam',
      subgroup_name: 'Chi nhánh Khu công nghiệp Công nghệ cao Thành phố Hồ Chí Minh và các tỉnh lân cận',
      team_name: 'Phòng Đào tạo, Phát triển Nguồn nhân lực & Văn hóa Doanh nghiệp <b>khu vực</b>',
    },
    current: { total_learners: 1234, active_learners: 987, completion_rate: 47.35, total_enrollments: total, completed_enrollments: completed, incomplete_enrollments: total - completed },
    previous: { total_learners: 1100, active_learners: 1012, completion_rate: 51.02, total_enrollments: total - 40, completed_enrollments: completed - 10, incomplete_enrollments: total - completed - 30 },
    enrollmentTrend: daily(2026, 5, trend),
    activeTrend: daily(2026, 5, trend.map((value) => value + 20)),
    courses,
  });
  return fixture(`long-names-${locale}`, 'Tập đoàn Công nghiệp – Thương mại – Dịch vụ Đa quốc gia Ánh Dương Phương Nam (Sunrise South Holdings)', locale, snapshot);
}

/** Legacy (version 1) snapshot. */
export function legacyReportFixture(): ReportPdfFixture {
  const snapshot: StoredReportChatSnapshot = {
    version: 1,
    generated_at: '2026-03-02T02:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh',
    filter: { date_from: '2026-02-01', date_to: '2026-02-28' },
    scope: { groupId: undefined, subgroupId: undefined, teamId: undefined },
    summary: summary('2026-02-01', '2026-02-28', { total_learners: 13, active_learners: 8, completion_rate: 78.5, total_enrollments: 37, completed_enrollments: 29, incomplete_enrollments: 8 }),
    enrollment_trend: daily(2026, 2, [1, 2, 1, 0, 3, 2, 1, 0, 0, 2, 3, 1, 2, 1, 0, 0, 2, 3, 2, 1, 2, 0, 0, 1, 2, 2, 2, 1]),
    top_courses: [{ course_id: 'c1', name: 'Kỹ năng thuyết trình', enrollments: 20 }, { course_id: 'c2', name: 'Quản lý thời gian', enrollments: 17 }],
    completion_ranking: [
      { course_id: 'c1', name: 'Kỹ năng thuyết trình', total_enrollments: 20, completed_enrollments: 17, incomplete_enrollments: 3, completion_rate: 88.2 },
      { course_id: 'c2', name: 'Quản lý thời gian', total_enrollments: 17, completed_enrollments: 12, incomplete_enrollments: 5, completion_rate: 74.1 },
    ],
  };
  return fixture('legacy-vi', 'Công ty Cổ phần Dược phẩm An Khang', 'vi', snapshot);
}

export function allReportPdfFixtures(): ReportPdfFixture[] {
  return [
    vietnameseReportFixture(), englishReportFixture(), englishExtendedReportFixture(), manyUnitsReportFixture(),
    tinyReportFixture('vi'), tinyReportFixture('en'), emptyReportFixture('en'), emptyReportFixture('vi'),
    longNamesReportFixture('vi'), longNamesReportFixture('en'), legacyReportFixture(),
  ];
}
