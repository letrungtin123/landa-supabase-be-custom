// ═══════════════════════════════════════════════════════════════
// Notifications Service — Targeted course notifications
// Chỉ gửi cho learners: đã enroll + nhìn thấy course qua teams
// Tối ưu: 0 loops, 3 queries, INSERT...SELECT bulk
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

/**
 * Gửi notification cho course — chỉ target learners đủ điều kiện:
 *   1. Đã enroll course (enrollments.is_active = true)
 *   2. Nhìn thấy course qua team assignment (team_courses hoặc team_course_categories)
 *   3. Course không bị ẩn (visible_to_staff_only = false)
 *   4. User role = learner + is_active = true
 *
 * Dùng transaction + INSERT...SELECT — 0 loops, tối ưu cho hàng triệu users.
 */
export async function sendCourseNotification(
  courseId: string,
  tenantId: string,
  title: string,
  message: string,
  sentBy: string,
): Promise<{ success: boolean; recipients: number }> {
  // Step 0: Validate course tồn tại + không bị ẩn
  const courseCheck = await query<{ visible_to_staff_only: boolean }>(
    `SELECT visible_to_staff_only FROM courses WHERE id = $1 AND tenant_id = $2`,
    [courseId, tenantId],
  );
  if (courseCheck.rowCount === 0) {
    throw new AppError('Course không tồn tại', 404);
  }
  if (courseCheck.rows[0].visible_to_staff_only) {
    throw new AppError('Không thể gửi thông báo cho course đang ẩn (staff only)', 400);
  }

  // Dùng transaction đảm bảo atomicity
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Step 1: Insert notification header
    const notifResult = await client.query<{ id: string }>(
      `INSERT INTO notifications (tenant_id, course_id, title, message, sent_by, recipient_count)
       VALUES ($1, $2, $3, $4, $5, 0)
       RETURNING id`,
      [tenantId, courseId, title, message, sentBy],
    );
    const notifId = notifResult.rows[0].id;

    // Step 2: Bulk insert recipients — 1 query duy nhất, 0 loops
    // Điều kiện: enrolled + thuộc team nhìn thấy course + learner + active
    //
    // Query plan tối ưu:
    //   enrollments(tenant_id, course_id) → index scan  → tập enrolled users
    //   team_members(user_id)             → index scan  → tập teams user thuộc
    //   team_courses(course_id)           → index scan  → teams assign trực tiếp
    //   team_course_categories + ccc      → index scan  → teams assign qua category
    //   DISTINCT loại trùng user thuộc nhiều teams
    //   ON CONFLICT DO NOTHING            → idempotent, tránh lỗi duplicate
    const insertResult = await client.query(
      `INSERT INTO notification_recipients (notification_id, user_id)
       SELECT DISTINCT $1::uuid, e.user_id
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       WHERE e.course_id = $2
         AND e.tenant_id = $3
         AND e.is_active = true
         AND u.role IN ('learner', 'learner_plus')
         AND u.is_active = true
         AND EXISTS (
           SELECT 1 FROM team_members tm
           WHERE tm.user_id = e.user_id
             AND (
               -- Path 1: team → course_category → course
               tm.team_id IN (
                 SELECT tcc.team_id
                 FROM team_course_categories tcc
                 JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
                 WHERE ccc.course_id = $2
               )
               OR
               -- Path 2: team → course (direct assignment)
               tm.team_id IN (
                 SELECT tc.team_id FROM team_courses tc WHERE tc.course_id = $2
               )
             )
         )
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [notifId, courseId, tenantId],
    );

    const recipientCount = insertResult.rowCount || 0;

    // Step 3: Update recipient_count trên notification header
    await client.query(
      `UPDATE notifications SET recipient_count = $1 WHERE id = $2`,
      [recipientCount, notifId],
    );

    await client.query('COMMIT');

    return { success: true, recipients: recipientCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lấy danh sách notifications (admin view) — phân trang.
 */
export async function getNotifications(
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [tenantId];
  const conditions = ['n.tenant_id = $1'];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(n.title ILIKE $${params.length} OR c.display_name ILIKE $${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM notifications n LEFT JOIN courses c ON c.id = n.course_id ${where}`,
      params,
    ),
    query(
      `SELECT n.*, c.display_name AS course_name, u.username AS sent_by_username
       FROM notifications n
       LEFT JOIN courses c ON c.id = n.course_id
       LEFT JOIN users u ON u.id = n.sent_by
       ${where}
       ORDER BY n.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  return {
    data: dataR.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}
