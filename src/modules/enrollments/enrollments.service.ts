// ═══════════════════════════════════════════════════════════════
// Enrollments Service — Quản lý đăng ký khóa học + tiến độ
// Tối ưu cho hàng triệu users: pagination, indexed queries
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';

// ── Types ──

export interface Enrollment {
  id: string;
  user_id: string;
  course_id: string;
  tenant_id: string;
  enrolled_at: string;
  is_active: boolean;
  progress: number;
  is_completed: boolean;
  completed_at: string | null;
  last_activity_at: string | null;
}

export interface EnrollmentWithUser extends Enrollment {
  username: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
}

export interface EnrollmentWithCourse extends Enrollment {
  course_name: string;
  course_image: string | null;
}

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

// ── Enroll / Unenroll ──

export async function enrollUser(
  userId: string,
  courseId: string,
  tenantId: string,
): Promise<{ enrollment_id: string; already_enrolled: boolean }> {
  // Guard: course must exist and not be soft-deleted
  const courseCheck = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND deleted_at IS NULL`,
    [courseId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course not found', 404);

  // Check if already enrolled
  const existing = await query<{ id: string }>(
    `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    // Re-activate if was inactive
    await query(
      `UPDATE enrollments SET is_active = true WHERE id = $1 AND is_active = false`,
      [existing.rows[0].id],
    );
    return { enrollment_id: existing.rows[0].id, already_enrolled: true };
  }

  // Create enrollment + progress record in transaction
  const result = await query<{ id: string }>(
    `WITH new_enrollment AS (
       INSERT INTO enrollments (user_id, course_id, tenant_id)
       VALUES ($1, $2, $3)
       RETURNING id
     )
     INSERT INTO course_progress (enrollment_id)
     SELECT id FROM new_enrollment
     RETURNING (SELECT id FROM new_enrollment) AS id`,
    [userId, courseId, tenantId],
  );

  return { enrollment_id: result.rows[0].id, already_enrolled: false };
}

