// Pure message contracts used by the lesson-author conversation flow.
// Keeping query text and copy isolated makes tenant-scoped hydration and
// localization regressions testable without opening a database connection.

export type LessonAuthorApprovalOperation = string | null | undefined;
export type LessonAuthorMessageLocale = 'vi' | 'en';

export function formatLessonAuthorBlueprintReadyMessage(
  locale: LessonAuthorMessageLocale,
): string {
  return locale === 'en'
    ? 'The course blueprint is ready. Open Course blueprint to review the structure, learner outcomes, quality checks, and course mind map.'
    : 'Bản thiết kế khóa học đã sẵn sàng. Mở Bản thiết kế khóa học để rà soát cấu trúc, kết quả đầu ra, chất lượng và mind map toàn khóa.';
}

export function formatLessonAuthorProposalReadyMessage(
  chapterNumber: number,
  locale: LessonAuthorMessageLocale,
): string {
  return locale === 'en'
    ? `The detailed proposal for Chapter ${chapterNumber} is ready for review. Open the outline changes before applying it.`
    : `Đề xuất nội dung chi tiết cho Chương ${chapterNumber} đã sẵn sàng để duyệt. Mở phần thay đổi outline trước khi áp dụng.`;
}

export function formatLessonAuthorApprovalMessage(
  operation: LessonAuthorApprovalOperation,
  createdCount: number,
  updatedCount: number,
  locale: LessonAuthorMessageLocale,
): string {
  if (operation === 'delete') {
    return locale === 'en'
      ? 'The selected outline item has been queued for deletion.'
      : 'Đã đưa node được chọn vào hàng đợi xóa khỏi cấu trúc khóa học.';
  }
  if (operation === 'rename') {
    return locale === 'en'
      ? 'The selected outline item title has been updated.'
      : 'Đã đổi tiêu đề node được chọn trong cấu trúc khóa học.';
  }
  return locale === 'en'
    ? [
      'The proposal has been applied to the course structure.',
      `Created ${createdCount} content item(s) and updated ${updatedCount} item(s).`,
    ].join('\n\n')
    : [
      'Đã áp dụng đề xuất vào cấu trúc khóa học.',
      `Đã thêm ${createdCount} mục nội dung và cập nhật ${updatedCount} mục.`,
    ].join('\n\n');
}

export const LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY = `SELECT laj.id::text, laj.status, laj.proposal, laj.error_reason, laj.created_block_ids, laj.updated_block_ids, laj.source_documents,
        (
          SELECT proposal_message.metadata ->> 'locale'
          FROM chat_messages proposal_message
          WHERE proposal_message.conversation_id = laj.conversation_id
            AND proposal_message.role = 'assistant'
            AND proposal_message.metadata ->> 'kind' = 'lesson_author_proposal'
            AND proposal_message.metadata ->> 'lesson_author_job_id' = laj.id::text
          ORDER BY proposal_message.created_at DESC, proposal_message.id DESC
          LIMIT 1
        ) AS proposal_locale,
        blueprint_id::text
 FROM lesson_author_jobs laj
 WHERE laj.conversation_id = $1
   AND laj.tenant_id = $2
   AND laj.id = ANY($3::uuid[])`;
