// ═══════════════════════════════════════════════════════════════
// Learner Service — Business logic cho learner portal
// Tối ưu cho multi-tenant + hàng triệu rows
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { isLearnerRole } from '../../types/index.js';

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
  const { search, category_id, page = 1, page_size = 20 } = params;
  const offset = (page - 1) * page_size;
  const sqlParams: unknown[] = [tenantId];
  let where = 'WHERE c.tenant_id = $1 AND c.deleted_at IS NULL';

  // learner: chỉ thấy courses assign qua team → category → course
  // Path: team_members → team_course_categories → course_category_courses
  // Fallback: team_courses (direct assignment, backward compat)
  if (isLearnerRole(role)) {
    // Learner không thấy courses bị ẩn (visible_to_staff_only = true)
    where += ' AND c.visible_to_staff_only = false';
    sqlParams.push(userId);
    where += ` AND c.id IN (
      SELECT DISTINCT ccc.course_id
      FROM team_course_categories tcc
      JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
      JOIN team_members tm ON tm.team_id = tcc.team_id
      WHERE tm.user_id = $${sqlParams.length}
      UNION
      SELECT DISTINCT tc.course_id
      FROM team_courses tc
      JOIN team_members tm ON tm.team_id = tc.team_id
      WHERE tm.user_id = $${sqlParams.length}
    )`;
  }

  // Filter theo category_id
  if (category_id) {
    sqlParams.push(category_id);
    where += ` AND c.id IN (SELECT course_id FROM course_category_courses WHERE category_id = $${sqlParams.length})`;
  }

  if (search) {
    sqlParams.push(`%${search}%`);
    where += ` AND (unaccent(c.display_name) ILIKE unaccent($${sqlParams.length}) OR unaccent(c.org) ILIKE unaccent($${sqlParams.length}))`;
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
  const courseIds = result.rows.map((r: any) => r.id);

  // Fetch categories for returned courses
  let categoriesByCourse: Record<string, { id: string; name: string }[]> = {};
  if (courseIds.length > 0) {
    const catResult = await query<any>(
      `SELECT ccc.course_id, cc.id, cc.name
       FROM course_category_courses ccc
       JOIN course_categories cc ON cc.id = ccc.category_id
       WHERE ccc.course_id = ANY($1)
       ORDER BY cc.name`,
      [courseIds],
    );
    for (const row of catResult.rows) {
      if (!categoriesByCourse[row.course_id]) categoriesByCourse[row.course_id] = [];
      categoriesByCourse[row.course_id].push({ id: row.id, name: row.name });
    }
  }

  // Fetch all categories for this tenant (for FE filter dropdown)
  const allCatsResult = await query<any>(
    `SELECT DISTINCT cc.id, cc.name
     FROM course_categories cc
     WHERE cc.tenant_id = $1
     ORDER BY cc.name`,
    [tenantId],
  );

  return {
    data: result.rows.map((r: any) => {
      const { full_count, ...rest } = r;
      return { ...rest, categories: categoriesByCourse[r.id] || [] };
    }),
    categories: allCatsResult.rows,
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
            c.visible_to_staff_only, c.created_at,
            mentor.id AS mentor_id,
            mentor.full_name AS mentor_full_name,
            mentor.email AS mentor_email,
            mentor.phone AS mentor_phone,
            mentor.avatar_url AS mentor_avatar,
            mentor.bio AS mentor_bio,
            mentor.role AS mentor_role,
            cms.description AS mentor_section_description,
            cms.logo_light_path AS mentor_section_logo_light,
            cms.logo_dark_path AS mentor_section_logo_dark
     FROM courses c
     LEFT JOIN users mentor ON mentor.id = c.mentor_id
     LEFT JOIN course_mentor_sections cms ON cms.course_id = c.id AND cms.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
    [courseId, tenantId],
  );

  if (result.rowCount === 0) throw new AppError('Khóa học không tồn tại', 404);

  const course = result.rows[0];

  // Learner không được xem course bị ẩn (visible_to_staff_only)
  if (isLearnerRole(role) && course.visible_to_staff_only) {
    throw new AppError('Khóa học không tồn tại', 404);
  }

  // learner: kiểm tra quyền truy cập qua team → category → course
  if (isLearnerRole(role)) {
    const access = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM team_course_categories tcc
        JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
        JOIN team_members tm ON tm.team_id = tcc.team_id
        WHERE ccc.course_id = $1 AND tm.user_id = $2
        UNION ALL
        SELECT 1 FROM team_courses tc
        JOIN team_members tm ON tm.team_id = tc.team_id
        WHERE tc.course_id = $1 AND tm.user_id = $2
      ) AS access_check`,
      [courseId, userId],
    );
    if (parseInt(access.rows[0].count) === 0) {
      throw new AppError('Bạn không có quyền truy cập khóa học này', 403);
    }
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
  } = result.rows[0];

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
) {
  const courseCheck = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND deleted_at IS NULL`,
    [courseId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('KhÃ³a há»c khÃ´ng tá»“n táº¡i', 404);

  // Lấy enrollment_id (nếu có) để join block_completions
  const enrollResult = await query<{ id: string }>(
    `SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2 AND is_active = true LIMIT 1`,
    [courseId, userId],
  );
  const enrollmentId = enrollResult.rows[0]?.id ?? null;

  // FE Learner (5173) LUÔN chỉ hiển thị published data, bất kể role.
  // Staff/admin muốn xem draft → dùng CMS route, KHÔNG dùng learner route.
  const isLearner = true;
  const publishFilter = 'AND b.is_published = true';

  // Learner route: luôn đọc published_data/published_metadata
  const dataCol = 'b.published_data';
  const metaCol = 'COALESCE(b.published_metadata, b.metadata)';

  let sql: string;
  let params: unknown[];

  if (enrollmentId) {
    sql = `WITH RECURSIVE active_tree AS (
             SELECT b.id, b.parent_id, b.block_type, b.display_name,
                    b.published_data, b.published_metadata, b.metadata,
                    b.sort_order, b.is_published
             FROM course_blocks b
             WHERE b.course_id = $1
               AND b.parent_id IS NULL
               AND b.deleted_at IS NULL ${publishFilter}
             UNION ALL
             SELECT child.id, child.parent_id, child.block_type, child.display_name,
                    child.published_data, child.published_metadata, child.metadata,
                    child.sort_order, child.is_published
             FROM course_blocks child
             JOIN active_tree parent ON parent.id = child.parent_id
             WHERE child.deleted_at IS NULL AND child.is_published = true
           )
           SELECT b.id, b.parent_id, b.block_type, b.display_name,
                  ${dataCol} AS data, ${metaCol} AS metadata,
                  b.sort_order, b.is_published,
                  CASE WHEN bc.id IS NOT NULL THEN true ELSE false END AS completed
           FROM active_tree b
           LEFT JOIN block_completions bc ON bc.block_id = b.id AND bc.enrollment_id = $2
           ORDER BY b.sort_order`;
    params = [courseId, enrollmentId];
  } else {
    sql = `WITH RECURSIVE active_tree AS (
             SELECT b.id, b.parent_id, b.block_type, b.display_name,
                    b.published_data, b.published_metadata, b.metadata,
                    b.sort_order, b.is_published
             FROM course_blocks b
             WHERE b.course_id = $1
               AND b.parent_id IS NULL
               AND b.deleted_at IS NULL ${publishFilter}
             UNION ALL
             SELECT child.id, child.parent_id, child.block_type, child.display_name,
                    child.published_data, child.published_metadata, child.metadata,
                    child.sort_order, child.is_published
             FROM course_blocks child
             JOIN active_tree parent ON parent.id = child.parent_id
             WHERE child.deleted_at IS NULL AND child.is_published = true
           )
           SELECT b.id, b.parent_id, b.block_type, b.display_name,
                  ${dataCol} AS data, ${metaCol} AS metadata,
                  b.sort_order, b.is_published,
                  false AS completed
           FROM active_tree b
           ORDER BY b.sort_order`;
    params = [courseId];
  }

  const result = await query<any>(sql, params);

  const blocks = result.rows;
  const root = blocks.find((b: any) => b.block_type === 'course') ?? null;



  return {
    root_id: root?.id ?? null,
    blocks,
  };
}

/**
 * Lấy chi tiết 1 block đơn lẻ.
 * Learner route → LUÔN trả published_data, bất kể role.
 */
export async function getBlockDetail(blockId: string, role = 'learner') {
  // Learner route: luôn chỉ trả published data
  const isLearner = true;
  // Learner: chỉ đọc published data (KHÔNG fallback draft)
  const dataCol = 'b.published_data';
  const metaCol = 'COALESCE(b.published_metadata, b.metadata)';

  const result = await query<any>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id, b.parent_id, b.block_type, b.display_name,
            ${dataCol} AS data, ${metaCol} AS metadata,
            b.sort_order, b.is_published
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     WHERE b.id = $1
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
    [blockId],
  );

  if (result.rowCount === 0) throw new AppError('Block không tồn tại', 404);
  return result.rows[0];
}

