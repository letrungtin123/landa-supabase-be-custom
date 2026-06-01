// ═══════════════════════════════════════════════════════════════
// Notifications Service
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';

export async function sendCourseNotification(
  courseId: string,
  tenantId: string,
  title: string,
  message: string,
  sentBy: string,
): Promise<{ success: boolean; recipients: number }> {
  // Count enrolled users
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT user_id) AS count
     FROM enrollments
     WHERE course_id = $1 AND tenant_id = $2 AND is_active = true`,
    [courseId, tenantId],
  );
  const recipients = parseInt(countResult.rows[0]?.count ?? '0');

  // Log notification
  await query(
    `INSERT INTO notifications (tenant_id, course_id, title, message, sent_by, recipient_count)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, courseId, title, message, sentBy, recipients],
  );

  return { success: true, recipients };
}

export async function getNotifications(
  tenantId: string,
  page = 1,
  pageSize = 20,
): Promise<{ data: any[]; total: number }> {
  const offset = (page - 1) * pageSize;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM notifications WHERE tenant_id = $1`,
    [tenantId],
  );

  const result = await query(
    `SELECT n.*, c.display_name AS course_name, u.username AS sent_by_username
     FROM notifications n
     LEFT JOIN courses c ON c.id = n.course_id
     LEFT JOIN users u ON u.id = n.sent_by
     WHERE n.tenant_id = $1
     ORDER BY n.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, pageSize, offset],
  );

  return {
    data: result.rows,
    total: parseInt(countResult.rows[0]?.count ?? '0'),
  };
}
