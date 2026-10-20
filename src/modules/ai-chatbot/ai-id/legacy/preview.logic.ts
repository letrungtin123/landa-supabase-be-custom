// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { assessmentGapMessage, ComponentCapabilityError } from '../content/lesson-author-capabilities.logic.js';
import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import {
  type LessonAuthorChapterProposal,
  type LessonAuthorComponentType,
  type LessonAuthorLessonProposal,
  type LessonAuthorOperationPlan,
  type LessonAuthorProposal,
  type LessonAuthorUnitProposal,
} from '../../../course-authoring/course-authoring.service.js';
import { RagServiceError } from '../../ai-platform/ai-rag-client.service.js';
import {
  formatLessonAuthorBlueprintReadyMessage,
  formatLessonAuthorProposalReadyMessage,
  formatBlueprintProviderTimeout,
} from '../v1/lesson-author-message.logic.js';
import { redactGeminiApiKeys, sanitizeGeminiError, isValidUUID } from '../../chat/chat-turn-runtime.service.js';
import { componentTypeLabel } from './component-normalize.logic.js';
import type { LessonAuthorOutlineMention, LessonAuthorBlueprint, LessonAuthorBlueprintQualityReport } from './types.js';
import { foldVietnameseText } from './context.service.js';
import { canonicalTargetSnapshot } from './targets.service.js';

function getRequestedComponentTypes(userPrompt: string): LessonAuthorComponentType[] {
  const folded = foldVietnameseText(userPrompt);
  const types: LessonAuthorComponentType[] = [];
  const add = (type: LessonAuthorComponentType) => {
    if (!types.includes(type)) types.push(type);
  };

  const asksSortable = /(^|\b)(sortable|sap xep|ordering|sequence|thu tu)(\b|$)/i.test(folded);
  if (/(^|\b)(diagram|flowchart|mindmap|so do|bieu do)(\b|$)/i.test(folded)) add('la_diagram');
  if (/(^|\b)(faq|hoi dap|cau hoi thuong gap)(\b|$)/i.test(folded)) add('la_faq');
  if (/(^|\b)(crossword|do vui o chu|tu dien|vocabulary)(\b|$)/i.test(folded)
    || (/(^|\b)o chu(\b|$)/i.test(folded) && !asksSortable)) add('la_crossword');
  if (asksSortable) add('la_sortable');
  if (/(^|\b)(quiz|problem|cau hoi|kiem tra|multiple choice|trac nghiem|dropdown|optionresponse|numerical|numericalresponse|dien so|stringresponse|short answer|short_text|dien van ban)(\b|$)/i.test(folded)) add('problem');
  if (/(^|\b)(html|text|van ban|ly thuyet|noi dung doc)(\b|$)/i.test(folded)) add('html');
  return types;
}

function isAdditiveComponentOnlyRequest(userPrompt: string, outlineMentions: LessonAuthorOutlineMention[]): boolean {
  if (outlineMentions.length === 0) return false;
  const folded = foldVietnameseText(userPrompt);
  const hasAddVerb = /(^|\b)(tao|them|add|insert|create|generate|build|bo sung|viet|soan)(\b|$)/i.test(folded);
  const hasReplaceVerb = /(^|\b)(xoa|remove|delete|thay the|replace|sua|chinh sua|cap nhat|update|edit|viet lai|lam lai)(\b|$)/i.test(folded);
  const hasComponentScope = /(^|\b)(component|block|unit nay|phan nay|muc nay|diagram|so do|bieu do|faq|crossword|sortable|quiz|problem|dropdown|optionresponse|numerical|numericalresponse|dien so|stringresponse|short answer|short_text|dien van ban|html)(\b|$)/i.test(folded);
  return hasAddVerb && !hasReplaceVerb && hasComponentScope && getRequestedComponentTypes(userPrompt).length > 0;
}

function requestedComponentLimit(userPrompt: string): number | null {
  const folded = foldVietnameseText(userPrompt);
  return /(^|\b)(1|mot|one|single)(\b|$)/i.test(folded) ? 1 : null;
}

