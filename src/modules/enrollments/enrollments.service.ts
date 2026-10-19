// ═══════════════════════════════════════════════════════════════
// Enrollments Service — Quản lý đăng ký khóa học + tiến độ
// Tối ưu cho hàng triệu users: pagination, indexed queries
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { invalidateUserBadgeCaches, invalidateUserCourseProgressCache } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { assertCourseBelongsToTenant } from '../courses/course-access.service.js';
import {
  assertUserNotActiveDemoIframeAccount,
  getActiveDemoIframeUserIds,
} from '../demo-login/demo-iframe.service.js';
import { recalculateEnrollmentProgress } from '../learner/progress-calculation.service.js';
import { scheduleCourseProgressRecalculation } from '../learner/progress-recalculation-job.service.js';
import {
  createEnrollmentsRepository,
  type EnrollmentWithCourse,
  type EnrollmentWithUser,
  type EnrollmentsDb,
} from './enrollments.repository.js';

export type { Enrollment, EnrollmentWithCourse, EnrollmentWithUser } from './enrollments.repository.js';

// query() joins the caller's current transaction (runAuditedTransaction) when there is one.
const poolDb: EnrollmentsDb = { query };
const enrollmentsRepository = createEnrollmentsRepository(poolDb);

// ── Types ──

export type StudyTimeGranularity = 'day' | 'month' | 'year';

export interface StudyTimeSeriesOptions {
  from?: string;
  to?: string;
  granularity?: StudyTimeGranularity;
}

export interface StudyTimeSeriesEntry {
  date: string;
  minutes: number;
}

export interface StudyTimeSeriesResponse {
  entries: StudyTimeSeriesEntry[];
  meta: {
    from: string;
    to: string;
    granularity: StudyTimeGranularity;
    requested_granularity: StudyTimeGranularity;
    default_weekly: boolean;
    point_count: number;
    reduced_granularity: boolean;
  };
}