export async function bulkEnroll(
  userIds: string[],
  courseId: string,
  tenantId: string,
): Promise<{ enrolled: number; skipped: number }> {
  if (userIds.length === 0) return { enrolled: 0, skipped: 0 };

  // Guard: course must exist and not be soft-deleted
  const courseCheck = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND deleted_at IS NULL`,
    [courseId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course not found', 404);

  // Batch insert using unnest, skip existing
  const result = await query<{ id: string }>(
    `WITH to_enroll AS (
       INSERT INTO enrollments (user_id, course_id, tenant_id)
       SELECT uid, $2, $3
       FROM unnest($1::uuid[]) AS uid
       WHERE NOT EXISTS (
         SELECT 1 FROM enrollments e WHERE e.user_id = uid AND e.course_id = $2
       )
       RETURNING id
     )
     INSERT INTO course_progress (enrollment_id)
     SELECT id FROM to_enroll
     RETURNING id`,
    [userIds, courseId, tenantId],
  );

  const enrolled = result.rowCount ?? 0;
  return { enrolled, skipped: userIds.length - enrolled };
}

export async function unenrollUser(userId: string, courseId: string): Promise<boolean> {
  const result = await query(
    `UPDATE enrollments SET is_active = false WHERE user_id = $1 AND course_id = $2 AND is_active = true`,
    [userId, courseId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Progress ──

export async function updateProgress(
  userId: string,
  courseId: string,
  progress: number,
): Promise<void> {
  const isCompleted = progress >= 100;

  await query(
    `UPDATE course_progress cp SET
       progress = $3,
       is_completed = $4,
       completed_at = CASE WHEN $4 AND cp.completed_at IS NULL THEN now() ELSE cp.completed_at END,
       last_activity_at = now()
     FROM enrollments e
     WHERE cp.enrollment_id = e.id
       AND e.user_id = $1
       AND e.course_id = $2
       AND e.is_active = true`,
    [userId, courseId, Math.min(100, Math.max(0, progress)), isCompleted],
  );
}

export async function recordStudySession(
  userId: string,
  courseId: string | null,
  tenantId: string,
  durationMinutes: number,
  startedAt?: string,
): Promise<void> {
  const start = startedAt ? new Date(startedAt) : new Date();
  // duration_minutes là GENERATED column (tự tính từ ended_at - started_at)
  // → tính ended_at = started_at + duration
  // Dùng múi giờ VN để xác định ngày (00:00-07:00 UTC vẫn là ngày hôm đó ở VN)
  const vnDate = new Date(start.getTime() + 7 * 60 * 60 * 1000); // UTC+7
  const studyDate = vnDate.toISOString().slice(0, 10); // yyyy-MM-dd theo VN
  const endedAt = new Date(start.getTime() + durationMinutes * 60 * 1000);

  await query(
    `INSERT INTO study_sessions (user_id, course_id, tenant_id, started_at, ended_at, study_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, study_date)
     DO UPDATE SET
       ended_at = GREATEST(study_sessions.ended_at, EXCLUDED.ended_at)`,
    [userId, courseId, tenantId, start, endedAt, studyDate],
  );
}

export async function recordStudySessionEntries(
  userId: string,
  tenantId: string,
  entries: StudyTimeSyncEntry[],
): Promise<{ synced: number }> {
  const normalized = entries
    .filter(entry => entry.minutes > 0)
    .map(entry => ({
      study_date: entry.date,
      minutes: Math.min(1440, Math.max(0, Math.round(entry.minutes))),
      course_id: entry.course_id || null,
    }));

  if (normalized.length === 0) return { synced: 0 };

  for (const entry of normalized) assertIsoDate(entry.study_date, 'date');

  const result = await query<{ synced: string }>(
    `WITH input AS (
       SELECT x.study_date::DATE AS study_date,
              GREATEST(0, LEAST(1440, x.minutes))::INT AS duration_minutes,
              NULLIF(x.course_id, '')::VARCHAR AS course_id
       FROM jsonb_to_recordset($3::jsonb) AS x(study_date DATE, minutes INT, course_id TEXT)
       WHERE x.study_date IS NOT NULL AND x.minutes > 0
     ),
     normalized AS (
       SELECT $1::UUID AS user_id,
              $2::UUID AS tenant_id,
              course_id,
              study_date,
              (study_date::TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh') AS started_at,
              (study_date::TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')
                + (duration_minutes || ' minutes')::INTERVAL AS ended_at
       FROM input
     ),
     upserted AS (
       INSERT INTO study_sessions (user_id, course_id, tenant_id, started_at, ended_at, study_date)
       SELECT user_id, course_id, tenant_id, started_at, ended_at, study_date
       FROM normalized
       ON CONFLICT (user_id, study_date)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         course_id = COALESCE(EXCLUDED.course_id, study_sessions.course_id),
         started_at = LEAST(study_sessions.started_at, EXCLUDED.started_at),
         ended_at = GREATEST(COALESCE(study_sessions.ended_at, EXCLUDED.ended_at), EXCLUDED.ended_at)
       RETURNING 1
     )
     SELECT COUNT(*)::TEXT AS synced FROM upserted`,
    [userId, tenantId, JSON.stringify(normalized)],
  );

  return { synced: parseInt(result.rows[0]?.synced ?? '0', 10) };
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
    const result = await query<{ date: string; minutes: string }>(
      `WITH bounds AS (
         SELECT $2::DATE AS from_date, $3::DATE AS to_date
       ),
       months AS (
         SELECT generate_series(
           date_trunc('month', from_date)::DATE,
           date_trunc('month', to_date)::DATE,
           '1 month'
         )::DATE AS bucket
         FROM bounds
       )
       SELECT months.bucket::TEXT AS date,
              COALESCE(SUM(ss.duration_minutes), 0)::TEXT AS minutes
       FROM months
       LEFT JOIN study_sessions ss
         ON ss.user_id = $1
        AND ss.tenant_id = $4
        AND ss.study_date >= months.bucket
        AND ss.study_date < (months.bucket + INTERVAL '1 month')
        AND ss.study_date >= (SELECT from_date FROM bounds)
        AND ss.study_date <= (SELECT to_date FROM bounds)
       GROUP BY months.bucket
       ORDER BY months.bucket`,
      params,
    );

    return {
      entries: result.rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes, 10) || 0 })),
      meta,
    };
  }

  if (meta.granularity === 'year') {
    const result = await query<{ date: string; minutes: string }>(
      `WITH bounds AS (
         SELECT $2::DATE AS from_date, $3::DATE AS to_date
       ),
       years AS (
         SELECT generate_series(
           date_trunc('year', from_date)::DATE,
           date_trunc('year', to_date)::DATE,
           '1 year'
         )::DATE AS bucket
         FROM bounds
       )
       SELECT years.bucket::TEXT AS date,
              COALESCE(SUM(ss.duration_minutes), 0)::TEXT AS minutes
       FROM years
       LEFT JOIN study_sessions ss
         ON ss.user_id = $1
        AND ss.tenant_id = $4
        AND ss.study_date >= years.bucket
        AND ss.study_date < (years.bucket + INTERVAL '1 year')
        AND ss.study_date >= (SELECT from_date FROM bounds)
        AND ss.study_date <= (SELECT to_date FROM bounds)
       GROUP BY years.bucket
       ORDER BY years.bucket`,
      params,
    );

    return {
      entries: result.rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes, 10) || 0 })),
      meta,
    };
  }

  // Cast ::TEXT tránh pg driver serialize DATE thành JS Date (bị lệch timezone)
  const result = await query<{ date: string; minutes: string }>(
    `WITH bounds AS (
       SELECT $2::DATE AS from_date, $3::DATE AS to_date
     )
     SELECT g::DATE::TEXT AS date,
            COALESCE(SUM(ss.duration_minutes), 0)::TEXT AS minutes
     FROM bounds, generate_series(bounds.from_date, bounds.to_date, '1 day') AS g
     LEFT JOIN study_sessions ss
       ON ss.study_date = g::DATE
      AND ss.user_id = $1
      AND ss.tenant_id = $4
     GROUP BY g
     ORDER BY g`,
    params,
  );

  return {
    entries: result.rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes) })),
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
  const searchFilter = search ? `AND c.display_name ILIKE '%' || $5 || '%'` : '';
  const params: any[] = [userId, tenantId, pageSize, offset];
  if (search) params.push(search);

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id AND c.deleted_at IS NULL
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true ${searchFilter}`,
    params.slice(0, search ? 5 : 4).filter((_, i) => i < 2 || i === 4),
  );

  const dataResult = await query<EnrollmentWithCourse>(
    `SELECT e.id, e.user_id, e.course_id, e.tenant_id, e.enrolled_at, e.is_active,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at,
            c.display_name AS course_name, c.image_url AS course_image
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id AND c.deleted_at IS NULL
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true ${searchFilter}
     ORDER BY e.enrolled_at DESC
     LIMIT $3 OFFSET $4`,
    params,
  );

  return {
    data: dataResult.rows,
    total: parseInt(countResult.rows[0]?.count ?? '0'),
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
  const conditions: string[] = [
    'e.course_id = $1',
    'e.tenant_id = $2',
    'e.is_active = true',
    'c.deleted_at IS NULL',
  ];
  const params: any[] = [courseId, tenantId];
  let paramIdx = 3;

  if (search) {
    conditions.push(`(u.username ILIKE '%' || $${paramIdx} || '%' OR u.email ILIKE '%' || $${paramIdx} || '%' OR u.full_name ILIKE '%' || $${paramIdx} || '%')`);
    params.push(search);
    paramIdx++;
  }

  if (status && status !== 'all') {
    if (status === 'completed') {
      conditions.push('cp.is_completed = true');
    } else if (status === 'learning') {
      conditions.push('cp.is_completed = false AND cp.progress > 0');
    } else if (status === 'not_started') {
      conditions.push('(cp.progress IS NULL OR cp.progress = 0)');
    }
  }

  const whereClause = conditions.join(' AND ');

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users u ON u.id = e.user_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE ${whereClause}`,
    params,
  );

  params.push(pageSize, offset);

  const dataResult = await query<EnrollmentWithUser>(
    `SELECT e.id, e.user_id, e.course_id, e.tenant_id, e.enrolled_at, e.is_active,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at,
            u.username, u.email, u.full_name, u.avatar_url
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users u ON u.id = e.user_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE ${whereClause}
     ORDER BY e.enrolled_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  return {
    data: dataResult.rows,
    total: parseInt(countResult.rows[0]?.count ?? '0'),
  };
}