function humanizeLessonAuthorPlanText(value: string, locale: 'vi' | 'en' = 'vi'): string {
  const raw = value.trim();
  if (!raw || /^(generated\s+lesson\s+plan|lesson\s+plan)$/i.test(raw)) {
    return locale === 'en'
      ? 'Detailed learning proposal grounded in the selected source material.'
      : 'Đề xuất chi tiết được xây dựng và đối chiếu theo tài liệu nguồn đã chọn.';
  }
  return raw
    .replace(/\bla_diagram\b/g, componentTypeLabel('la_diagram', locale))
    .replace(/\bla_faq\b/g, componentTypeLabel('la_faq', locale))
    .replace(/\bla_sortable\b/g, componentTypeLabel('la_sortable', locale))
    .replace(/\bla_crossword\b/g, componentTypeLabel('la_crossword', locale))
    .replace(/\bproblem\b/g, componentTypeLabel('problem', locale))
    .replace(/\bhtml\b/g, componentTypeLabel('html', locale));
}

export function toLessonAuthorDisplayProposal(proposal: LessonAuthorProposal, locale: 'vi' | 'en' = 'vi'): LessonAuthorProposal {
  return {
    ...proposal,
    summary: humanizeLessonAuthorPlanText(proposal.summary, locale),
  };
}

export function constrainAdditiveComponentProposal(
  proposal: LessonAuthorProposal,
  userPrompt: string,
  outlineMentions: LessonAuthorOutlineMention[],
): LessonAuthorProposal {
  if (!isAdditiveComponentOnlyRequest(userPrompt, outlineMentions)) return proposal;

  const requestedTypes = new Set(getRequestedComponentTypes(userPrompt));
  let remaining = requestedComponentLimit(userPrompt) ?? Number.POSITIVE_INFINITY;
  let keptCount = 0;

  const chapters: LessonAuthorChapterProposal[] = proposal.chapters
    .map((chapter): LessonAuthorChapterProposal => ({
      ...chapter,
      lessons: chapter.lessons
        .map((lesson): LessonAuthorLessonProposal => ({
          ...lesson,
          units: lesson.units
            .map((unit): LessonAuthorUnitProposal => {
              const components = (unit.components ?? []).filter(component => {
                if (!requestedTypes.has(component.type) || remaining <= 0) return false;
                remaining -= 1;
                keptCount += 1;
                return true;
              });
              return { ...unit, components };
            })
            .filter(unit => (unit.components ?? []).length > 0),
        }))
        .filter(lesson => lesson.units.length > 0),
    }))
    .filter(chapter => chapter.lessons.length > 0);

  if (keptCount === 0 || chapters.length === 0) {
    throw new Error(`AI proposal did not include requested component type: ${Array.from(requestedTypes).map(type => componentTypeLabel(type, 'vi')).join(', ')}`);
  }

  const labels = Array.from(requestedTypes).map(type => componentTypeLabel(type, 'vi')).join(', ');
  const target = outlineMentions[0]?.display_name || 'target đã chọn';
  return {
    summary: `Đề xuất thêm ${keptCount} component ${labels} vào "${target}". Không thay thế, xoá, hoặc ghi đè component hiện có.`,
    chapters,
    ...(proposal.source_evidence ? { source_evidence: proposal.source_evidence } : {}),
  };
}

export function sanitizeInternalErrorReason(err: any): string {
  const msg = err?.message || err?.toString?.() || 'Unknown lesson author error';
  return redactGeminiApiKeys(String(msg)).slice(0, 2000);
}

export function formatLessonAuthorFailurePreview(err: any, locale: 'vi' | 'en' = 'vi'): string {
  const safeError = sanitizeGeminiError(err).message;
  if (locale === 'en') {
    return [
      'I could not create a valid lesson proposal for this request.',
      `Reason: ${safeError}`,
      'No change has been applied to the lesson structure. Please make the target or learning goal more specific and try again.',
    ].filter(Boolean).join('\n\n');
  }
  return [
    'Mình chưa thể tạo đề xuất nội dung khóa học cho yêu cầu này.',
    `Lý do: ${safeError}`,
    'Chưa có thay đổi nào được áp dụng vào cấu trúc bài học. Hãy thử lại với yêu cầu cụ thể hơn về chủ đề hoặc mục tiêu học tập.',
  ].filter(Boolean).join('\n\n');
}