/**
 * Submit đáp án cho block (problem/crossword/sortable).
 * Server-side grading: so sánh đáp án user với đáp án đúng trong DB.
 */
export async function submitBlockAnswer(
  blockId: string,
  userId: string,
  role: string,
  body: any,
) {
  // Lấy block data — luôn dùng published data để grading (tránh learner exploit draft)
  const blockResult = await query<any>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id, b.block_type,
            COALESCE(b.published_data, b.data) AS data,
            COALESCE(b.published_metadata, b.metadata) AS metadata,
            b.course_id
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     WHERE b.id = $1
       AND b.is_published = true
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
    [blockId],
  );

  if (blockResult.rowCount === 0) throw new AppError('Block không tồn tại hoặc chưa được publish', 404);
  const block = blockResult.rows[0];

  switch (block.block_type) {
    case 'problem':
      return gradeProblem(block, body.answers || {});

    case 'la_crossword':
      return gradeCrossword(block, body.answers || {});

    case 'la_sortable':
      return gradeSortable(block, body.answer || []);

    default:
      return { status: 'ok', message: 'Block type không hỗ trợ submit', score: 0 };
  }
}

/** Grade problem block — parse OLX XML, support all 5 problem types */
function gradeProblem(block: any, userAnswers: Record<string, string | string[]>) {
  const data = typeof block.data === 'string' ? block.data : '';
  if (!data) return { status: 'error', message: 'Không có dữ liệu câu hỏi', correctness: {} };



  // ── 1. multiplechoiceresponse (single-select radio) ──
  if (data.includes('<multiplechoiceresponse') || (data.includes('<choicegroup') && !data.includes('<checkboxgroup'))) {
    return gradeMultipleChoice(data, userAnswers);
  }

  // ── 2. choiceresponse (multi-select checkbox) ──
  if (data.includes('<choiceresponse') || data.includes('<checkboxgroup')) {
    return gradeCheckbox(data, userAnswers);
  }

  // ── 3. optionresponse (dropdown) ──
  if (data.includes('<optionresponse')) {
    return gradeDropdown(data, userAnswers);
  }

  // ── 4. stringresponse (text input) ──
  if (data.includes('<stringresponse')) {
    return gradeStringInput(data, userAnswers);
  }

  // ── 5. numericalresponse (number input) ──
  if (data.includes('<numericalresponse')) {
    return gradeNumericalInput(data, userAnswers);
  }

  return { status: 'error', message: 'Loại câu hỏi chưa được hỗ trợ', correctness: {} };
}

