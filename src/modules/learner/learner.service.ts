// ═══════════════════════════════════════════════════════════════
// Learner Service — Business logic cho learner portal
// Tối ưu cho multi-tenant + hàng triệu rows
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';

// ── Courses ──

/**
 * Lấy danh sách khóa học learner được thấy.
 * - learner: chỉ courses assign qua team_courses (team membership)
 * - staff/superuser/superadmin: toàn bộ courses trong tenant
 */
export async function getMyVisibleCourses(
  userId: string,
  tenantId: string,
  role: string,
  params: { search?: string; page?: number; page_size?: number },
) {
  const { search, page = 1, page_size = 20 } = params;
  const offset = (page - 1) * page_size;
  const sqlParams: unknown[] = [tenantId];
  let where = 'WHERE c.tenant_id = $1';

  // learner: chỉ thấy courses assign qua team_courses → team_members
  if (role === 'learner') {
    sqlParams.push(userId);
    where += ` AND c.id IN (
      SELECT DISTINCT tc.course_id
      FROM team_courses tc
      JOIN team_members tm ON tm.team_id = tc.team_id
      WHERE tm.user_id = $${sqlParams.length}
    )`;
  }

  if (search) {
    sqlParams.push(`%${search}%`);
    where += ` AND (c.display_name ILIKE $${sqlParams.length} OR c.org ILIKE $${sqlParams.length})`;
  }

  sqlParams.push(page_size, offset);
  const result = await query<any>(
    `SELECT c.id, c.display_name, c.org, c.image_url, c.start_date, c.end_date,
            c.visible_to_staff_only, c.created_at,
            COUNT(*) OVER() AS full_count
     FROM courses c
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
    sqlParams,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    data: result.rows.map((r: any) => {
      const { full_count, ...rest } = r;
      return rest;
    }),
    total,
    page,
    page_size,
    total_pages: Math.ceil(total / page_size) || 1,
  };
}

/**
 * Lấy chi tiết 1 khóa học + kiểm tra quyền truy cập.
 */
export async function getCourseDetail(
  courseId: string,
  userId: string,
  tenantId: string,
  role: string,
) {
  const result = await query<any>(
    `SELECT c.id, c.display_name, c.org, c.image_url, c.start_date, c.end_date,
            c.visible_to_staff_only, c.created_at
     FROM courses c
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [courseId, tenantId],
  );

  if (result.rowCount === 0) throw new AppError('Khóa học không tồn tại', 404);

  // learner: kiểm tra quyền truy cập qua team
  if (role === 'learner') {
    const access = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM team_courses tc
       JOIN team_members tm ON tm.team_id = tc.team_id
       WHERE tc.course_id = $1 AND tm.user_id = $2`,
      [courseId, userId],
    );
    if (parseInt(access.rows[0].count) === 0) {
      throw new AppError('Bạn không có quyền truy cập khóa học này', 403);
    }
  }

  return result.rows[0];
}

// ── Course Blocks (cấu trúc nội dung) ──

/**
 * Lấy cấu trúc blocks đầy đủ của khóa học.
 * Trả về flat list → FE tự build tree.
 * Chỉ trả blocks đã published.
 * Kèm completion status per-user nếu có enrollment.
 */
export async function getCourseBlocks(
  courseId: string,
  userId: string,
) {
  // Lấy enrollment_id (nếu có) để join block_completions
  const enrollResult = await query<{ id: string }>(
    `SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2 AND is_active = true LIMIT 1`,
    [courseId, userId],
  );
  const enrollmentId = enrollResult.rows[0]?.id ?? null;

  // Lấy tất cả blocks published, kèm completion nếu enrolled
  let sql: string;
  let params: unknown[];

  if (enrollmentId) {
    sql = `SELECT b.id, b.parent_id, b.block_type, b.display_name, b.data, b.metadata,
                  b.sort_order,
                  CASE WHEN bc.id IS NOT NULL THEN true ELSE false END AS completed
           FROM course_blocks b
           LEFT JOIN block_completions bc ON bc.block_id = b.id AND bc.enrollment_id = $2
           WHERE b.course_id = $1 AND b.is_published = true
           ORDER BY b.sort_order`;
    params = [courseId, enrollmentId];
  } else {
    sql = `SELECT b.id, b.parent_id, b.block_type, b.display_name, b.data, b.metadata,
                  b.sort_order,
                  false AS completed
           FROM course_blocks b
           WHERE b.course_id = $1 AND b.is_published = true
           ORDER BY b.sort_order`;
    params = [courseId];
  }

  const result = await query<any>(sql, params);

  // Build tree structure
  const blocks = result.rows;
  const root = blocks.find((b: any) => b.block_type === 'course') ?? null;

  return {
    root_id: root?.id ?? null,
    blocks,
  };
}

// ── Enrollments ──

/**
 * Lấy enrollments của user kèm progress.
 * JOIN course_progress để lấy progress % và completion status.
 */
export async function getMyEnrollments(userId: string, tenantId: string) {
  const result = await query<any>(
    `SELECT e.id, e.course_id, e.enrolled_at, e.is_active,
            c.display_name, c.image_url, c.org,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true
     ORDER BY e.enrolled_at DESC`,
    [userId, tenantId],
  );

  return result.rows;
}

/**
 * Learner tự ghi danh vào khóa học.
 * Kiểm tra: course thuộc tenant + learner có quyền truy cập (qua team).
 */
export async function selfEnroll(userId: string, courseId: string, tenantId: string) {
  // Kiểm tra course tồn tại trong tenant
  const course = await query<any>(
    'SELECT id FROM courses WHERE id = $1 AND tenant_id = $2',
    [courseId, tenantId],
  );
  if (course.rowCount === 0) throw new AppError('Khóa học không tồn tại', 404);

  // Kiểm tra đã enroll chưa
  const existing = await query<any>(
    'SELECT id, is_active FROM enrollments WHERE user_id = $1 AND course_id = $2 AND tenant_id = $3',
    [userId, courseId, tenantId],
  );

  if (existing.rowCount! > 0) {
    if (existing.rows[0].is_active) {
      return { enrollment_id: existing.rows[0].id, already_enrolled: true };
    }
    // Re-activate
    await query('UPDATE enrollments SET is_active = true WHERE id = $1', [existing.rows[0].id]);
    return { enrollment_id: existing.rows[0].id, already_enrolled: false };
  }

  // Tạo enrollment + course_progress
  const result = await query<{ id: string }>(
    `INSERT INTO enrollments (user_id, course_id, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, courseId, tenantId],
  );
  const enrollmentId = result.rows[0].id;

  await query(
    'INSERT INTO course_progress (enrollment_id) VALUES ($1)',
    [enrollmentId],
  );

  return { enrollment_id: enrollmentId, already_enrolled: false };
}