export function formatLessonAuthorBlueprintFailurePreview(err: any, locale: 'vi' | 'en' = 'vi'): string {
  if (err instanceof RagServiceError && err.diagnostics.internal_failure_code === 'AI_PROVIDER_TIMEOUT') {
    return formatBlueprintProviderTimeout(locale);
  }
  const code = err instanceof AppError || err instanceof ComponentCapabilityError ? err.code : undefined;
  const assessmentGap = assessmentGapMessage(code, locale);
  if (assessmentGap) return assessmentGap;
  if (code === 'SOURCE_STRUCTURE_REVIEW_REQUIRED') {
    return locale === 'vi'
      ? 'Chưa thể tạo Bản thiết kế: cấu trúc chương trong nguồn chưa đầy đủ hoặc chưa xác minh được. Hãy kiểm tra mục lục/đề mục và phạm vi tài liệu đã chọn. Chưa áp dụng thay đổi nào.'
      : 'The source chapter structure is incomplete or cannot be verified. Review the source outline and selected document scope. No changes have been applied.';
  }
  if (code === 'SOURCE_SCOPE_INCOMPLETE' || code === 'SOURCE_MAP_SCOPE_INCOMPLETE'
    || code === 'SOURCE_FACT_EXTRACTION_CAPACITY_EXCEEDED' || code === 'ARCHITECT_CONTEXT_CANNOT_REPRESENT_SOURCE') {
    return locale === 'en'
      ? [
        'I could not create a course blueprint because the complete selected source scope could not be verified safely.',
        'No changes have been applied. Please review the selected source document or use a smaller complete source scope.',
      ].join('\n\n')
      : [
        'Mình chưa thể tạo Bản thiết kế khóa học vì chưa xác minh an toàn được toàn bộ phạm vi tài liệu nguồn đã chọn.',
        'Chưa có thay đổi nào được áp dụng. Hãy kiểm tra lại tài liệu nguồn hoặc chọn một phạm vi tài liệu đầy đủ và nhỏ hơn.',
      ].join('\n\n');
  }
  if (code === 'LESSON_AUTHOR_BLUEPRINT_INVALID') {
    return locale === 'en'
      ? [
        'I could not create a valid course blueprint after an automatic retry.',
        'No change has been applied to the lesson structure. Please narrow the course goal or review the selected source material.',
      ].join('\n\n')
      : [
        'Mình chưa thể tạo Bản thiết kế khóa học hợp lệ sau khi đã thử lại tự động.',
        'Chưa có thay đổi nào được áp dụng vào cấu trúc bài học. Hãy thu hẹp mục tiêu khóa học hoặc kiểm tra tài liệu nguồn đã chọn.',
      ].join('\n\n');
  }
  const safeError = sanitizeGeminiError(err).message;
  return locale === 'en'
    ? [
      'I could not create a course blueprint for this request.',
      `Reason: ${safeError}`,
      'No change has been applied to the lesson structure. Please review the source material or try again with a more specific course goal.',
    ].filter(Boolean).join('\n\n')
    : [
      'Mình chưa tạo được Bản thiết kế khóa học cho yêu cầu này.',
      `Lý do: ${safeError}`,
      'Chưa có thay đổi nào được áp dụng vào cấu trúc bài học. Hãy kiểm tra tài liệu nguồn hoặc thử lại với mục tiêu khóa học cụ thể hơn.',
    ].filter(Boolean).join('\n\n');
}