/** 1. Single-select (radio) */
function gradeMultipleChoice(data: string, userAnswers: Record<string, string | string[]>) {
  const choiceMatches = [...data.matchAll(/<choice\s+correct="(true|false)"[^>]*>(.*?)<\/choice>/gi)];
  if (choiceMatches.length === 0) return { status: 'error', message: 'Không tìm thấy đáp án', correctness: {} };

  const correctIndices: string[] = [];
  const choiceTexts: Record<string, string> = {};
  choiceMatches.forEach((m, i) => {
    const id = `choice_${i}`;
    choiceTexts[id] = m[2];
    if (m[1] === 'true') correctIndices.push(id);
  });

  const userAnswer = Object.values(userAnswers)[0];
  const userStr = Array.isArray(userAnswer) ? userAnswer[0] : String(userAnswer || '');

  const isCorrect = correctIndices.includes(userStr) ||
    choiceMatches.some(m => m[1] === 'true' && m[2] === userStr);

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: correctIndices.map(id => choiceTexts[id]),
  };
}

/** 2. Multi-select (checkbox) */
function gradeCheckbox(data: string, userAnswers: Record<string, string | string[]>) {
  const choiceMatches = [...data.matchAll(/<choice\s+correct="(true|false)"[^>]*>(.*?)<\/choice>/gi)];
  if (choiceMatches.length === 0) return { status: 'error', message: 'Không tìm thấy đáp án', correctness: {} };

  const correctSet = new Set<string>();
  const choiceTexts: Record<string, string> = {};
  choiceMatches.forEach((m, i) => {
    const id = `choice_${i}`;
    choiceTexts[id] = m[2];
    if (m[1] === 'true') correctSet.add(id);
  });

  // FE sends { "olx_multi_0": ["choice_0", "choice_1", ...] }
  const userVal = Object.values(userAnswers)[0];
  const userSelected = new Set(Array.isArray(userVal) ? userVal : [String(userVal || '')]);

  // Check exact match
  const isCorrect = correctSet.size === userSelected.size &&
    [...correctSet].every(id => userSelected.has(id));

  const correctCount = [...correctSet].filter(id => userSelected.has(id)).length;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : `Đúng ${correctCount}/${correctSet.size} đáp án. Thử lại nhé!`,
    score: Math.round((correctCount / correctSet.size) * 100),
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [...correctSet].map(id => choiceTexts[id]),
  };
}

