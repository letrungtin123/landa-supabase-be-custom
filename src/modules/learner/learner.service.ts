// ═══════════════════════════════════════════════════════════════
// Learner Service — Business logic cho learner portal
// Tối ưu cho multi-tenant + hàng triệu rows
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateUserBadgeCaches, invalidateUserCourseProgressCache } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { isLearnerRole } from '../../types/index.js';
import { recalculateEnrollmentProgress } from './progress-calculation.service.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';
import { toLearnerBlockRow } from './learner-block-row.logic.js';
import { LEARNER_BLOCK_SERIALIZATION_VERSION } from './learner-answer-key.logic.js';
import { gradeBlockAnswer } from './learner-grading.logic.js';
import { createLearnerCoursesRepository } from './learner-courses.repository.js';
import { createLearnerLibraryRepository } from './learner-library.repository.js';
import { createLearnerProgressRepository } from './learner-progress.repository.js';
import { planBlockCompletion, type MarkBlocksCompleteResult } from './learner-completion.logic.js';
import {
  buildLearnerCourseStructure,
  overlayLearnerBlockCompletions,
  type LearnerCourseBlocksState,
  type LearnerCourseStructure,
} from './learner-course-blocks.logic.js';
import {
  evaluateUserBadges,
  getEffectiveBadgeDefinitions,
} from '../badges/badge-evaluation.service.js';
import { isUuid } from '../../utils/uuid.js';
// Notifications and the course/section pop-ups live in learner-notifications.service.ts;
// these names stay importable from here.
export {
  getMyNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  getCourseModalConfig,
  getCourseModalState,
  updateCourseModalState,
  getSectionModalConfigs,
  getSectionModalShown,
  markSectionModalShown,
} from './learner-notifications.service.js';

const coursesRepository = createLearnerCoursesRepository({ query });
const libraryRepository = createLearnerLibraryRepository({ query });
const progressRepository = createLearnerProgressRepository({ query });

/**
 * The learner whose rows a learner-role caller may see, or undefined for staff. The repositories
 * choose the learner scope by this value, so a learner role without a user id is refused here
 * instead of falling back to the staff scope.
 */
export function learnerScope(role: string, userId: string | null | undefined): string | undefined {
  if (!isLearnerRole(role)) return undefined;
  if (typeof userId !== 'string' || userId.trim() === '') throw new AppError('Chưa xác thực', 401);
  return userId;
}

async function assertLearnerCourseAccess(
  courseId: string,
  userId: string,
  tenantId: string | null | undefined,
  role: string,
  message = 'Bạn không có quyền truy cập khóa học này',
): Promise<void> {
  if (!tenantId) throw new AppError('Thiếu tenant', 400);

  const accessible = await coursesRepository.courseAccessible({
    courseId,
    tenantId,
    learnerUserId: learnerScope(role, userId),
  });
  if (!accessible) throw new AppError(message, isLearnerRole(role) ? 403 : 404);
}

/**
 * Popup configs and popup states are keyed only by course id: the caller must
 * be able to open that course (its tenant; for learners, an assigned course),
 * with the same refusal as the other learner course endpoints.
 */
export async function assertCoursePopupAccess(
  courseId: string,
  userId: string,
  tenantId: string | null | undefined,
  role: string,
): Promise<void> {
  if (typeof courseId !== 'string' || !courseId.trim() || courseId.length > 255) {
    throw new AppError('Không tìm thấy khóa học', 404);
  }
  await assertLearnerCourseAccess(courseId, userId, tenantId, role);
}