export function formatLessonAuthorActionPreview(
  plan: LessonAuthorOperationPlan,
  locale: 'vi' | 'en',
): string {
  const targetLabel = plan.target_type === 'chapter'
    ? locale === 'vi' ? 'Chương' : 'Chapter'
    : plan.target_type === 'lesson'
      ? locale === 'vi' ? 'Mục' : 'Section'
      : plan.target_type === 'unit'
        ? locale === 'vi' ? 'Bài học' : 'Lesson'
        : locale === 'vi' ? 'Component' : 'Component';
  if (locale === 'en') {
    const action = plan.operation === 'rename'
      ? `Rename ${targetLabel} "${plan.target_display_name}" to "${plan.requested_title}".`
      : plan.operation === 'delete'
        ? `Delete ${targetLabel} "${plan.target_display_name}" and its nested content.`
        : `Move ${targetLabel} "${plan.target_display_name}".`;
    return [
      'I prepared a change proposal. The course will not be changed until you click Apply.',
      '',
      '**Change summary**',
      `- ${action}`,
      `- **Target:** ${plan.target_path}`,
      plan.operation === 'delete' ? '- **Confirmation required:** this is a destructive action.' : '',
      '',
      'Review the target carefully, then click **Apply** to confirm.',
    ].filter(Boolean).join('\n');
  }
  const action = plan.operation === 'rename'
    ? `Đổi tên ${targetLabel} "${plan.target_display_name}" thành "${plan.requested_title}".`
    : plan.operation === 'delete'
      ? `Xóa ${targetLabel} "${plan.target_display_name}" và toàn bộ nội dung bên trong.`
      : `Thay đổi vị trí của ${targetLabel} "${plan.target_display_name}".`;
  return [
    'Mình đã chuẩn bị đề xuất thay đổi. Khóa học chưa bị thay đổi cho đến khi bạn bấm Áp dụng.',
    '',
    '**Tóm tắt thay đổi**',
    `- ${action}`,
    `- **Vị trí:** ${plan.target_path}`,
    plan.operation === 'delete' ? '- **Cần xác nhận:** đây là thao tác xóa và không thể xem nhẹ.' : '',
    '',
    'Kiểm tra đúng node, sau đó bấm **Áp dụng** để xác nhận.',
  ].filter(Boolean).join('\n');
}

export async function assertLessonAuthorActionPlanFresh(
  plan: LessonAuthorOperationPlan,
  courseId: string,
  tenantId: string,
): Promise<void> {
  const result = await query<{
    id: string;
    parent_id: string | null;
    block_type: string;
    display_name: string;
    sort_order: number;
    data: unknown;
    metadata: unknown;
    updated_at: string | Date;
  }>(
    `SELECT cb.id::text AS id, cb.parent_id::text AS parent_id, cb.block_type,
            cb.display_name, cb.sort_order, cb.data, cb.metadata, cb.updated_at
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.id = $1
       AND cb.course_id = $2
       AND c.tenant_id = $3
       AND c.deleted_at IS NULL
       AND cb.deleted_at IS NULL
     LIMIT 1`,
    [plan.target_block_id, courseId, tenantId],
  );
  const target = result.rows[0];
  if (!target) throw new AppError('Node trong cây outline không còn tồn tại.', 409);
  if (plan.target_snapshot && canonicalTargetSnapshot(target) !== plan.target_snapshot) {
    throw new AppError('Node trong cây outline đã thay đổi sau khi tạo đề xuất. Vui lòng tạo lại đề xuất.', 409);
  }
}

export function readStoredLessonAuthorOperationPlan(value: unknown): LessonAuthorOperationPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const plan = value as Partial<LessonAuthorOperationPlan>;
  const operations = new Set(['rename', 'delete', 'move', 'create', 'update_content']);
  const targetTypes = new Set(['course', 'chapter', 'lesson', 'unit', 'component']);
  const fields = new Set(['title', 'content', 'components', 'sort_order']);
  const targetSources = new Set(['mention', 'explicit_reference', 'conversation_context', 'none']);
  if (plan.version !== 1) return null;
  if (!operations.has(String(plan.operation))) return null;
  if (!targetTypes.has(String(plan.target_type))) return null;
  if (!isValidUUID(String(plan.target_block_id))) return null;
  if (typeof plan.target_path !== 'string' || !plan.target_path.trim()) return null;
  if (typeof plan.target_display_name !== 'string' || !plan.target_display_name.trim()) return null;
  if (typeof plan.target_updated_at !== 'string' || !plan.target_updated_at.trim() || Number.isNaN(Date.parse(plan.target_updated_at))) return null;
  if (typeof plan.confidence !== 'number' || !Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) return null;
  if (typeof plan.requires_confirmation !== 'boolean') return null;
  if (typeof plan.target_source !== 'string' || !targetSources.has(plan.target_source)) return null;
  if (plan.title_strategy !== undefined && plan.title_strategy !== null
    && plan.title_strategy !== 'prefix_chapter_number') return null;
  if (!Array.isArray(plan.fields) || plan.fields.length === 0 || !plan.fields.every(field => typeof field === 'string' && fields.has(field))) return null;
  if (!Array.isArray(plan.signals) || !plan.signals.every(signal => typeof signal === 'string')) return null;
  if (!Array.isArray(plan.ambiguity_reasons) || !plan.ambiguity_reasons.every(reason => typeof reason === 'string')) return null;
  if (plan.target_snapshot !== undefined && plan.target_snapshot !== null
    && (typeof plan.target_snapshot !== 'string' || !/^[0-9a-f]{64}$/i.test(plan.target_snapshot))) return null;
  if (plan.target_number_path !== undefined && plan.target_number_path !== null
    && (typeof plan.target_number_path !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(plan.target_number_path))) return null;
  if (plan.target_resolution !== undefined && plan.target_resolution !== null
    && plan.target_resolution !== 'existing' && plan.target_resolution !== 'new') return null;
  if (plan.target_resolution === 'new'
    && (plan.operation !== 'create'
      || plan.target_type !== 'chapter'
      || typeof plan.target_number_path !== 'string'
      || !/^\d+$/.test(plan.target_number_path))) return null;
  if (plan.operation === 'delete' && plan.requires_confirmation !== true) return null;
  if (plan.operation === 'rename'
    && (typeof plan.requested_title !== 'string' || !plan.requested_title.trim() || plan.requested_title.trim().length > 180)) return null;
  return plan as LessonAuthorOperationPlan;
}