/** 3. Dropdown (optionresponse) */
function gradeDropdown(data: string, userAnswers: Record<string, string | string[]>) {
  const correctMatch = data.match(/<optioninput[^>]*\scorrect="([^"]+)"/i);
  let correctAnswer = correctMatch ? correctMatch[1] : '';

  if (!correctAnswer) {
    const optionMatches = [...data.matchAll(/<option\s+[^>]*correct="(true|false)"[^>]*>([\s\S]*?)<\/option>/gi)];
    const correctOption = optionMatches.find(m => m[1].toLowerCase() === 'true');
    correctAnswer = correctOption ? correctOption[2].replace(/<[^>]+>/g, '').trim() : '';
  }

  if (!correctAnswer) return { status: 'error', message: 'Không tìm thấy đáp án đúng', correctness: {} };

  const userVal = Object.values(userAnswers)[0];
  const userStr = Array.isArray(userVal) ? userVal[0] : String(userVal || '');

  // FE sends option text directly (id = text for dropdown)
  const isCorrect = userStr === correctAnswer;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [correctAnswer],
  };
}

/** 4. String input (stringresponse) */
function gradeStringInput(data: string, userAnswers: Record<string, string | string[]>) {
  // Parse correct answer and type from <stringresponse answer="..." type="ci|cs">
  const answerMatch = data.match(/<stringresponse\s+answer="([^"]+)"[^>]*/i);
  const correctAnswer = answerMatch ? answerMatch[1] : '';
  const isCaseInsensitive = data.includes('type="ci"');

  if (!correctAnswer) return { status: 'error', message: 'Không tìm thấy đáp án đúng', correctness: {} };

  const userVal = Object.values(userAnswers)[0];
  const userStr = Array.isArray(userVal) ? userVal[0] : String(userVal || '');

  const isCorrect = isCaseInsensitive
    ? userStr.toLowerCase().trim() === correctAnswer.toLowerCase().trim()
    : userStr.trim() === correctAnswer.trim();

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [correctAnswer],
  };
}