/** A section popup can only be marked for a section (chapter) of that course. */
export async function assertCourseSection(courseId: string, sectionId: unknown): Promise<string> {
  if (!isUuid(sectionId)) {
    throw new AppError('Không tìm thấy phần học này', 404);
  }
  if (!(await coursesRepository.sectionOfCourse(sectionId, courseId))) throw new AppError('Không tìm thấy phần học này', 404);
  return sectionId;
}

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
  params: { search?: string; category_id?: string; page?: number; page_size?: number },
) {
  const [membershipVersion, coursesVersion, categoriesVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.userMembership(userId)),
    getCacheVersion(...cacheVersions.tenantCourses(tenantId)),
    getCacheVersion(...cacheVersions.tenantCourseCategories(tenantId)),
  ]);
  return cacheJson(
    cacheKeys.learnerResource(tenantId, userId, 'courses', [membershipVersion, coursesVersion, categoriesVersion], { role, params }),
    CACHE_TTL.learnerCourses,
    () => getMyVisibleCoursesFromDb(userId, tenantId, role, params),
  );
}

async function getMyVisibleCoursesFromDb(
  userId: string,
  tenantId: string,
  role: string,
  params: { search?: string; category_id?: string; page?: number; page_size?: number },
) {
  const { search, category_id, page = 1, page_size = 20 } = params;
  const offset = (page - 1) * page_size;
  const learnerUserId = learnerScope(role, userId);

  const rows = await coursesRepository.selectVisibleCourses({
    tenantId, learnerUserId, categoryId: category_id, search, limit: page_size, offset,
  });

  const total = parseInt(rows[0]?.full_count ?? '0');
  const courseIds = rows.map(r => r.id);

  // Fetch categories for returned courses
  const categoriesByCourse: Record<string, { id: string; name: string }[]> = {};
  if (courseIds.length > 0) {
    for (const row of await coursesRepository.selectCategoriesOfCourses(courseIds)) {
      if (!categoriesByCourse[row.course_id]) categoriesByCourse[row.course_id] = [];
      categoriesByCourse[row.course_id].push({ id: row.id, name: row.name });
    }
  }

  // Fetch categories visible to this user for the FE filter dropdown.
  const categories = await coursesRepository.selectFilterCategories(tenantId, learnerUserId);

  return {
    data: rows.map(r => {
      const { full_count: _fullCount, ...rest } = r;
      return { ...rest, categories: categoriesByCourse[r.id] || [] };
    }),
    categories,
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
  const [courseVersion, membershipVersion, coursesVersion, categoriesVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.courseContent(courseId)),
    getCacheVersion(...cacheVersions.userMembership(userId)),
    getCacheVersion(...cacheVersions.tenantCourses(tenantId)),
    getCacheVersion(...cacheVersions.tenantCourseCategories(tenantId)),
  ]);
  return cacheJson(
    cacheKeys.learnerResource(tenantId, userId, `course:${courseId}`, [courseVersion, membershipVersion, coursesVersion, categoriesVersion], { role }),
    CACHE_TTL.courseDetail,
    () => getCourseDetailFromDb(courseId, userId, tenantId, role),
  );
}

