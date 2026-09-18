export type LessonAuthorBlueprintReviewLocale = 'vi' | 'en';

export type LessonAuthorBlueprintQualityCheck = {
  key: string;
  passed: boolean;
};

export function getLessonAuthorBlueprintReviewNotes(
  checks: readonly LessonAuthorBlueprintQualityCheck[],
  structureSource: string | null | undefined,
  hasAssumptions: boolean,
  locale: LessonAuthorBlueprintReviewLocale,
): string[] {
  const isVietnamese = locale === 'vi';
  const isFailed = (key: string) => checks.some(check => check.key === key && !check.passed);
  const notes: string[] = [];

  if (isFailed('learning_outcomes')) {
    notes.push(isVietnamese
      ? 'Cần bổ sung ít nhất ba kết quả học tập có thể đo lường.'
      : 'Add at least three measurable learning outcomes.');
  }
  if (isFailed('constructive_alignment')) {
    notes.push(isVietnamese
      ? 'Cần rà lại sự liên kết giữa mục tiêu, hoạt động và đánh giá.'
      : 'Review alignment between objectives, learning activities, and assessment.');
  }
  if (isFailed('assessment_strategy')) {
    notes.push(isVietnamese
      ? 'Cần mô tả rõ cách đánh giá kết quả học tập.'
      : 'Clarify how learning outcomes will be assessed.');
  }
  if (isFailed('duration_balance')) {
    notes.push(isVietnamese
      ? 'Cần rà lại thời lượng giữa chương và bài học.'
      : 'Review the time allocation across chapters and lessons.');
  }
  if (isFailed('source_grounding')) {
    notes.push(isVietnamese
      ? 'Chưa có nguồn tài liệu được chọn hoặc truy xuất rõ ràng để đối chiếu.'
      : 'No selected or retrieved source material is available for verification.');
  }
  if (isFailed('source_structure')) {
    notes.push(structureSource === 'heading_inferred'
      ? (isVietnamese
        ? 'Chưa xác định được mục lục có thẩm quyền; cấu trúc đang được suy luận từ tiêu đề và cần rà soát trước khi soạn chi tiết.'
        : 'No authoritative table of contents was found; the structure was inferred from headings and must be reviewed before detailed authoring.')
      : (isVietnamese
        ? 'Tài liệu chưa có mục lục/tiêu đề đủ rõ; cấu trúc cần được rà soát trước khi soạn chi tiết.'
        : 'The document does not provide a clear enough table of contents or heading structure; review the structure before detailed authoring.'));
  }
  if (isFailed('source_coverage')) {
    notes.push(isVietnamese
      ? 'Phạm vi nguồn được truy xuất chưa bao phủ đủ cấu trúc tài liệu; cần kiểm tra lại trước khi áp dụng.'
      : 'Retrieved source coverage does not yet cover the document structure sufficiently; verify it before applying the blueprint.');
  }
  if (hasAssumptions) {
    notes.push(isVietnamese
      ? 'Xác nhận các giả định trước khi soạn chi tiết từng chương.'
      : 'Confirm the design assumptions before drafting each chapter in detail.');
  }

  return notes.slice(0, 6);
}