/** 5. Numerical input (numericalresponse) */
function gradeNumericalInput(data: string, userAnswers: Record<string, string | string[]>) {
  // Parse correct answer from <numericalresponse answer="...">
  const answerMatch = data.match(/<numericalresponse\s+answer="([^"]+)"/i);
  const correctAnswer = answerMatch ? parseFloat(answerMatch[1]) : NaN;

  // Parse tolerance from <responseparam type="tolerance" default="..."/>
  const tolMatch = data.match(/<responseparam\s+type="tolerance"\s+default="([^"]+)"/i);
  const tolerance = tolMatch ? parseFloat(tolMatch[1]) : 0;

  if (isNaN(correctAnswer)) return { status: 'error', message: 'Không tìm thấy đáp án đúng', correctness: {} };

  const userVal = Object.values(userAnswers)[0];
  const userNum = parseFloat(Array.isArray(userVal) ? userVal[0] : String(userVal || ''));

  const isCorrect = !isNaN(userNum) && Math.abs(userNum - correctAnswer) <= tolerance;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [String(correctAnswer)],
  };
}

/** Grade crossword block — so sánh từng word answer */
function gradeCrossword(block: any, userAnswers: Record<string, string>) {
  const meta = block.metadata || {};
  const cd = meta.crossword_data || {};
  const words: any[] = cd.words || [];

  if (words.length === 0) {
    return { status: 'error', message: 'Không có dữ liệu ô chữ', score: 0 };
  }

  let correct = 0;
  const results: Record<string, boolean> = {};

  for (const word of words) {
    const userAnswer = (userAnswers[String(word.id)] || '').toUpperCase().trim();
    const correctAnswer = (word.answer || '').toUpperCase().trim();
    const isCorrect = userAnswer === correctAnswer;
    results[String(word.id)] = isCorrect;
    if (isCorrect) correct++;
  }

  const score = Math.round((correct / words.length) * 100);

  return {
    status: correct === words.length ? 'correct' : 'incorrect',
    message: correct === words.length
      ? 'Hoàn thành ô chữ!'
      : `Đúng ${correct}/${words.length} từ`,
    score,
    results,
  };
}

/** Grade sortable block — check thứ tự */
function gradeSortable(block: any, userOrder: number[]) {
  const meta = block.metadata || {};
  const sd = meta.sortable_data || {};
  const items: any[] = sd.items || [];

  if (items.length === 0) {
    return { status: 'error', message: 'Không có dữ liệu sắp xếp', score: 0 };
  }

  // Correct order = thứ tự id trong items array (1,2,3,4,5)
  const correctOrder = items.map((item: any) => item.id);
  const isCorrect = JSON.stringify(userOrder) === JSON.stringify(correctOrder);

  // Count how many are in correct position
  let correctPositions = 0;
  for (let i = 0; i < Math.min(userOrder.length, correctOrder.length); i++) {
    if (userOrder[i] === correctOrder[i]) correctPositions++;
  }

  const score = Math.round((correctPositions / correctOrder.length) * 100);

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect
      ? 'Sắp xếp đúng thứ tự!'
      : `Đúng ${correctPositions}/${correctOrder.length} vị trí`,
    score,
    correct_order: correctOrder,
  };
}

// ── Course Files (tài liệu tham khảo) ──

/**
 * Lấy danh sách file/tài liệu đính kèm của course.
 * Learner chỉ thấy file chưa bị khóa (is_locked = false).
 */
export async function getCourseFiles(courseId: string, role = 'learner') {
  const lockedFilter = isLearnerRole(role) ? 'AND is_locked = false' : '';
  const result = await query<any>(
    `SELECT id, display_name, content_type, file_size, url, is_locked, is_reference, created_at
     FROM course_assets
     WHERE course_id = $1
       AND EXISTS (SELECT 1 FROM courses c WHERE c.id = course_assets.course_id AND c.deleted_at IS NULL)
       AND is_reference = true
       ${lockedFilter}
     ORDER BY created_at DESC`,
    [courseId],
  );

  return {
    files: result.rows.map((r: any) => {
      const ext = r.display_name?.split('.').pop()?.toLowerCase() || '';
      return {
        id: r.id,
        display_name: r.display_name,
        url: r.url,
        extension: ext,
        content_type: r.content_type,
        size: parseInt(r.file_size) || 0,
        date_added: r.created_at,
      };
    }),
    total: result.rowCount || 0,
  };
}

