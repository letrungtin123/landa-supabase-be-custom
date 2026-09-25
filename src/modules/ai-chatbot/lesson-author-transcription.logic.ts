export type LessonAuthorTranscriptLocale = 'vi' | 'en';

const SAFE_UPLOAD_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Browser supplied for diagnostics/idempotency only; never an authority ID. */
export function normalizeLessonAuthorUploadAttemptId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return SAFE_UPLOAD_ATTEMPT_ID.test(normalized) ? normalized.toLowerCase() : null;
}

export const LESSON_AUTHOR_TRANSCRIPTION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'expired',
  'committed',
] as const;

export type LessonAuthorTranscriptionStatus = typeof LESSON_AUTHOR_TRANSCRIPTION_STATUSES[number];

export const LESSON_AUTHOR_KB_DOCUMENT_STATUSES = ['draft', 'learning', 'learned', 'error'] as const;
export type LessonAuthorKbDocumentStatus = typeof LESSON_AUTHOR_KB_DOCUMENT_STATUSES[number];

export function normalizeLessonAuthorKbDocumentStatus(value: unknown): LessonAuthorKbDocumentStatus | null {
  return LESSON_AUTHOR_KB_DOCUMENT_STATUSES.includes(value as LessonAuthorKbDocumentStatus)
    ? value as LessonAuthorKbDocumentStatus
    : null;
}

export function isLessonAuthorTranscriptSourceReady(
  transcriptionStatus: LessonAuthorTranscriptionStatus,
  kbDocumentStatus: unknown,
): boolean {
  return transcriptionStatus === 'committed'
    && normalizeLessonAuthorKbDocumentStatus(kbDocumentStatus) === 'learned';
}

export const LESSON_AUTHOR_VIDEO_MIME_TYPE = 'video/mp4';
// Supabase Storage compares this bucket's MIME allowlist literally. Charset
// parameters belong to an HTTP response, not to the stored object MIME.
export const LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE = 'text/plain';

export function isSupportedLessonAuthorVideo(fileName: string, mimeType: string): boolean {
  return /\.mp4$/i.test(fileName.trim())
    && ['video/mp4', 'application/mp4', 'application/octet-stream'].includes(mimeType.toLowerCase().trim());
}

export function transcriptFileName(videoName: string): string {
  const base = videoName.trim().replace(/\.mp4$/i, '') || 'lesson-video';
  return `${base}.transcript.txt`;
}

export function isTerminalTranscriptionStatus(status: LessonAuthorTranscriptionStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'expired' || status === 'committed';
}

export function formatLessonAuthorTranscriptMessage(
  status: LessonAuthorTranscriptionStatus,
  fileName: string,
  locale: LessonAuthorTranscriptLocale,
): string {
  const english = locale === 'en';
  switch (status) {
    case 'queued':
    case 'running':
      return english
        ? `Preparing a transcript for ${fileName} and adding it to the knowledge base.`
        : `Đang tạo bản chép lời cho ${fileName} và đưa vào Kho tri thức.`;
    case 'succeeded':
      return english
        ? `The transcript for ${fileName} is ready.`
        : `Bản chép lời của ${fileName} đã sẵn sàng.`;
    case 'committed':
      return english
        ? `The transcript for ${fileName} has been added to the knowledge base and is being indexed.`
        : `Bản chép lời của ${fileName} đã được đưa vào Kho tri thức và đang được học.`;
    case 'expired':
      return english
        ? `The transcript for ${fileName} has expired. Upload the video again to create a new transcript.`
        : `Bản chép lời của ${fileName} đã hết hạn. Hãy tải lại video để tạo bản mới.`;
    case 'failed':
    default:
      return english
        ? `The transcript for ${fileName} could not be created.`
        : `Không thể tạo bản chép lời cho ${fileName}.`;
  }
}

/** Keep transcript text plain, bounded, and safe to index as a KB source. */
export function normalizeTranscriptText(value: string, maximumChars: number): string {
  const normalized = value
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length < 40) throw new Error('Transcript quá ngắn hoặc không có lời nói rõ ràng.');
  if (normalized.length > maximumChars) {
    throw new Error('Transcript vượt quá giới hạn nội dung cho phép.');
  }
  return normalized;
}
