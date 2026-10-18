// ═══════════════════════════════════════════════════════════════
// Learner Service — Business logic cho learner portal
// Tối ưu cho multi-tenant + hàng triệu rows
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { cacheJson, getCacheVersion, setCacheJson } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import {
  invalidateUserBadgeCaches,
  invalidateUserCourseProgressCache,
  invalidateUserNotificationCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { isLearnerRole } from '../../types/index.js';
import { recalculateEnrollmentProgress } from './progress-calculation.service.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';
import { toLearnerBlockRow } from './learner-block-row.logic.js';
import { LEARNER_BLOCK_SERIALIZATION_VERSION } from './learner-answer-key.logic.js';
import { gradeBlockAnswer } from './learner-grading.logic.js';
import { createLearnerCoursesRepository } from './learner-courses.repository.js';
import { createLearnerLibraryRepository } from './learner-library.repository.js';
import { planBlockCompletion, type ActiveBlockCompletionRow, type MarkBlocksCompleteResult } from './learner-completion.logic.js';
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

const coursesRepository = createLearnerCoursesRepository({ query });
const libraryRepository = createLearnerLibraryRepository({ query });

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
    learnerUserId: isLearnerRole(role) ? userId : undefined,
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
  const learnerUserId = isLearnerRole(role) ? userId : undefined;

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
  const result = await libraryRepository.selectCategories(tenantId, isLearnerRole(role) ? userId : undefined);
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
  const filter = { tenantId, learnerUserId: isLearnerRole(role) ? userId : undefined, category, extension, search };

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
  const result = await query<any>(
    `SELECT e.id, e.course_id, e.enrolled_at, e.is_active,
            c.display_name, c.image_url, c.org,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true AND c.deleted_at IS NULL
     ORDER BY e.enrolled_at DESC`,
    [userId, tenantId],
  );

  return result.rows;
}

/**
 * Learner tự ghi danh vào khóa học.
 * Kiểm tra: course thuộc tenant + learner có quyền truy cập (qua team).
 */
export async function selfEnroll(userId: string, courseId: string, tenantId: string, role = 'learner') {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi danh');

  await assertLearnerCourseAccess(courseId, userId, tenantId, role);

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
    await recalculateEnrollmentProgress(existing.rows[0].id, courseId);
    await invalidateUserCourseProgressCache(userId, courseId);
    await invalidateUserBadgeCaches([userId]);
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
  await query(
    `UPDATE course_progress
     SET last_activity_at = now()
     WHERE enrollment_id = $1::uuid
       AND (last_activity_at IS NULL OR last_activity_at < now() - interval '5 minutes')`,
    [enrollmentId],
  );
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
  const enrollment = await query<{ id: string }>(
    `SELECT e.id
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     WHERE e.user_id = $1
       AND e.course_id = $2
       AND e.is_active = true
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [userId, courseId],
  );

  if (enrollment.rowCount === 0) {
    throw new AppError('Chưa ghi danh khóa học này', 400);
  }

  const enrollmentId = enrollment.rows[0].id;

  // Same block filter as before; `completed` tells which ones are already done.
  const activeBlocks = await query<ActiveBlockCompletionRow>(
    `WITH RECURSIVE ancestors AS (
       SELECT id AS root_id, id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = ANY($2::uuid[])
       UNION ALL
       SELECT a.root_id, parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id,
            EXISTS (
              SELECT 1
              FROM block_completions bc
              WHERE bc.enrollment_id = $3::uuid
                AND bc.block_id = b.id
            ) AS completed
     FROM course_blocks b
     WHERE b.course_id = $1
       AND b.id = ANY($2::uuid[])
       AND b.is_published = true
       AND b.deleted_at IS NULL
       AND b.block_type NOT IN ('course','chapter','sequential','vertical')
       AND NOT EXISTS (
         SELECT 1
         FROM ancestors a
         WHERE a.root_id = b.id
           AND a.deleted_at IS NOT NULL
       )`,
    [courseId, blockIds, enrollmentId],
  );
  const { marked, missing } = planBlockCompletion(activeBlocks.rows);

  // Nothing new (all already completed, or no valid leaf): no completion
  // write, no recalculation, no cache bump; only "last activity" moves.
  if (missing.length === 0) {
    await touchEnrollmentLastActivity(enrollmentId);
    return { marked, newly_completed: 0 };
  }

  const inserted = await query<{ block_id: string }>(
    `INSERT INTO block_completions (enrollment_id, block_id)
     SELECT $1::uuid, block_id
     FROM unnest($2::uuid[]) AS requested(block_id)
     ON CONFLICT DO NOTHING
     RETURNING block_id`,
    [enrollmentId, missing],
  );
  const newlyCompleted = inserted.rowCount ?? inserted.rows.length;
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
  const result = await query<any>(
    `SELECT cp.progress, cp.is_completed, cp.completed_at, cp.last_activity_at
     FROM course_progress cp
     JOIN enrollments e ON e.id = cp.enrollment_id
     JOIN courses c ON c.id = e.course_id
     WHERE e.user_id = $1 AND e.course_id = $2 AND e.is_active = true
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [userId, courseId],
  );

  if (result.rowCount === 0) {
    return { progress: 0, is_completed: false, completed_at: null, last_activity_at: null };
  }

  const row = result.rows[0];
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

  const result = await query<{
    course_id: string;
    progress: string;
    is_completed: boolean;
    completed_at: string | null;
  }>(
    `SELECT e.course_id,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at
     FROM enrollments e
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1
       AND e.tenant_id = $2
       AND e.course_id = ANY($3)
       AND e.is_active = true`,
    [userId, tenantId, courseIds],
  );

  const progress: Record<string, {
    progress: number;
    is_completed: boolean;
    completed_at: string | null;
  }> = {};

  for (const row of result.rows) {
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
  await query(
    'UPDATE user_badges SET is_shown = $1 WHERE user_id = $2 AND badge_id = $3',
    [isShown, userId, badgeId],
  );
  // The kept overview lists this badge as a pending popup.
  await invalidateUserBadgeCaches([userId]);
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

  // Total and unread come from the same query (window aggregates over all
  // of the user's notifications of the tenant).
  const unreadKey = await unreadNotificationCacheKey(userId, tenantId);
  const result = await query<any>(
    `SELECT n.id, n.title, n.message, n.course_id, n.type, n.metadata, n.created_at,
            nr.is_read, nr.read_at,
            u.full_name AS sent_by_name,
            COUNT(*) OVER() AS full_count,
            COUNT(*) FILTER (WHERE nr.is_read = false) OVER() AS unread_full_count
     FROM notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     LEFT JOIN users u ON u.id = n.sent_by
     WHERE nr.user_id = $1 AND n.tenant_id = $2
     ORDER BY n.created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, tenantId, page_size, offset],
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');
  let unreadCount: number;
  if (result.rows.length > 0) {
    unreadCount = parseInt(result.rows[0].unread_full_count);
    // Fresh value for the header badge (GET /notifications/unread-count).
    await setCacheJson(unreadKey, unreadCount, CACHE_TTL.notificationUnread);
  } else {
    // A page past the end has no row to carry the counts.
    unreadCount = await getUnreadCount(userId, tenantId);
  }

  return {
    data: result.rows.map((r: any) => {
      const { full_count, unread_full_count, ...rest } = r;
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
    async () => {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
         WHERE nr.user_id = $1 AND n.tenant_id = $2 AND nr.is_read = false`,
        [userId, tenantId],
      );
      return parseInt(result.rows[0].count);
    },
  );
}

