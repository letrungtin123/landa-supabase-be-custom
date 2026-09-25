// Deterministic intent routing for the Lesson Author.
// This module deliberately has no database, model, or HTTP dependencies. The
// caller resolves the target and authorizes the operation after classification.

export type LessonAuthorIntentOperation =
  | 'answer'
  | 'course_blueprint'
  | 'create'
  | 'rename'
  | 'update_content'
  | 'delete'
  | 'move'
  | 'clarify';

export type LessonAuthorTargetType =
  | 'course'
  | 'chapter'
  | 'lesson'
  | 'unit'
  | 'component'
  | null;

export type LessonAuthorTitleStrategy = 'prefix_chapter_number';
export type LessonAuthorInputLocale = 'vi' | 'en' | 'mixed' | 'unknown';

// Source documents often put a non-semantic slide/page range after a TOC
// title. Keep this matcher deliberately narrow and anchored to the end so
// legitimate parenthetical content in a title is preserved.
const SOURCE_RANGE_SUFFIX_RE = /\s*\(\s*(?:(?:từ|tu|from)\s+)?(?:slides?|trang|pages?)\s+\d{1,4}\s*(?:(?:đến|den|to)\s+(?:(?:slides?|trang|pages?)\s+)?\d{1,4}|[-–—]\s*(?:(?:slides?|trang|pages?)\s+)?\d{1,4})\s*\)\s*$/iu;

export interface LessonAuthorIntentMention {
  block_id?: string;
  block_type?: string;
  display_name?: string;
}

export interface LessonAuthorIntentPlan {
  version: 1;
  operation: LessonAuthorIntentOperation;
  target_type: LessonAuthorTargetType;
  /** Whether the resolved target already exists or represents a guarded new node. */
  target_resolution?: 'existing' | 'new' | null;
  target_block_id?: string | null;
  target_path?: string | null;
  target_number_path?: string | null;
  target_display_name?: string | null;
  target_updated_at?: string | null;
  requested_title?: string | null;
  title_strategy?: LessonAuthorTitleStrategy | null;
  destination_block_id?: string | null;
  fields: Array<'title' | 'content' | 'components' | 'sort_order'>;
  confidence: number;
  requires_confirmation: boolean;
  target_source: 'mention' | 'editor_context' | 'explicit_reference' | 'conversation_context' | 'none';
  signals: string[];
  ambiguity_reasons: string[];
}