// ── Library (Kho tài liệu nội bộ, team-scoped) ──

/**
 * Lấy danh sách document categories mà learner được phép xem.
 * Learner: chỉ thấy categories assign qua team_doc_categories.
 * Staff/superuser/superadmin: thấy tất cả categories trong tenant.
 */
export async function getMyLibraryCategories(
  userId: string,
  tenantId: string,
  role: string,
) {
  let sql: string;
  let params: unknown[];

  if (isLearnerRole(role)) {
    sql = `SELECT dc.id, dc.name, dc.slug, dc.sort_order,
                  COUNT(d.id) FILTER (WHERE d.is_visible = true) AS count
           FROM document_categories dc
           JOIN team_doc_categories tdc ON tdc.category_id = dc.id
           JOIN team_members tm ON tm.team_id = tdc.team_id
           LEFT JOIN documents d ON d.category_id = dc.id AND d.is_visible = true
           WHERE dc.tenant_id = $1 AND tm.user_id = $2
           GROUP BY dc.id
           ORDER BY dc.sort_order, dc.name`;
    params = [tenantId, userId];
  } else {
    // staff/superuser/superadmin: thấy tất cả (kể cả ẩn)
    sql = `SELECT dc.id, dc.name, dc.slug, dc.sort_order,
                  COUNT(d.id) AS count
           FROM document_categories dc
           LEFT JOIN documents d ON d.category_id = dc.id
           WHERE dc.tenant_id = $1
           GROUP BY dc.id
           ORDER BY dc.sort_order, dc.name`;
    params = [tenantId];
  }

  const result = await query<any>(sql, params);

  return {
    categories: result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      slug: r.slug || '',
      count: parseInt(r.count) || 0,
    })),
    total: result.rowCount || 0,
  };
}

/**
 * Lấy documents mà learner được phép xem.
 * Learner: chỉ docs thuộc categories assign qua team_doc_categories + is_visible.
 * Staff+: tất cả docs visible trong tenant.
 */