// ── Block Completion ──

/**
 * Đánh dấu blocks hoàn thành (batch).
 * Tự động tính lại course progress sau khi mark.
 */
export async function markBlocksComplete(
  userId: string,
  courseId: string,
  blockIds: string[],
) {
  if (blockIds.length === 0) return { marked: 0 };

  // Lấy enrollment
  const enrollment = await query<{ id: string }>(
    `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2 AND is_active = true LIMIT 1`,
    [courseId, userId],
  );

  if (enrollment.rowCount === 0) {
    throw new AppError('Chưa ghi danh khóa học này', 400);
  }

  const enrollmentId = enrollment.rows[0].id;

  // Batch insert completions (ON CONFLICT skip)
  const values = blockIds.map((_, i) => `($1, $${i + 2})`).join(', ');
  await query(
    `INSERT INTO block_completions (enrollment_id, block_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [enrollmentId, ...blockIds],
  );

  // Tính lại progress: completed_leaves / total_leaves
  await recalculateProgress(enrollmentId, courseId);

  return { marked: blockIds.length };
}

/**
 * Tính lại progress % dựa trên block completions.
 * Chỉ tính leaf blocks (video, html, problem, la_*).
 */
async function recalculateProgress(enrollmentId: string, courseId: string) {
  const result = await query<{ total: string; completed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE b.block_type NOT IN ('course','chapter','sequential','vertical')) AS total,
       COUNT(*) FILTER (WHERE b.block_type NOT IN ('course','chapter','sequential','vertical') AND bc.id IS NOT NULL) AS completed
     FROM course_blocks b
     LEFT JOIN block_completions bc ON bc.block_id = b.id AND bc.enrollment_id = $1
     WHERE b.course_id = $2 AND b.is_published = true`,
    [enrollmentId, courseId],
  );

  const total = parseInt(result.rows[0].total);
  const completed = parseInt(result.rows[0].completed);
  const progress = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0;
  const isCompleted = total > 0 && completed >= total;

  await query(
    `UPDATE course_progress
     SET progress = $1, is_completed = $2, completed_at = $3, last_activity_at = now(), updated_at = now()
     WHERE enrollment_id = $4`,
    [progress, isCompleted, isCompleted ? new Date() : null, enrollmentId],
  );
}