const TITLE_WORDS = /(^|\b)(doi ten|doi lai ten|sua ten|chinh sua ten|cap nhat ten|tieu de|ten cua|rename|retitle|title)(\b|$)/i;
const TITLE_FORMAT_WORDS = /(^|\b)(format|dinh dang|danh so|them tien to|tien to|dong bo|giong tieu de|giong format|theo mau|prefix|numbered|numbering|same format)(\b|$)/i;
const CONTENT_WORDS = /(^|\b)(noi dung|phan noi dung|viet lai|viet them|bo sung|cap nhat noi dung|sua noi dung|chinh sua noi dung|soan|draft|rewrite|content|component|html|quiz|faq|diagram|mindmap|so do|bai tap|muc tieu|objective)(\b|$)/i;
const EDIT_WORDS = /(^|\b)(sua|chinh sua|cap nhat|edit|update|improve|rewrite|revise|refine|toi uu|cai thien|lam lai|mo rong)(\b|$)/i;
const CREATE_WORDS = /(^|\b)(tao|them|bo sung|add|insert|create|generate|build|design|draft|soan|viet|xay dung|lap)(\b|$)/i;
const DELETE_WORDS = /(^|\b)(xoa|xóa|delete|remove|bo di|bỏ đi|go bo|loai bo|huy bo)(\b|$)/i;
const MOVE_WORDS = /(^|\b)(di chuyen|chuyen sang|sap xep|doi thu tu|dat len truoc|dat xuong sau|move|reorder|sort)(\b|$)/i;
const QUESTION_WORDS = /(^|\b)(la gi|giai thich|tom tat|cho biet|phan tich|tai sao|vi sao|nhu the nao|the nao|what is|explain|summarize|why|how)(\b|$)/i;
const COURSE_BLUEPRINT_WORDS = /(^|\b)(toan bo khoa hoc|toan khoa|ca khoa hoc|course blueprint|curriculum|chuong trinh dao tao|ban thiet ke khoa hoc|khung khoa hoc|thiet ke mot khoa hoc|xay dung mot khoa hoc|entire course|whole course|full course|complete course)(\b|$)/i;
const COURSE_SCOPE_WORDS = /(^|\b)(khoa hoc|course|chuong trinh|curriculum)(\b|$)/i;
const DETAILED_COURSE_AUTHORING_WORDS = /(^|\b)(chi tiet|chuyen sau|day du|hoan chinh|detailed|in[-\s]?depth|comprehensive)(\b|$)/i;
// Explicitly creating a course (or its course-level content) is enough to
// request a review-only Blueprint. Depth adjectives improve the request but
// are not routing authority. Keep this phrase-level matcher narrower than the
// generic CREATE/CONTENT signals so "create a quiz for this course" still
// requires a concrete lesson target.
const EXPLICIT_COURSE_CREATION_WORDS = /(?:^|\b)(?:(?:tao|soan|xay dung|thiet ke|lap|viet)\s+(?:(?:noi dung|chuong trinh)\s+)?(?:cho\s+)?(?:mot\s+)?(?:khoa hoc|chuong trinh)|(?:create|build|design|draft|generate|write)\s+(?:(?:the|this|a)\s+)?(?:course(?:\s+content)?|content\s+for\s+(?:(?:the|this|a)\s+)?course))(?:\b|$)/i;
const COMPOUND_CONNECTOR_WORDS = /(^|\b)(va|and|dong thoi|at the same time|sau do|then|also)(\b|$)/i;
const NEGATED_DELETE_WORDS = /(^|\b)(khong|dung|do not|dont|without)\s+(?:can|duoc|the)?\s*(xoa|delete|remove|bo di|go bo|loai bo)(\b|$)/i;
const NEGATED_CREATE_WORDS = /(^|\b)(khong|dung|do not|dont|without)\s+(?:can|duoc|the)?\s*(tao|them|add|insert|create|generate|build)(\b|$)/i;
const VIETNAMESE_HINTS = /(^|\b)(chuong|muc|bai hoc|bai|noi dung|tieu de|doi ten|sua|chinh sua|tao|them|xoa|di chuyen|khoa hoc|hay|cho|va)(\b|$)/i;
const ENGLISH_HINTS = /(^|\b)(chapter|section|lesson|unit|content|title|rename|edit|update|create|add|delete|remove|move|course|please|the|and)(\b|$)/i;
// Do not use the `i` flag here. Unicode case folding makes an ASCII `e`
// match Vietnamese `ê`, which would classify ordinary English as mixed.
const VIETNAMESE_DIACRITIC_RE = /[ĂÂĐÊÔƠƯăâđêôơưÀ-Ỹà-ỹ]/u;
const ENGLISH_OUTPUT_LANGUAGE_WORDS = /(^|\b)(in english|english only|english version|write in english|reply in english|respond in english|bang tieng anh|tieng anh)(\b|$)/i;
const VIETNAMESE_OUTPUT_LANGUAGE_WORDS = /(^|\b)(in vietnamese|vietnamese only|vietnamese version|write in vietnamese|reply in vietnamese|respond in vietnamese|bang tieng viet|tieng viet)(\b|$)/i;

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectLessonAuthorInputLocale(value: string): LessonAuthorInputLocale {
  const raw = String(value ?? '').trim();
  if (!raw) return 'unknown';
  const folded = fold(raw);
  const hasVietnamese = VIETNAMESE_DIACRITIC_RE.test(raw) || VIETNAMESE_HINTS.test(folded);
  const hasEnglish = ENGLISH_HINTS.test(folded);
  if (hasVietnamese && hasEnglish) return 'mixed';
  if (hasVietnamese) return 'vi';
  if (hasEnglish) return 'en';
  return 'unknown';
}

/**
 * Generated course content follows an explicit language instruction first,
 * then the language of the current message. The dashboard locale only affects
 * user-interface chrome and remains a fallback for genuinely mixed input.
 */