async function getCourseDetailFromDb(
  courseId: string,
  userId: string,
  tenantId: string,
  role: string,
) {
  const row = await coursesRepository.selectCourseDetail(courseId, tenantId);

  if (!row) throw new AppError('Khóa học không tồn tại', 404);

  if (isLearnerRole(role)) {
    await assertLearnerCourseAccess(courseId, userId, tenantId, role);
  }

  const {
    mentor_id,
    mentor_full_name,
    mentor_email,
    mentor_phone,
    mentor_avatar,
    mentor_bio,
    mentor_role,
    mentor_section_description,
    mentor_section_logo_light,
    mentor_section_logo_dark,
    ...coursePayload
  } = row;

  const mentorSection = mentor_section_description || mentor_section_logo_light || mentor_section_logo_dark
    ? {
        description: mentor_section_description || null,
        logo_light: mentor_section_logo_light || null,
        logo_dark: mentor_section_logo_dark || null,
      }
    : null;

  return {
    ...coursePayload,
    mentor_section: mentorSection,
    mentors: mentor_id ? [{
      id: mentor_id,
      full_name: mentor_full_name,
      name: mentor_full_name || mentor_email,
      email: mentor_email,
      phone: mentor_phone,
      phone_number: mentor_phone,
      avatar: mentor_avatar,
      profile_image_url: mentor_avatar,
      bio: mentor_bio,
      role: mentor_role || 'staff',
      company: '',
    }] : [],
  };
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
  role = 'learner',
  tenantId?: string | null,
  isDemoIframe = false,
) {
  const [courseVersion, progressVersion, coursesVersion, categoriesVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.courseContent(courseId)),
    isDemoIframe ? Promise.resolve('demo-iframe') : getCacheVersion(...cacheVersions.userCourseProgress(userId, courseId)),
    tenantId ? getCacheVersion(...cacheVersions.tenantCourses(tenantId)) : Promise.resolve('0'),
    tenantId ? getCacheVersion(...cacheVersions.tenantCourseCategories(tenantId)) : Promise.resolve('0'),
  ]);
  // Same invalidation as the former per-learner cache: course content and the
  // tenant's course / category assignments; the learner part also follows
  // the learner's own progress version.
  const contentVersion = `${courseVersion}:${coursesVersion}:${categoriesVersion}`;

  // Per learner, never shared: the access check and the completed block ids.
  const learnerState = await cacheJson(
    cacheKeys.courseResource(courseId, 'blocks-learner-state', `${contentVersion}:${progressVersion}`, {
      userId, role, tenantId: tenantId ?? null, demo: isDemoIframe,
    }),
    CACHE_TTL.courseBlocks,
    () => getCourseBlocksLearnerStateFromDb(courseId, userId, role, tenantId, isDemoIframe),
  );

  // One copy per course version for every learner: published blocks with
  // answer keys removed (user-independent, see learner-answer-key.logic.ts).
  const structure = await cacheJson(
    cacheKeys.courseResource(courseId, 'blocks-structure', contentVersion, { shape: LEARNER_BLOCK_SERIALIZATION_VERSION }),
    CACHE_TTL.courseBlocks,
    () => getCourseBlocksStructureFromDb(courseId),
  );

  return overlayLearnerBlockCompletions(structure, learnerState.completed_block_ids);
}

async function getCourseBlocksLearnerStateFromDb(
  courseId: string,
  userId: string,
  role = 'learner',
  tenantId?: string | null,
  isDemoIframe = false,
): Promise<LearnerCourseBlocksState> {
  await assertLearnerCourseAccess(courseId, userId, tenantId, role);
  if (isDemoIframe) return { completed_block_ids: [] };

  return { completed_block_ids: await coursesRepository.selectCompletedBlockIds(courseId, userId) };
}

async function getCourseBlocksStructureFromDb(courseId: string): Promise<LearnerCourseStructure> {
  return buildLearnerCourseStructure(await coursesRepository.selectPublishedBlockTree(courseId));
}

/**
 * Lấy chi tiết 1 block đơn lẻ.
 * Learner route → LUÔN trả published_data, bất kể role.
 * The block is cached once for every learner; the access check stays per
 * learner (cached under the same key parts as the former per-learner copy).
 */
export async function getBlockDetail(
  blockId: string,
  userId: string,
  role = 'learner',
  tenantId?: string | null,
) {
  const version = await getCacheVersion(...cacheVersions.blockContent(blockId));
  const block = await cacheJson(
    cacheKeys.blockResource(blockId, `${version}:shared:${LEARNER_BLOCK_SERIALIZATION_VERSION}`),
    CACHE_TTL.blockDetail,
    () => getBlockDetailFromDb(blockId),
  );
  await cacheJson(
    cacheKeys.blockResource(blockId, `${version}:${tenantId || 'no-tenant'}:${userId}:${role}:access`),
    CACHE_TTL.blockDetail,
    async () => {
      await assertLearnerCourseAccess(block.course_id, userId, tenantId, role);
      return true;
    },
  );
  return block;
}

async function getBlockDetailFromDb(blockId: string) {
  const row = await coursesRepository.selectBlockDetail(blockId);
  if (!row) throw new AppError('Block không tồn tại', 404);
  return toLearnerBlockRow(row);
}