export interface StudyTimeSyncEntry {
  date: string;
  minutes: number;
  course_id?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY_POINTS = 370;
const MAX_MONTHLY_POINTS = 240;

function assertIsoDate(value: string, field: string): void {
  if (!DATE_RE.test(value)) throw new AppError(`${field} must use YYYY-MM-DD`, 400);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(`${field} is invalid`, 400);
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getCurrentVietnamWeek(): { from: string; to: string } {
  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = new Date(`${vnNow.toISOString().slice(0, 10)}T00:00:00Z`);
  const day = today.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  const monday = addDays(today, -mondayOffset);
  return { from: formatDate(monday), to: formatDate(addDays(monday, 6)) };
}

function countDays(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  return Math.floor((end - start) / DAY_MS) + 1;
}

function countMonths(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (end.getUTCMonth() - start.getUTCMonth()) + 1;
}

function normalizeStudyTimeOptions(options: StudyTimeSeriesOptions = {}): StudyTimeSeriesResponse['meta'] {
  const defaultWeekly = !options.from && !options.to && !options.granularity;
  const defaultRange = getCurrentVietnamWeek();
  const from = options.from || defaultRange.from;
  const to = options.to || options.from || defaultRange.to;

  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  if (from > to) throw new AppError('from must be before or equal to to', 400);

  const days = countDays(from, to);
  const requestedGranularity = options.granularity || (days <= MAX_DAILY_POINTS ? 'day' : days <= 3650 ? 'month' : 'year');
  let granularity = requestedGranularity;

  if (granularity === 'day' && days > MAX_DAILY_POINTS) {
    granularity = days <= 3650 ? 'month' : 'year';
  }

  const months = countMonths(from, to);
  if (granularity === 'month' && months > MAX_MONTHLY_POINTS) {
    granularity = 'year';
  }

  const pointCount = granularity === 'day'
    ? days
    : granularity === 'month'
      ? countMonths(from, to)
      : new Date(`${to}T00:00:00Z`).getUTCFullYear() - new Date(`${from}T00:00:00Z`).getUTCFullYear() + 1;

  return {
    from,
    to,
    granularity,
    requested_granularity: requestedGranularity,
    default_weekly: defaultWeekly,
    point_count: pointCount,
    reduced_granularity: granularity !== requestedGranularity,
  };
}

export async function getEnrollmentAuditContext(userId: string, courseId: string, tenantId: string) {
  const row = await enrollmentsRepository.selectAuditContext(userId, courseId, tenantId);
  return {
    username: row?.username || userId,
    course_name: row?.course_name || courseId,
  };
}

export async function getCourseAuditName(courseId: string, tenantId: string): Promise<string> {
  const row = await enrollmentsRepository.selectCourseName(courseId, tenantId);
  return row?.display_name || courseId;
}
// ── Enroll / Unenroll ──

async function assertEnrollableLearner(userId: string, tenantId: string): Promise<void> {
  // Another tenant's user (or a staff account) is reported as not found.
  if (!(await enrollmentsRepository.isEnrollableLearner(userId, tenantId))) throw new AppError('Không tìm thấy học viên này trong doanh nghiệp.', 404);
}

export async function enrollUser(
  userId: string,
  courseId: string,
  tenantId: string,
): Promise<{ enrollment_id: string; already_enrolled: boolean }> {
  await assertEnrollableLearner(userId, tenantId);
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể ghi danh learner demo iframe đang hoạt động');

  // Guard: course must exist, not be soft-deleted and belong to the tenant
  await assertCourseBelongsToTenant(courseId, tenantId, 'Course not found');

  // Check if already enrolled
  const enrollment = await enrollmentsRepository.selectEnrollment(userId, courseId, tenantId);

  if (enrollment) {
    if (!enrollment.is_active) {
      await enrollmentsRepository.reactivateEnrollment(enrollment.id);
      await recalculateEnrollmentProgress(enrollment.id, courseId);
      await invalidateUserCourseProgressCache(userId, courseId);
      await invalidateUserBadgeCaches([userId]);
    }
    return { enrollment_id: enrollment.id, already_enrolled: true };
  }

  // Create enrollment + progress record in transaction
  const enrollmentId = await enrollmentsRepository.insertEnrollmentWithProgress(userId, courseId, tenantId);

  return { enrollment_id: enrollmentId, already_enrolled: false };
}

export async function bulkEnroll(
  userIds: string[],
  courseId: string,
  tenantId: string,
): Promise<{ enrolled: number; skipped: number }> {
  if (userIds.length === 0) return { enrolled: 0, skipped: 0 };
  const lockedDemoUsers = await getActiveDemoIframeUserIds(userIds);
  if (lockedDemoUsers.size > 0) {
    throw new AppError('Không thể ghi danh learner demo iframe đang hoạt động', 403);
  }

  // Guard: course must exist, not be soft-deleted and belong to the tenant
  await assertCourseBelongsToTenant(courseId, tenantId, 'Course not found');

  const counts = await enrollmentsRepository.bulkEnroll(userIds, courseId, tenantId);

  const inserted = Number(counts?.inserted_count ?? 0);
  const reactivated = Number(counts?.reactivated_count ?? 0);
  if (reactivated > 0) {
    await scheduleCourseProgressRecalculation({
      tenantId,
      courseId,
      reason: 'enrollment_reactivated',
    });
  }

  const uniqueRequested = new Set(userIds).size;
  const enrolled = inserted + reactivated;
  return { enrolled, skipped: uniqueRequested - enrolled };
}

export async function unenrollUser(userId: string, courseId: string, tenantId: string): Promise<boolean> {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể hủy ghi danh learner demo iframe đang hoạt động');

  return (await enrollmentsRepository.deactivateEnrollment(userId, courseId, tenantId)) > 0;
}

// ── Progress ──

export async function updateProgress(
  userId: string,
  courseId: string,
  tenantId: string,
  progress: number,
): Promise<{ previousProgress: number | null; progress: number | null }> {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể cập nhật tiến độ cho learner demo iframe đang hoạt động');

  const isCompleted = progress >= 100;

  const current = await enrollmentsRepository.lockProgress(userId, courseId, tenantId);

  const result = await enrollmentsRepository.updateProgress(
    userId,
    courseId,
    tenantId,
    Math.min(100, Math.max(0, progress)),
    isCompleted,
  );
  // Inside the caller's audited transaction the bump waits for the commit.
  if (result.rowCount > 0) await invalidateUserBadgeCaches([userId]);
  return {
    previousProgress: current?.progress ?? null,
    progress: result.row?.progress ?? null,
  };
}

export async function recordStudySession(
  userId: string,
  courseId: string | null,
  tenantId: string,
  durationMinutes: number,
  startedAt?: string,
): Promise<void> {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể ghi thời gian học cho learner demo iframe đang hoạt động');

  const start = startedAt ? new Date(startedAt) : new Date();
  // duration_minutes là GENERATED column (tự tính từ ended_at - started_at)
  // → tính ended_at = started_at + duration
  // Dùng múi giờ VN để xác định ngày (00:00-07:00 UTC vẫn là ngày hôm đó ở VN)
  const vnDate = new Date(start.getTime() + 7 * 60 * 60 * 1000); // UTC+7
  const studyDate = vnDate.toISOString().slice(0, 10); // yyyy-MM-dd theo VN
  const endedAt = new Date(start.getTime() + durationMinutes * 60 * 1000);

  await enrollmentsRepository.upsertStudySession(userId, courseId, tenantId, start, endedAt, studyDate);
}

export async function recordStudySessionEntries(
  userId: string,
  tenantId: string,
  entries: StudyTimeSyncEntry[],
): Promise<{ synced: number }> {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể ghi thời gian học cho learner demo iframe đang hoạt động');

  const normalized = entries
    .filter(entry => entry.minutes > 0)
    .map(entry => ({
      study_date: entry.date,
      minutes: Math.min(1440, Math.max(0, Math.round(entry.minutes))),
      course_id: entry.course_id || null,
    }));

  if (normalized.length === 0) return { synced: 0 };

  for (const entry of normalized) assertIsoDate(entry.study_date, 'date');

  const row = await enrollmentsRepository.upsertStudySessionEntries(userId, tenantId, normalized);

  return { synced: parseInt(row?.synced ?? '0', 10) };
}

/**
  * Lấy study time tuần hiện tại (Thứ 2 → CN) cho user.
 * Tối ưu: dùng unique index (user_id, study_date) → O(1) per day, tổng 7 lookups.
 */
export async function getWeeklyStudyTime(
  userId: string,
  tenantId: string,
  options: StudyTimeSeriesOptions = {},
): Promise<StudyTimeSeriesResponse> {
  return getStudyTimeSeries(userId, tenantId, options);
}

export async function getStudyTimeSeries(
  userId: string,
  tenantId: string,
  options: StudyTimeSeriesOptions = {},
): Promise<StudyTimeSeriesResponse> {
  const meta = normalizeStudyTimeOptions(options);
  const params = [userId, meta.from, meta.to, tenantId];

  if (meta.granularity === 'month') {
    const rows = await enrollmentsRepository.selectStudyMinutesByMonth(params);

    return {
      entries: rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes, 10) || 0 })),
      meta,
    };
  }

  if (meta.granularity === 'year') {
    const rows = await enrollmentsRepository.selectStudyMinutesByYear(params);

    return {
      entries: rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes, 10) || 0 })),
      meta,
    };
  }

  const rows = await enrollmentsRepository.selectStudyMinutesByDay(params);

  return {
    entries: rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes) })),
    meta,
  };
}

// ── Query: User's Enrollments ──

export async function getUserEnrollments(
  userId: string,
  tenantId: string,
  page = 1,
  pageSize = 10,
  search = '',
): Promise<{ data: EnrollmentWithCourse[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const { countRow, rows } = await enrollmentsRepository.selectUserEnrollmentPage(userId, tenantId, pageSize, offset, search);

  return {
    data: rows,
    total: parseInt(countRow?.count ?? '0'),
  };
}

// ── Query: Course's Enrolled Users ──

export async function getCourseEnrollments(
  courseId: string,
  tenantId: string,
  page = 1,
  pageSize = 20,
  search = '',
  status?: 'all' | 'not_started' | 'learning' | 'completed',
): Promise<{ data: EnrollmentWithUser[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const { countRow, rows } = await enrollmentsRepository.selectCourseEnrollmentPage(
    courseId,
    tenantId,
    pageSize,
    offset,
    search,
    status,
  );

  return {
    data: rows,
    total: parseInt(countRow?.count ?? '0'),
  };
}