export function resolveLessonAuthorOutputLocale(
  value: string,
  fallback: 'vi' | 'en' = 'vi',
): 'vi' | 'en' {
  const folded = fold(String(value ?? ''));
  const explicitlyEnglish = ENGLISH_OUTPUT_LANGUAGE_WORDS.test(folded);
  const explicitlyVietnamese = VIETNAMESE_OUTPUT_LANGUAGE_WORDS.test(folded);
  if (explicitlyEnglish !== explicitlyVietnamese) return explicitlyEnglish ? 'en' : 'vi';

  const inputLocale = detectLessonAuthorInputLocale(value);
  return inputLocale === 'en' || inputLocale === 'vi' ? inputLocale : fallback;
}

/** Approved Blueprint locale is stable across UI/draft-button language changes.
 * Explicit output requests keep existing precedence; legacy records fall back
 * to the unchanged message/UI resolver. Locked titles are never translated. */
export function resolveLessonAuthorDraftLocale(
  value: string,
  fallback: 'vi' | 'en',
  approvedLocale?: unknown,
): 'vi' | 'en' {
  const folded = fold(String(value ?? ''));
  const english = ENGLISH_OUTPUT_LANGUAGE_WORDS.test(folded);
  const vietnamese = VIETNAMESE_OUTPUT_LANGUAGE_WORDS.test(folded);
  if (english !== vietnamese) return english ? 'en' : 'vi';
  if (approvedLocale === 'vi' || approvedLocale === 'en') return approvedLocale;
  return resolveLessonAuthorOutputLocale(value, fallback);
}

function hasTargetReference(text: string): boolean {
  return /(^|\b)(khoa hoc|course|curriculum|chuong trinh|chuong|chapter|bai hoc|bai|lesson|muc|section|unit|module|component|block|outline|cau truc|phan nay|noi dung nay|muc nay|bai nay|chuong nay|this section|this lesson|this unit)(\s*\d+(?:\.\d+){0,2})?(\b|$)/i.test(text);
}

function targetTypeFromMention(mention?: LessonAuthorIntentMention | null): LessonAuthorTargetType {
  const type = fold(mention?.block_type ?? '');
  if (type === 'chapter') return 'chapter';
  if (type === 'sequential' || type === 'section' || type === 'module') return 'lesson';
  if (type === 'vertical' || type === 'unit' || type === 'subsection') return 'unit';
  if (type && type !== 'course') return 'component';
  if (type === 'course') return 'course';
  return null;
}

function hasActiveSignal(pattern: RegExp, text: string, negatedPattern?: RegExp): boolean {
  return pattern.test(text) && !(negatedPattern?.test(text) ?? false);
}

/**
 * Returns true only for an explicit request to draft/create a new chapter.
 * Existing-node edit language deliberately takes precedence so a missing
 * target never turns a typo in an edit request into a new chapter.
 */
export function isLessonAuthorNewChapterDraftRequest(value: string): boolean {
  const text = fold(String(value ?? ''));
  const hasChapterReference = /(^|\b)(chuong|chapter)(\s*\d+)?(\b|$)/i.test(text);
  if (!hasChapterReference) return false;

  const hasDraftVerb = /(^|\b)(soan|draft|tao|create|generate|build|viet|xay dung|lap)(\b|$)/i.test(text);
  if (!hasDraftVerb) return false;

  const hasExistingNodeMutation = /(^|\b)(sua|chinh sua|cap nhat|edit|update|improve|rewrite|revise|refine|toi uu|cai thien|lam lai|viet lai|doi ten|rename|retitle|xoa|delete|remove|di chuyen|move|reorder)(\b|$)/i.test(text);
  return !hasExistingNodeMutation;
}