/**
 * Submit đáp án cho block (problem/crossword/sortable).
 * Server-side grading: so sánh đáp án user với đáp án đúng trong DB.
 */
export async function submitBlockAnswer(
  blockId: string,
  userId: string,
  role: string,
  tenantId: string | null | undefined,
  body: unknown,
) {
  const block = await coursesRepository.selectSubmittableBlock(blockId);
  if (!block) throw new AppError('Block không tồn tại hoặc chưa được publish', 404);
  await assertLearnerCourseAccess(block.course_id, userId, tenantId, role);

  return gradeBlockAnswer(block, body);
}

// ── Course Files (tài liệu tham khảo) ──

/**
 * Lấy danh sách file/tài liệu đính kèm của course.
 * Learner chỉ thấy file chưa bị khóa (is_locked = false).
 */
export async function getCourseFiles(courseId: string, userId: string, role = 'learner', tenantId?: string | null) {
  const [version, coursesVersion, categoriesVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.courseAssets(courseId)),
    tenantId ? getCacheVersion(...cacheVersions.tenantCourses(tenantId)) : Promise.resolve('0'),
    tenantId ? getCacheVersion(...cacheVersions.tenantCourseCategories(tenantId)) : Promise.resolve('0'),
  ]);
  const versionKey = `${version}:${coursesVersion}:${categoriesVersion}`;
  // Per learner (same key parts as the former per-learner copy): the access check.
  await cacheJson(
    cacheKeys.courseResource(courseId, 'files-access', versionKey, { userId, role, tenantId: tenantId ?? null }),
    CACHE_TTL.courseFiles,
    async () => {
      await assertLearnerCourseAccess(courseId, userId, tenantId, role);
      return true;
    },
  );
  // One list per course for every learner (locked files hidden) and one for staff.
  const learnerView = isLearnerRole(role);
  return cacheJson(
    cacheKeys.courseResource(courseId, 'files-list', versionKey, { learnerView }),
    CACHE_TTL.courseFiles,
    () => getCourseFilesFromDb(courseId, learnerView),
  );
}

async function getCourseFilesFromDb(courseId: string, learnerView: boolean) {
  const result = await coursesRepository.selectCourseFiles(courseId, learnerView);

  return {
    files: result.rows.map(r => {
      const ext = r.display_name?.split('.').pop()?.toLowerCase() || '';
      return {
        id: r.id,
        display_name: r.display_name,
        url: r.url,
        extension: ext,
        content_type: r.content_type,
        size: parseInt(r.file_size as string) || 0,
        date_added: r.created_at,
      };
    }),
    total: result.rowCount || 0,
  };
}

// ── Library (Kho tài liệu theo danh mục) ──

/**
 * Lấy danh mục tài liệu mà learner được phép xem.
 * Learner: thấy danh mục công khai hoặc danh mục được phân qua team.
 * Staff/superuser/superadmin: thấy tất cả danh mục trong tenant.
 */
export async function getMyLibraryCategories(
  userId: string,
  tenantId: string,
  role: string,
) {
  const [libraryVersion, membershipVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.tenantLibrary(tenantId)),
    getCacheVersion(...cacheVersions.userMembership(userId)),
  ]);
  return cacheJson(
    cacheKeys.learnerResource(tenantId, userId, 'library-categories', [libraryVersion, membershipVersion], { role }),
    CACHE_TTL.library,
    () => getMyLibraryCategoriesFromDb(userId, tenantId, role),
  );
}

async function getMyLibraryCategoriesFromDb(
  userId: string,
  tenantId: string,
  role: string,
) {
  const result = await libraryRepository.selectCategories(tenantId, learnerScope(role, userId));
  return {
    categories: result.rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug || '',
      count: parseInt(String(r.count)) || 0,
    })),
    total: result.rowCount || 0,
  };
}

/**
 * Lấy tài liệu mà learner được phép xem theo danh mục công khai hoặc danh mục của team.
 * Staff+: tất cả tài liệu trong tenant theo luồng hiện tại.
 */
