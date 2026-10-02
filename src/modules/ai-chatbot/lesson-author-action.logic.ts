/** Button commands are routing authority, never authorization. Legacy callers
 * without an action keep the old contract. No provider or persistence here. */
export type LessonAuthorAction = 'GENERATE_COURSE_BLUEPRINT' | 'DRAFT_BLUEPRINT_CHAPTER' | 'CONTINUE_CHAPTER';
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function resolveLessonAuthorAction(body: Record<string, unknown>, target: string): {
  action: LessonAuthorAction; mode: 'course_blueprint' | 'draft_lesson'; content: string;
} | null {
  if (body.lesson_author_action === undefined) return null;
  const fail = (): never => { throw new Error('LESSON_AUTHOR_ACTION_INVALID'); };
  if (target !== 'lesson_author' || body.input_mode === 'voice'
    || (body.outline_mentions !== undefined && (!Array.isArray(body.outline_mentions) || body.outline_mentions.length > 0))) return fail();
  const action = body.lesson_author_action;
  const en = body.locale === 'en';
  if (action === 'GENERATE_COURSE_BLUEPRINT') {
    const sources = body.source_documents;
    if (!Array.isArray(sources) || sources.length !== 1 || !uuid(sources[0]?.document_id)
      || body.blueprint_id !== undefined || body.blueprint_chapter_index !== undefined || body.chapter_resume !== undefined) return fail();
    if (body.mode !== undefined && body.mode !== 'course_blueprint') return fail();
    return { action, mode: 'course_blueprint' as const,
      content: en ? 'Create learning content from the selected source document.' : 'Tạo nội dung bài học từ tài liệu đã chọn.' };
  }
  if (action === 'DRAFT_BLUEPRINT_CHAPTER') {
    if (!uuid(body.blueprint_id) || !Number.isInteger(body.blueprint_chapter_index)
      || Number(body.blueprint_chapter_index) < 0 || Number(body.blueprint_chapter_index) >= 12
      || body.chapter_resume !== undefined) return fail();
    if (body.mode !== undefined && body.mode !== 'draft_lesson') return fail();
    return { action, mode: 'draft_lesson' as const, content: en
      ? `Draft Chapter ${Number(body.blueprint_chapter_index) + 1} from the approved blueprint.`
      : `Soạn Chương ${Number(body.blueprint_chapter_index) + 1} theo bản thiết kế đã duyệt.` };
  }
  if (action === 'CONTINUE_CHAPTER') {
    const resume = body.chapter_resume;
    if (!resume || typeof resume !== 'object' || Array.isArray(resume)
      || Object.keys(resume).sort().join(',') !== 'draft_id,previous_attempt_id'
      || !uuid((resume as Record<string, unknown>).draft_id) || !uuid((resume as Record<string, unknown>).previous_attempt_id)
      || body.blueprint_id !== undefined || body.blueprint_chapter_index !== undefined) return fail();
    if (body.mode !== undefined && body.mode !== 'draft_lesson') return fail();
    return { action, mode: 'draft_lesson' as const,
      content: en ? 'Continue completing the chapter.' : 'Tiếp tục hoàn thành chương.' };
  }
  return fail();
}
