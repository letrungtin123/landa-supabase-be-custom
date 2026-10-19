// Learner notifications (list, unread count, read marks) and the course and
// section pop-ups (configs and shown state). Moved unchanged from
// learner.service.ts, which re-exports them.

import { query } from '../../config/database.js';
import { cacheJson, getCacheVersion, setCacheJson } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateUserNotificationCaches } from '../../config/cache-invalidation.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';
import { createLearnerNotificationsRepository } from './learner-notifications.repository.js';

const notificationsRepository = createLearnerNotificationsRepository({ query });

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

  // Total and unread come from the same query (window aggregates over all
  // of the user's notifications of the tenant).
  const unreadKey = await unreadNotificationCacheKey(userId, tenantId);
  const rows = await notificationsRepository.selectNotifications(userId, tenantId, page_size, offset);

  const total = parseInt(rows[0]?.full_count ?? '0');
  let unreadCount: number;
  if (rows.length > 0) {
    unreadCount = parseInt(rows[0].unread_full_count);
    // Fresh value for the header badge (GET /notifications/unread-count).
    await setCacheJson(unreadKey, unreadCount, CACHE_TTL.notificationUnread);
  } else {
    // A page past the end has no row to carry the counts.
    unreadCount = await getUnreadCount(userId, tenantId);
  }

  return {
    data: rows.map(r => {
      const { full_count: _fullCount, unread_full_count: _unreadFullCount, ...rest } = r;
      return rest;
    }),
    total,
    unread_count: unreadCount,
  };
}

/**
 * Key of a user's cached unread count: bumped when the user reads
 * notifications and when notifications of the tenant are created or deleted;
 * the short TTL bounds anything else.
 */
async function unreadNotificationCacheKey(userId: string, tenantId: string): Promise<string> {
  const [tenantVersion, userVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.tenantNotifications(tenantId)),
    getCacheVersion(...cacheVersions.userNotifications(userId)),
  ]);
  return cacheKeys.learnerResource(tenantId, userId, 'notifications-unread', [tenantVersion, userVersion]);
}

export async function getUnreadCount(userId: string, tenantId: string): Promise<number> {
  return cacheJson(
    await unreadNotificationCacheKey(userId, tenantId),
    CACHE_TTL.notificationUnread,
    () => notificationsRepository.countUnread(userId, tenantId),
  );
}

export async function markNotificationRead(userId: string, notificationId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể cập nhật thông báo');
  await notificationsRepository.markRead(userId, notificationId);
  await invalidateUserNotificationCaches(userId);
}

export async function markAllNotificationsRead(userId: string, tenantId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể cập nhật thông báo');
  await notificationsRepository.markAllRead(userId, tenantId);
  await invalidateUserNotificationCaches(userId);
}

// ══════════════════════════════════════════════════
// Course Modal Config + State (Welcome / Confirm / Complete)
// ══════════════════════════════════════════════════

/**
 * Lấy cấu hình modal (admin đã setup) cho course.
 * Trả defaults nếu chưa có config.
 */
export async function getCourseModalConfig(courseId: string) {
  const version = await getCacheVersion(...cacheVersions.courseModal(courseId));
  return cacheJson(
    cacheKeys.courseResource(courseId, 'modal-config', version),
    CACHE_TTL.courseModal,
    () => getCourseModalConfigFromDb(courseId),
  );
}

async function getCourseModalConfigFromDb(courseId: string) {
  const config = await notificationsRepository.selectCourseModalConfig(courseId);
  if (!config) {
    return {
      welcome_enabled: true,
      welcome_title: '',
      welcome_description: '',
      confirm_enabled: true,
      confirm_title: '',
      confirm_description: '',
      confirm_checkbox_text: '',
      completion_enabled: true,
      completion_title: '',
      completion_description: '',
      completion_social_type: null,
      completion_social_link: null,
    };
  }
  return config;
}

/**
 * Lấy trạng thái modal per-user per-course.
 * Tạo row mặc định nếu chưa có.
 */
export async function getCourseModalState(userId: string, courseId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi modal state');
  const created = await notificationsRepository.createCourseModalState(userId, courseId);
  if (created) {
    return created;
  }
  const existing = await notificationsRepository.selectCourseModalState(userId, courseId);
  return existing || { course_id: courseId, welcome_shown: false, confirm_shown: false, complete_shown: false };
}

/**
 * Cập nhật trạng thái modal per-user per-course (partial update).
 */
export async function updateCourseModalState(
  userId: string,
  courseId: string,
  updates: { welcome_shown?: boolean; confirm_shown?: boolean; complete_shown?: boolean },
) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi modal state');

  // No flag given: nothing is written, the state is read as is.
  await notificationsRepository.updateCourseModalState(userId, courseId, updates);

  return getCourseModalState(userId, courseId);
}

// ══════════════════════════════════════════════════
// Section Modal (Khích lệ từng section)
// ══════════════════════════════════════════════════

/**
 * Lấy danh sách section modal configs (admin đã setup) cho course.
 * Chỉ trả configs đã bật (enabled = true).
 */
export async function getSectionModalConfigs(courseId: string) {
  const version = await getCacheVersion(...cacheVersions.courseModal(courseId));
  return cacheJson(
    cacheKeys.courseResource(courseId, 'section-modal-configs', version),
    CACHE_TTL.courseModal,
    () => getSectionModalConfigsFromDb(courseId),
  );
}

async function getSectionModalConfigsFromDb(courseId: string) {
  return notificationsRepository.selectSectionModalConfigs(courseId);
}

/**
 * Lấy danh sách section đã xem popup per-user per-course.
 */
export async function getSectionModalShown(userId: string, courseId: string) {
  return { shown_sections: await notificationsRepository.selectShownSectionIds(userId, courseId) };
}

/**
 * Đánh dấu section đã xem popup.
 */
export async function markSectionModalShown(userId: string, courseId: string, sectionId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi modal state');
  await notificationsRepository.markSectionShown(userId, courseId, sectionId);
  return { success: true };
}
