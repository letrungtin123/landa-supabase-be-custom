// ═══════════════════════════════════════════════════════════════
// Enrollments Service — Quản lý đăng ký khóa học + tiến độ
// Tối ưu cho hàng triệu users: pagination, indexed queries
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';

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

// ── Enroll / Unenroll ──

export async function enrollUser(
  userId: string,
  courseId: string,
  tenantId: string,
): Promise<{ enrollment_id: string; already_enrolled: boolean }> {
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

/**
  * Lấy study time tuần hiện tại (Thứ 2 → CN) cho user.
 * Tối ưu: dùng unique index (user_id, study_date) → O(1) per day, tổng 7 lookups.
 */
export async function getWeeklyStudyTime(
  userId: string,
): Promise<{ entries: Array<{ date: string; minutes: number }> }> {
  // Dùng múi giờ Asia/Ho_Chi_Minh để xác định "hôm nay" và tuần hiện tại
  // Cast ::TEXT tránh pg driver serialize DATE thành JS Date (bị lệch timezone)
  const result = await query<{ date: string; minutes: string }>(
    `WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::DATE AS d),
          week_start AS (SELECT date_trunc('week', today.d)::DATE AS d FROM today)
     SELECT g::DATE::TEXT AS date,
            COALESCE(ss.duration_minutes, 0) AS minutes
     FROM week_start, generate_series(week_start.d, week_start.d + 6, '1 day') AS g
     LEFT JOIN study_sessions ss
       ON ss.study_date = g::DATE AND ss.user_id = $1
     ORDER BY g`,
    [userId],
  );

  return {
    entries: result.rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes) })),
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
     JOIN courses c ON c.id = e.course_id
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
     JOIN courses c ON c.id = e.course_id
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