export function extractLessonAuthorTargetNumberPath(
  value: string,
  targetType: LessonAuthorTargetType,
): string | null {
  const text = fold(String(value ?? ''));
  const patterns: Array<{ type: NonNullable<LessonAuthorTargetType>; pattern: RegExp }> = [
    { type: 'unit', pattern: /(?:bai hoc|lesson|unit|vertical)\s*(?:so\s*)?(\d+\.\d+\.\d+)/i },
    { type: 'lesson', pattern: /(?:muc|bai|section|module|sequential|lesson)\s*(?:so\s*)?(\d+\.\d+)(?!\.)/i },
    { type: 'chapter', pattern: /(?:chuong|chapter)\s*(?:so\s*)?(\d+)/i },
  ];
  for (const item of patterns) {
    if (targetType && targetType !== item.type) continue;
    const match = text.match(item.pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Allows a deliberate manual draft command to reuse the current Blueprint
 * without treating a vague chapter request as an approved-source draft.
 */
export function matchesLessonAuthorBlueprintChapterDraft(
  value: string,
  chapterIndex: number,
  chapterTitle: string,
): boolean {
  if (!isLessonAuthorNewChapterDraftRequest(value)) return false;
  const requestedChapter = extractLessonAuthorTargetNumberPath(value, 'chapter');
  if (!requestedChapter || Number(requestedChapter) !== chapterIndex + 1) return false;

  const titleKey = fold(chapterTitle).replace(/[^a-z0-9]+/g, ' ').trim();
  const requestKey = fold(value).replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(titleKey && requestKey.includes(titleKey));
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

export function classifyLessonAuthorIntent(input: {
  message: string;
  mode?: 'chat' | 'course_blueprint' | 'draft_lesson' | 'auto';
  mention?: LessonAuthorIntentMention | null;
  carriedTarget?: boolean;
  mentionSource?: 'current' | 'editor_context' | 'carried_forward';
}): LessonAuthorIntentPlan {
  const text = fold(input.message);
  const mentionTarget = targetTypeFromMention(input.mention);
  const hasMention = Boolean(input.mention?.block_id);
  const hasExplicitTarget = hasTargetReference(text);
  const targetType = mentionTarget ?? (hasExplicitTarget ? inferTargetType(text) : null);
  const hasSpecificOutlineTarget = Boolean(targetType && targetType !== 'course');
  const targetSource = hasMention
    ? input.mentionSource === 'carried_forward'
      ? 'conversation_context'
      : input.mentionSource === 'editor_context'
        ? 'editor_context'
        : 'mention'
    : hasExplicitTarget
      ? 'explicit_reference'
      : input.carriedTarget
        ? 'conversation_context'
        : 'none';
  const signals: string[] = [];
  const ambiguityReasons: string[] = [];

  if (input.mode === 'chat') {
    return makePlan('answer', null, [], 1, false, 'none', ['forced_chat'], []);
  }
  if (
    (input.mode === 'course_blueprint' || input.mode === 'draft_lesson')
    && hasActiveSignal(DELETE_WORDS, text, NEGATED_DELETE_WORDS)
  ) {
    return makePlan(
      'clarify',
      targetType,
      [],
      0.99,
      false,
      targetSource,
      ['delete_verb', 'forced_mode_safety_stop'],
      ['Không thể thực hiện yêu cầu xóa trong mode tạo nội dung. Hãy gửi lại yêu cầu xóa với đúng node được chọn.'],
    );
  }
  if (input.mode === 'course_blueprint') {
    return makePlan('course_blueprint', 'course', [], 1, false, 'none', ['forced_course_blueprint'], []);
  }
  if (input.mode === 'draft_lesson') {
    return makePlan(
      'update_content',
      targetType ?? 'chapter',
      ['content', 'components'],
      targetType || hasMention ? 0.92 : 0.62,
      false,
      targetSource,
      ['forced_draft_lesson'],
      targetType || hasMention ? [] : ['Chưa xác định được phạm vi cần soạn.'],
    );
  }

  const isDelete = hasActiveSignal(DELETE_WORDS, text, NEGATED_DELETE_WORDS);
  const isMove = MOVE_WORDS.test(text);
  const isTitleEdit = TITLE_WORDS.test(text);
  const isContentEdit = CONTENT_WORDS.test(text);
  const isEdit = EDIT_WORDS.test(text);
  const isCreate = hasActiveSignal(CREATE_WORDS, text, NEGATED_CREATE_WORDS);
  const isQuestion = text.endsWith('?') || QUESTION_WORDS.test(text);
  // A whole-course authoring request remains review-only: it produces a
  // Blueprint and never mutates the outline before the admin applies it.
  // Requiring the literal phrase "entire course" made the natural request
  // "create detailed content for this course" fail when the outline was empty.
  const isBlueprint = COURSE_BLUEPRINT_WORDS.test(text);
  const isDetailedCourseAuthoringRequest = isCreate
    && isContentEdit
    && targetType === 'course'
    && COURSE_SCOPE_WORDS.test(text)
    && DETAILED_COURSE_AUTHORING_WORDS.test(text)
    && !hasSpecificOutlineTarget
    && !hasMention;
  const isExplicitCourseCreationRequest = EXPLICIT_COURSE_CREATION_WORDS.test(text)
    && targetType === 'course'
    && COURSE_SCOPE_WORDS.test(text)
    && !hasSpecificOutlineTarget
    && !hasMention;
  const isCourseWideBlueprintRequest = (isBlueprint || isDetailedCourseAuthoringRequest || isExplicitCourseCreationRequest)
    && isCreate
    && !isEdit
    && !isTitleEdit
    && !isDelete
    && !isMove
    && !hasSpecificOutlineTarget
    && !hasMention;

  // A drafting command can contain an ordinary topic list joined by "và" /
  // "and". Treat that as one operation, but do not bypass compound-mutation
  // protection when the user names more than one chapter.
  const chapterReferenceCount = [...text.matchAll(/(^|\b)(chuong|chapter)\s*(?:so\s*)?\d+/gi)].length;
  const isSingleNewChapterDraftCommand = isLessonAuthorNewChapterDraftRequest(input.message)
    && targetType === 'chapter'
    && chapterReferenceCount === 1;

  // "Create detailed and in-depth content" is one authoring request, not two
  // mutations just because it contains both a creation and a content signal.
  const isSingleCreateContentRequest = isCreate
    && isContentEdit
    && !isEdit
    && !isTitleEdit
    && !isDelete
    && !isMove
    && chapterReferenceCount <= 1;
  const mutationSignals = [
    isDelete,
    isMove,
    isTitleEdit,
    (isEdit || isContentEdit) && !isSingleCreateContentRequest,
    isCreate,
  ]
    .filter(Boolean).length;
  const hasCompoundMutation = !isCourseWideBlueprintRequest
    && !isSingleNewChapterDraftCommand
    && COMPOUND_CONNECTOR_WORDS.test(text)
    && mutationSignals > 1;

  if (hasCompoundMutation) {
    return makePlan(
      'clarify',
      targetType,
      [],
      0.2,
      false,
      targetSource,
      ['compound_mutation_request'],
      ['Yêu cầu chứa nhiều thao tác thay đổi. Hãy gửi từng thao tác riêng để tránh áp dụng sai phạm vi.'],
    );
  }

  if (isDelete) {
    signals.push('delete_verb');
    if (!targetType && !hasMention) {
      ambiguityReasons.push('Yêu cầu xóa chưa chỉ rõ Chương/Mục/Bài học/component.');
      return makePlan('clarify', null, [], 0.35, false, 'none', signals, ambiguityReasons);
    }
    return makePlan('delete', targetType, ['content', 'components'], 0.98, true, targetSource, signals, []);
  }

  if (isMove) {
    signals.push('move_verb');
    if (!targetType && !hasMention) {
      ambiguityReasons.push('Yêu cầu di chuyển chưa chỉ rõ node trong cây outline.');
      return makePlan('clarify', null, [], 0.35, false, 'none', signals, ambiguityReasons);
    }
    return makePlan('move', targetType, ['sort_order'], 0.94, true, targetSource, signals, []);
  }

  // Whole-course creation must be routed to the review-only blueprint branch
  // before the generic "content" signal can classify it as a node update.
  if (isCourseWideBlueprintRequest) {
    return makePlan(
      'course_blueprint',
      'course',
      [],
      0.96,
      false,
      'none',
      ['create_verb', 'course_scope', ...(isExplicitCourseCreationRequest ? ['explicit_course_create'] : [])],
      [],
    );
  }

  if (isTitleEdit) {
    signals.push('title_edit_signal');
    if (isContentEdit) signals.push('content_context_signal');
    if (!targetType && !hasMention) {
      ambiguityReasons.push('Chưa xác định được Chương/Mục/Bài học cần đổi tiêu đề.');
      return makePlan('clarify', null, ['title'], 0.48, false, 'none', signals, ambiguityReasons);
    }
    const requestedTitle = extractRequestedTitle(input.message);
    const titleStrategy = !requestedTitle
      && !isContentEdit
      && targetType === 'chapter'
      && TITLE_FORMAT_WORDS.test(text)
      ? 'prefix_chapter_number' as const
      : null;
    if (titleStrategy) {
      signals.push('title_format_signal');
      return makePlan('rename', targetType, ['title'], 0.96, false, targetSource, signals, [], null, titleStrategy);
    }
    if (!requestedTitle) {
      ambiguityReasons.push('Chưa có tên tiêu đề mới cần áp dụng.');
      return makePlan('clarify', targetType, ['title'], 0.62, false, targetSource, signals, ambiguityReasons);
    }
    return makePlan('rename', targetType, ['title'], isContentEdit ? 0.76 : 0.98, false, targetSource, signals, [], requestedTitle);
  }

  if (isEdit || isContentEdit) {
    signals.push(isEdit ? 'edit_verb' : 'content_signal');
    if (isContentEdit) signals.push('content_field_signal');
    if (isQuestion && !isEdit && !isCreate) {
      return makePlan('answer', null, [], 0.92, false, 'none', ['question_or_read_request'], []);
    }
    if (targetType === 'course') {
      ambiguityReasons.push('Chưa xác định Chương, Mục hoặc Bài học cụ thể để cập nhật nội dung.');
      return makePlan('clarify', 'course', ['content', 'components'], 0.42, false, targetSource, signals, ambiguityReasons);
    }
    if (!targetType && !hasMention) {
      ambiguityReasons.push('Chưa xác định được phạm vi Chương/Mục/Bài học cần chỉnh sửa.');
      return makePlan('clarify', null, ['content', 'components'], 0.42, false, 'none', signals, ambiguityReasons);
    }
    return makePlan('update_content', targetType, ['content', 'components'], isContentEdit ? 0.96 : 0.9, false, targetSource, signals, []);
  }

  if (isCreate) {
    signals.push('create_verb');
    if (isBlueprint) {
      return makePlan('course_blueprint', 'course', [], 0.96, false, targetSource, [...signals, 'course_scope'], []);
    }
    if (targetType === 'course') {
      ambiguityReasons.push('Chưa xác định Chương, Mục hoặc Bài học cụ thể để thêm nội dung.');
      return makePlan('clarify', 'course', ['content', 'components'], 0.42, false, targetSource, signals, ambiguityReasons);
    }
    if (!targetType && !hasMention) {
      ambiguityReasons.push('Chưa xác định vị trí cần thêm nội dung.');
      return makePlan('clarify', null, ['content', 'components'], 0.45, false, 'none', signals, ambiguityReasons);
    }
    return makePlan('create', targetType, ['content', 'components'], 0.93, false, targetSource, signals, []);
  }

  if (isBlueprint) {
    return makePlan('course_blueprint', 'course', [], 0.93, false, targetSource, ['course_blueprint_signal'], []);
  }

  if (isQuestion || !text) {
    return makePlan('answer', null, [], 0.92, false, 'none', ['question_or_read_request'], []);
  }

  return makePlan('answer', null, [], 0.72, false, 'none', ['no_mutation_signal'], []);
}

function inferTargetType(text: string): LessonAuthorTargetType {
  if (/(^|\b)(component|block|html|quiz|faq|diagram|mindmap|so do|bai tap)(\b|$)/i.test(text)) return 'component';
  // Internal names remain lesson=sequential (Mục) and unit=vertical
  // (Bài học). Keep the user-facing aliases aligned with the outline UI.
  if (/(^|\b)(bai hoc|unit|vertical)(\b|$)/i.test(text)) return 'unit';
  // "Bài 3.1" is a legacy label used by older proposals for the two-level
  // sequential node. Keep it compatible while reserving "Bài học" for the
  // three-level vertical node shown by the current outline UI.
  if (/(^|\b)bai\s*(?:so\s*)?\d+\.\d+(?!\.)(?:\b|$)/i.test(text)) return 'lesson';
  if (/(^|\b)lesson\s*(?:so\s*)?\d+\.\d+(?!\.)(?:\b|$)/i.test(text)) return 'lesson';
  if (/(^|\b)(lesson)(\b|$)/i.test(text)) return 'unit';
  if (/(^|\b)(muc|section|module|sequential)(\b|$)/i.test(text)) return 'lesson';
  if (/(^|\b)(chuong|chapter)(\b|$)/i.test(text)) return 'chapter';
  if (/(^|\b)(khoa hoc|course|curriculum)(\b|$)/i.test(text)) return 'course';
  return null;
}

export function extractRequestedTitle(text: string): string | null {
  const source = text.trim();
  const match = [
    /(?:thành|thanh|\bto\b|\bas\b)\s*["“']?(.+?)["”']?\s*$/iu,
    /(?:đặt|dat)\s+(?:tên|ten)(?:\s+mới|\s+moi)?(?:\s+(?:cho|for))?.*?(?:(?:là|la|is)\s*:?\s*|:)\s*["“']?(.+?)["”']?\s*$/iu,
    /(?:tiêu\s+đề|tieu\s+de).*?(?:[:=]\s*)["“']?(.+?)["”']?\s*$/iu,
    /(?:\b(?:new\s+)?title)\s*(?:is|to|:)\s*["“']?(.+?)["”']?\s*$/iu,
  ].map(pattern => source.match(pattern)).find(Boolean);
  const candidate = match?.[1]?.trim().replace(/[.!?]+$/, '').trim();
  if (!candidate) return null;
  const normalizedCandidate = stripLessonAuthorStructuralPrefix(
    stripLessonAuthorSourceRangeSuffix(candidate),
  );
  if (normalizedCandidate.length < 2 || normalizedCandidate.length > 180) return null;
  if (/^(la gi|gi|sao|the nao|what is|why|how)$/i.test(fold(normalizedCandidate))) return null;
  return normalizedCandidate || null;
}

export function stripLessonAuthorSourceRangeSuffix(value: string): string {
  let title = value.replace(/\s+/g, ' ').trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = title.replace(SOURCE_RANGE_SUFFIX_RE, '').trim();
    if (next === title) break;
    if (!next) return '';
    title = next;
  }
  return title;
}

export function stripLessonAuthorStructuralPrefix(value: string): string {
  let title = value.replace(/\s+/g, ' ').trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = title.replace(
      /^(?:chương|chuong|chapter|phần|phan|part|mục|muc|section|module|sequential|bài học|bai hoc|bài|bai|lesson|unit|vertical)\s+\d+(?:\.\d+){0,2}(?:\s*[:.)-]\s*|\s+)/iu,
      '',
    ).trim();
    if (!next || next === title) break;
    title = next;
  }
  return title;
}

export function formatChapterTitle(currentTitle: string, chapterNumber: string): string | null {
  const normalizedNumber = chapterNumber.trim();
  if (!/^\d+$/.test(normalizedNumber)) return null;

  const title = stripLessonAuthorSourceRangeSuffix(currentTitle)
    .trim()
    .replace(/^(?:chương|chuong|chapter)\s+\d+\s*[:.)-]\s*/iu, '')
    .trim();
  if (!title) return null;

  const formatted = `Chương ${normalizedNumber}: ${title}`;
  return formatted.length <= 180 ? formatted : null;
}

function makePlan(
  operation: LessonAuthorIntentOperation,
  targetType: LessonAuthorTargetType,
  fields: Array<'title' | 'content' | 'components' | 'sort_order'>,
  confidence: number,
  requiresConfirmation: boolean,
  targetSource: LessonAuthorIntentPlan['target_source'],
  signals: string[],
  ambiguityReasons: string[],
  requestedTitle: string | null = null,
  titleStrategy: LessonAuthorTitleStrategy | null = null,
): LessonAuthorIntentPlan {
  return {
    version: 1,
    operation,
    target_type: targetType,
    requested_title: requestedTitle,
    title_strategy: titleStrategy,
    fields,
    confidence: clampConfidence(confidence),
    requires_confirmation: requiresConfirmation,
    target_source: targetSource,
    signals,
    ambiguity_reasons: ambiguityReasons,
  };
}