export function readLessonAuthorLocale(value: unknown): 'vi' | 'en' {
  return value === 'en' ? 'en' : 'vi';
}

export function formatProposalPreview(
  proposal: LessonAuthorProposal,
  chapterIndexOffset = 0,
  locale: 'vi' | 'en' = 'vi',
): string {
  if (proposal.operation_plan
    && (proposal.operation_plan.operation === 'rename'
      || proposal.operation_plan.operation === 'delete'
      || proposal.operation_plan.operation === 'move')) {
    return formatLessonAuthorActionPreview(proposal.operation_plan, locale);
  }
  const resolvedChapterNumber = proposal.operation_plan?.target_number_path?.match(/^\d+/)?.[0];
  const chapterNumber = resolvedChapterNumber
    ? Math.max(1, Number(resolvedChapterNumber))
    : Math.max(1, chapterIndexOffset + 1);
  return formatLessonAuthorProposalReadyMessage(chapterNumber, locale);
}

// Older presentation logic stays isolated while historical records are still
// supported. New and hydrated chat bubbles intentionally use the concise
// message above; proposal details are supplied by canonical job hydration.

export function formatBlueprintPreview(
  _blueprint: LessonAuthorBlueprint,
  _qualityReport: LessonAuthorBlueprintQualityReport,
  locale: 'vi' | 'en' = 'vi',
): string {
  return formatLessonAuthorBlueprintReadyMessage(locale);
}

export function looksLikeLessonAuthorProposalJsonResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const hasJsonFence = /```json/i.test(trimmed);
  const hasProposalShape = /"chapters"\s*:/.test(trimmed) || /"changes"\s*:/.test(trimmed);
  const hasCourseTreeShape = /"lessons"\s*:/.test(trimmed) || /"units"\s*:/.test(trimmed) || /"components"\s*:/.test(trimmed);
  const mentionsProposal = /proposal|de xuat|đề xuất/i.test(foldVietnameseText(trimmed));
  return (hasJsonFence && (hasProposalShape || hasCourseTreeShape || mentionsProposal))
    || (hasProposalShape && hasCourseTreeShape);
}

export function getLessonAuthorProposalMetrics(proposal: LessonAuthorProposal): Record<string, unknown> {
  let lessonCount = 0;
  let unitCount = 0;
  let componentCount = 0;
  const componentTypes = new Set<string>();

  proposal.chapters.forEach(chapter => {
    lessonCount += chapter.lessons.length;
    chapter.lessons.forEach(lesson => {
      unitCount += lesson.units.length;
      lesson.units.forEach(unit => {
        const components = unit.components ?? [];
        componentCount += components.length;
        components.forEach(component => componentTypes.add(component.type));
      });
    });
  });

  return {
    chapters: proposal.chapters.length,
    lessons: lessonCount,
    units: unitCount,
    components: componentCount,
    component_types: Array.from(componentTypes),
  };
}