export async function getMyLibraryDocuments(
  userId: string,
  tenantId: string,
  role: string,
  params: {
    page?: number;
    page_size?: number;
    category?: string;
    extension?: string;
    search?: string;
    ordering?: string;
  },
) {
  const [libraryVersion, membershipVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.tenantLibrary(tenantId)),
    getCacheVersion(...cacheVersions.userMembership(userId)),
  ]);
  return cacheJson(
    cacheKeys.learnerResource(tenantId, userId, 'library-documents', [libraryVersion, membershipVersion], { role, params }),
    CACHE_TTL.library,
    () => getMyLibraryDocumentsFromDb(userId, tenantId, role, params),
  );
}

async function getMyLibraryDocumentsFromDb(
  userId: string,
  tenantId: string,
  role: string,
  params: {
    page?: number;
    page_size?: number;
    category?: string;
    extension?: string;
    search?: string;
    ordering?: string;
  },
) {
  const { page = 1, page_size = 20, category, extension, search, ordering } = params;
  const offset = (page - 1) * page_size;
  const filter = { tenantId, learnerUserId: learnerScope(role, userId), category, extension, search };

  const total = await libraryRepository.countDocuments(filter);
  const rows = await libraryRepository.selectDocuments(filter, { ordering, limit: page_size, offset });

  return {
    count: total,
    next: page * page_size < total ? `page=${page + 1}` : null,
    previous: page > 1 ? `page=${page - 1}` : null,
    results: rows.map(r => ({
      id: r.id,
      title: r.title,
      extension: r.extension || '',
      file_size: parseInt(r.file_size as string) || 0,
      category_id: r.category_id || null,
      category_name: r.category_name || '',
      category_slug: r.category_slug || '',
      is_public: r.is_public === true,
      download_url: r.file_url,
      uploaded_by_name: r.uploaded_by_name || '',
      created_at: r.created_at,
    })),
  };
}
// ── Enrollments ──

/**
 * Lấy enrollments của user kèm progress.
 * JOIN course_progress để lấy progress % và completion status.
 */
export async function getMyEnrollments(userId: string, tenantId: string) {
  return progressRepository.selectEnrollments(userId, tenantId);
}

/**
 * Learner tự ghi danh vào khóa học.
 * Kiểm tra: course thuộc tenant + learner có quyền truy cập (qua team).
 */
export async function selfEnroll(userId: string, courseId: string, tenantId: string, role = 'learner') {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi danh');

  await assertLearnerCourseAccess(courseId, userId, tenantId, role);

  // Kiểm tra đã enroll chưa
  const existing = await progressRepository.findEnrollment(userId, courseId, tenantId);

  if (existing) {
    if (existing.is_active) {
      return { enrollment_id: existing.id, already_enrolled: true };
    }
    // Re-activate
    await progressRepository.reactivateEnrollment(existing.id);
    await recalculateEnrollmentProgress(existing.id, courseId);
    await invalidateUserCourseProgressCache(userId, courseId);
    await invalidateUserBadgeCaches([userId]);
    return { enrollment_id: existing.id, already_enrolled: false };
  }

  // Tạo enrollment + course_progress
  const enrollmentId = await progressRepository.createEnrollment(userId, courseId, tenantId);
  await invalidateUserCourseProgressCache(userId, courseId);

  return { enrollment_id: enrollmentId, already_enrolled: false };
}

// ── Block Completion ──

/**
 * A learner revisiting completed units keeps the admin's "last activity"
 * moving, at most once per 5 minutes per enrollment. One indexed UPDATE of a
 * fixed-size timestamp column; progress, is_completed and every cache
 * version stay as they are (no cached answer contains last_activity_at).
 */
async function touchEnrollmentLastActivity(enrollmentId: string): Promise<void> {
  await progressRepository.touchLastActivity(enrollmentId);
}

/**
 * Đánh dấu blocks hoàn thành (batch).
 * Only blocks the enrollment has not completed yet are written; progress is
 * recalculated (and the progress cache version bumped) only when a row was
 * actually inserted. `marked` keeps its meaning (see learner-completion.logic.ts).
 */