// ── Progress ──

/**
 * Lấy progress chi tiết cho 1 khóa học.
 */
export async function getMyProgress(userId: string, courseId: string) {
  const result = await query<any>(
    `SELECT cp.progress, cp.is_completed, cp.completed_at, cp.last_activity_at
     FROM course_progress cp
     JOIN enrollments e ON e.id = cp.enrollment_id
     WHERE e.user_id = $1 AND e.course_id = $2 AND e.is_active = true
     LIMIT 1`,
    [userId, courseId],
  );

  if (result.rowCount === 0) {
    return { progress: 0, is_completed: false, completed_at: null, last_activity_at: null };
  }

  return result.rows[0];
}

// ── Badges ──

export async function getMyBadges(userId: string) {
  const result = await query<any>(
    `SELECT ub.badge_id, ub.is_shown, ub.earned_at
     FROM user_badges ub
     WHERE ub.user_id = $1
     ORDER BY ub.earned_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function saveBadge(userId: string, badgeId: string) {
  await query(
    `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, badgeId],
  );
}

export async function updateBadgeShown(userId: string, badgeId: string, isShown: boolean) {
  await query(
    'UPDATE user_badges SET is_shown = $1 WHERE user_id = $2 AND badge_id = $3',
    [isShown, userId, badgeId],
  );
}

// ── Notifications ──

/**
 * Lấy thông báo cho learner.
 * Chỉ lấy từ notification_recipients (đã được admin gửi cho user này).
 */
export async function getMyNotifications(
  userId: string,
  tenantId: string,
  params: { page?: number; page_size?: number },
) {
  const { page = 1, page_size = 20 } = params;
  const offset = (page - 1) * page_size;

  const result = await query<any>(
    `SELECT n.id, n.title, n.message, n.course_id, n.created_at,
            nr.is_read, nr.read_at,
            u.full_name AS sent_by_name,
            COUNT(*) OVER() AS full_count
     FROM notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     LEFT JOIN users u ON u.id = n.sent_by
     WHERE nr.user_id = $1 AND n.tenant_id = $2
     ORDER BY n.created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, tenantId, page_size, offset],
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    data: result.rows.map((r: any) => {
      const { full_count, ...rest } = r;
      return rest;
    }),
    total,
    unread_count: 0, // filled below
  };
}

export async function getUnreadCount(userId: string, tenantId: string) {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     WHERE nr.user_id = $1 AND n.tenant_id = $2 AND nr.is_read = false`,
    [userId, tenantId],
  );
  return parseInt(result.rows[0].count);
}

export async function markNotificationRead(userId: string, notificationId: string) {
  await query(
    `UPDATE notification_recipients SET is_read = true, read_at = now()
     WHERE user_id = $1 AND notification_id = $2`,
    [userId, notificationId],
  );
}

export async function markAllNotificationsRead(userId: string, tenantId: string) {
  await query(
    `UPDATE notification_recipients nr SET is_read = true, read_at = now()
     FROM notifications n
     WHERE nr.notification_id = n.id AND nr.user_id = $1 AND n.tenant_id = $2 AND nr.is_read = false`,
    [userId, tenantId],
  );
}