export async function getMyLibraryDocuments(
  userId: string,
  tenantId: string,
  role: string,
  params: {
    page?: number;
    page_size?: number;
    category?: string;     // category slug or id
    extension?: string;
    search?: string;
    ordering?: string;
  },
) {
  const { page = 1, page_size = 20, category, extension, search, ordering } = params;
  const offset = (page - 1) * page_size;

  const sqlParams: unknown[] = [tenantId];
  const conditions: string[] = ['d.tenant_id = $1'];

  // Learner: chỉ thấy docs visible + restrict to team categories
  if (isLearnerRole(role)) {
    conditions.push('d.is_visible = true');
    sqlParams.push(userId);
    conditions.push(`d.category_id IN (
      SELECT tdc.category_id
      FROM team_doc_categories tdc
      JOIN team_members tm ON tm.team_id = tdc.team_id
      WHERE tm.user_id = $${sqlParams.length}
    )`);
  }

  // Filter by category (slug or id)
  if (category) {
    sqlParams.push(category);
    conditions.push(`(dc.slug = $${sqlParams.length} OR dc.id::text = $${sqlParams.length})`);
  }

  // Filter by extension
  if (extension) {
    sqlParams.push(extension);
    conditions.push(`d.extension = $${sqlParams.length}`);
  }

  // Search
  if (search) {
    sqlParams.push(`%${search}%`);
    conditions.push(`unaccent(d.title) ILIKE unaccent($${sqlParams.length})`);
  }

  const where = conditions.join(' AND ');

  // Ordering
  let orderBy = 'd.created_at DESC';
  if (ordering === 'title') orderBy = 'd.title ASC';
  else if (ordering === '-title') orderBy = 'd.title DESC';
  else if (ordering === 'created_at') orderBy = 'd.created_at ASC';
  else if (ordering === 'file_size') orderBy = 'd.file_size DESC';

  // Count
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM documents d
     LEFT JOIN document_categories dc ON dc.id = d.category_id
     WHERE ${where}`,
    sqlParams,
  );
  const total = parseInt(countResult.rows[0].count);

  // Fetch page
  sqlParams.push(page_size, offset);
  const result = await query<any>(
    `SELECT d.id, d.title, d.extension, d.file_size, d.file_url,
            d.created_at, d.is_visible,
            dc.name AS category_name, dc.slug AS category_slug,
            u.full_name AS uploaded_by_name
     FROM documents d
     LEFT JOIN document_categories dc ON dc.id = d.category_id
     LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
    sqlParams,
  );

  return {
    count: total,
    next: page * page_size < total ? `page=${page + 1}` : null,
    previous: page > 1 ? `page=${page - 1}` : null,
    results: result.rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      extension: r.extension || '',
      file_size: parseInt(r.file_size) || 0,
      category_name: r.category_name || '',
      category_slug: r.category_slug || '',
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
export async function selfEnroll(userId: string, courseId: string, tenantId: string) {
  // Kiểm tra course tồn tại trong tenant
  const course = await query<any>(
    'SELECT id FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
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

  const activeBlocks = await query<{ id: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id AS root_id, id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = ANY($2::uuid[])
       UNION ALL
       SELECT a.root_id, parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id
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
    [courseId, blockIds],
  );
  const activeBlockIds = activeBlocks.rows.map((row) => row.id);

  if (activeBlockIds.length === 0) {
    await recalculateProgress(enrollmentId, courseId);
    return { marked: 0 };
  }

  // Batch insert completions (ON CONFLICT skip)
  const values = activeBlockIds.map((_, i) => `($1, $${i + 2})`).join(', ');
  await query(
    `INSERT INTO block_completions (enrollment_id, block_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [enrollmentId, ...activeBlockIds],
  );

  // Tính lại progress: completed_leaves / total_leaves
  await recalculateProgress(enrollmentId, courseId);

  return { marked: activeBlockIds.length };
}

/**
 * Tính lại progress % dựa trên block completions.
 * Chỉ tính leaf blocks (video, html, problem, la_*).
 */
async function recalculateProgress(enrollmentId: string, courseId: string) {
  const result = await query<{ total: string; completed: string }>(
    `WITH RECURSIVE active_tree AS (
       SELECT b.id, b.parent_id, b.block_type
       FROM course_blocks b
       JOIN courses c ON c.id = b.course_id
       WHERE b.course_id = $2
         AND b.parent_id IS NULL
         AND b.is_published = true
         AND b.deleted_at IS NULL
         AND c.deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.is_published = true
         AND child.deleted_at IS NULL
     )
     SELECT
       COUNT(*) FILTER (WHERE b.block_type NOT IN ('course','chapter','sequential','vertical')) AS total,
       COUNT(*) FILTER (WHERE b.block_type NOT IN ('course','chapter','sequential','vertical') AND bc.id IS NOT NULL) AS completed
     FROM active_tree b
     LEFT JOIN block_completions bc ON bc.block_id = b.id AND bc.enrollment_id = $1
     `,
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

export async function getActiveBadges(tenantId: string) {
  const result = await query<any>(
    `SELECT b.id, b.name, b.description, b.image_key,
            tbs.card_image_url, tbs.icon_image_url
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     WHERE COALESCE(tbs.is_active, true) = true
     ORDER BY b.sort_order, b.id`,
    [tenantId]
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

// ══════════════════════════════════════════════════
// Course Modal Config + State (Welcome / Confirm / Complete)
// ══════════════════════════════════════════════════

/**
 * Lấy cấu hình modal (admin đã setup) cho course.
 * Trả defaults nếu chưa có config.
 */
export async function getCourseModalConfig(courseId: string) {
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
  await query(
    `INSERT INTO section_modal_shown (user_id, course_id, section_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, course_id, section_id) DO NOTHING`,
    [userId, courseId, sectionId],
  );
  return { success: true };
}