export async function markBlocksComplete(
  userId: string,
  courseId: string,
  blockIds: string[],
): Promise<MarkBlocksCompleteResult> {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi tiến độ');

  if (blockIds.length === 0) return { marked: 0, newly_completed: 0 };

  // Lấy enrollment
  const enrollmentId = await progressRepository.findActiveEnrollmentId(userId, courseId);

  if (enrollmentId === undefined) {
    throw new AppError('Chưa ghi danh khóa học này', 400);
  }

  // Same block filter as before; `completed` tells which ones are already done.
  const activeBlocks = await progressRepository.selectActiveBlocks(courseId, blockIds, enrollmentId);
  const { marked, missing } = planBlockCompletion(activeBlocks);

  // Nothing new (all already completed, or no valid leaf): no completion
  // write, no recalculation, no cache bump; only "last activity" moves.
  if (missing.length === 0) {
    await touchEnrollmentLastActivity(enrollmentId);
    return { marked, newly_completed: 0 };
  }

  const newlyCompleted = await progressRepository.insertBlockCompletions(enrollmentId, missing);
  // A concurrent request inserted them first and recalculates for itself.
  if (newlyCompleted === 0) return { marked, newly_completed: 0 };

  // Tính lại progress: completed_leaves / total_leaves
  const progress = await recalculateEnrollmentProgress(enrollmentId, courseId);
  await invalidateUserCourseProgressCache(userId, courseId);
  // Badges depend on completed courses only: re-evaluate when that changed.
  if (progress.completion_changed) await invalidateUserBadgeCaches([userId]);

  return {
    marked,
    newly_completed: newlyCompleted,
    ...(progress.updated
      ? { progress: progress.progress, is_completed: progress.is_completed, completion_changed: progress.completion_changed }
      : {}),
  };
}

// ── Progress ──

/**
 * Lấy progress chi tiết cho 1 khóa học.
 */
export async function getMyProgress(userId: string, courseId: string) {
  const row = await progressRepository.selectProgress(userId, courseId);

  if (!row) {
    return { progress: 0, is_completed: false, completed_at: null, last_activity_at: null };
  }

  return {
    ...row,
    progress: parseFloat(row.progress) || 0, // pg numeric → JS number
  };
}

/**
 * Lấy progress cho nhiều courses cùng lúc — 1 query duy nhất.
 * Giảm N API calls → 1 call cho FE batch progress.
 */
export async function getBatchProgress(
  userId: string,
  tenantId: string,
  courseIds: string[],
) {
  if (courseIds.length === 0) return { progress: {} };

  const rows = await progressRepository.selectBatchProgress(userId, tenantId, courseIds);

  const progress: Record<string, {
    progress: number;
    is_completed: boolean;
    completed_at: string | null;
  }> = {};

  for (const row of rows) {
    progress[row.course_id] = {
      progress: parseFloat(row.progress) || 0,
      is_completed: row.is_completed,
      completed_at: row.completed_at,
    };
  }

  return { progress };
}

// ── Badges ──

export async function getMyBadges(userId: string, tenantId: string) {
  const overview = await evaluateUserBadges(userId, tenantId);
  return overview.earned_badges;
}

export async function getActiveBadges(tenantId: string) {
  return getEffectiveBadgeDefinitions(tenantId);
}

export async function evaluateBadges(userId: string, tenantId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể nhận huy hiệu');
  return evaluateUserBadges(userId, tenantId);
}

/** Compatibility endpoint for old learner clients. badgeId is intentionally ignored. */
export async function saveBadge(userId: string, tenantId: string, _badgeId: string) {
  return evaluateBadges(userId, tenantId);
}

export async function updateBadgeShown(userId: string, badgeId: string, isShown: boolean) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể cập nhật huy hiệu');
  await progressRepository.setBadgeShown(userId, badgeId, isShown);
  // The kept overview lists this badge as a pending popup.
  await invalidateUserBadgeCaches([userId]);
}