export async function markNotificationRead(userId: string, notificationId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể cập nhật thông báo');
  await query(
    `UPDATE notification_recipients SET is_read = true, read_at = now()
     WHERE user_id = $1 AND notification_id = $2`,
    [userId, notificationId],
  );
  await invalidateUserNotificationCaches(userId);
}

export async function markAllNotificationsRead(userId: string, tenantId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể cập nhật thông báo');
  await query(
    `UPDATE notification_recipients nr SET is_read = true, read_at = now()
     FROM notifications n
     WHERE nr.notification_id = n.id AND nr.user_id = $1 AND n.tenant_id = $2 AND nr.is_read = false`,
    [userId, tenantId],
  );
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
  const result = await query<any>(
    `SELECT welcome_enabled, welcome_title, welcome_description,
            confirm_enabled, confirm_title, confirm_description, confirm_checkbox_text,
            completion_enabled, completion_title, completion_description,
            completion_social_type, completion_social_link
     FROM course_modal_configs WHERE course_id = $1`,
    [courseId],
  );
  if (result.rowCount === 0) {
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
  return result.rows[0];
}

/**
 * Lấy trạng thái modal per-user per-course.
 * Tạo row mặc định nếu chưa có.
 */
export async function getCourseModalState(userId: string, courseId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi modal state');
  const result = await query<any>(
    `INSERT INTO course_modal_states (user_id, course_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, course_id) DO NOTHING
     RETURNING *`,
    [userId, courseId],
  );
  if (result.rowCount && result.rowCount > 0) {
    return result.rows[0];
  }
  const existing = await query<any>(
    `SELECT * FROM course_modal_states WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  return existing.rows[0] || { course_id: courseId, welcome_shown: false, confirm_shown: false, complete_shown: false };
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

  const sets: string[] = [];
  const params: unknown[] = [userId, courseId];
  let idx = 3;

  if (updates.welcome_shown !== undefined) { sets.push(`welcome_shown = $${idx++}`); params.push(updates.welcome_shown); }
  if (updates.confirm_shown !== undefined) { sets.push(`confirm_shown = $${idx++}`); params.push(updates.confirm_shown); }
  if (updates.complete_shown !== undefined) { sets.push(`complete_shown = $${idx++}`); params.push(updates.complete_shown); }

  if (sets.length === 0) return getCourseModalState(userId, courseId);

  sets.push('updated_at = NOW()');

  // Upsert: nếu chưa có row thì tạo mới
  await query(
    `INSERT INTO course_modal_states (user_id, course_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, course_id) DO NOTHING`,
    [userId, courseId],
  );

  await query(
    `UPDATE course_modal_states SET ${sets.join(', ')} WHERE user_id = $1 AND course_id = $2`,
    params,
  );

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
  const result = await query<any>(
    `SELECT section_id, title, description
     FROM section_modal_configs
     WHERE course_id = $1 AND enabled = true`,
    [courseId],
  );
  return result.rows;
}

/**
 * Lấy danh sách section đã xem popup per-user per-course.
 */
export async function getSectionModalShown(userId: string, courseId: string) {
  const result = await query<any>(
    `SELECT section_id FROM section_modal_shown
     WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  return { shown_sections: result.rows.map((r: any) => r.section_id) };
}

/**
 * Đánh dấu section đã xem popup.
 */
export async function markSectionModalShown(userId: string, courseId: string, sectionId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản demo iframe không thể ghi modal state');
  await query(
    `INSERT INTO section_modal_shown (user_id, course_id, section_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, course_id, section_id) DO NOTHING`,
    [userId, courseId, sectionId],
  );
  return { success: true };
}
