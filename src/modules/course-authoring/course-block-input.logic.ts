// ═══════════════════════════════════════════════════════════════
// Course block input: what the browser may store in a component (media of a
// problem or text block, media quiz, image-choice question, scenario
// conversation, editable metadata) and which storage paths a delete may name.
// Pure; moved unchanged from course-authoring.controller.ts. Data a sanitizer
// refuses is a client error: AppError 400 COURSE_BLOCK_DATA_INVALID with the
// sanitizer's message (docs/error-codes.md).
// ═══════════════════════════════════════════════════════════════

import { sanitizeCourseRichText } from './course-html-sanitizer.logic.js';
import { withoutServerOwnedAuthorNotes } from './course-author-notes.logic.js';
import { isUuid } from '../../utils/uuid.js';
import { AppError } from '../../utils/errors.js';

/** Component data a sanitizer refuses (400, with the sanitizer's own message). */
export const COURSE_BLOCK_DATA_INVALID_CODE = 'COURSE_BLOCK_DATA_INVALID';

export function courseBlockDataInvalid(message: string): AppError {
  return new AppError(message, 400, COURSE_BLOCK_DATA_INVALID_CODE);
}

/** Component JSON sent as a string (typed as JSON.parse types it); text that is not JSON reads as no object. */
function parseComponentJson(raw: unknown): ReturnType<typeof JSON.parse> {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractYoutubeId(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return '';
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?[^#]*v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return '';
}

export function isSafeCourseAssetPath(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  const value = src.trim();
  if (!value || value.length > 1000) return false;
  const lower = value.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('//') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('javascript:')
  ) return false;
  if (!value.includes('/courses/')) return false;
  return !/[<>"'`\\]/.test(value);
}

export function sanitizeProblemMedia(raw: any) {
  if (!raw || typeof raw !== 'object') return undefined;

  const youtubeId = extractYoutubeId(raw.youtube_id || raw.youtube_url || raw.video_url);
  const images = Array.isArray(raw.images)
    ? raw.images
        .map((img: any) => ({
          src: typeof img?.src === 'string' ? img.src.trim() : '',
          alt: typeof img?.alt === 'string' ? img.alt.replace(/[<>]/g, '').slice(0, 200) : '',
        }))
        .filter((img: any) => isSafeCourseAssetPath(img.src))
        .slice(0, 20)
    : [];

  // Video upload (storage path) — alternative to YouTube
  const videoStoragePath = typeof raw.video_storage_path === 'string' && isSafeCourseAssetPath(raw.video_storage_path)
    ? raw.video_storage_path.trim()
    : undefined;

  if (!youtubeId && images.length === 0 && !videoStoragePath) return undefined;

  return {
    ...(youtubeId ? {
      youtube_id: youtubeId,
      youtube_url: `https://www.youtube.com/watch?v=${youtubeId}`,
    } : {}),
    ...(videoStoragePath ? { video_storage_path: videoStoragePath } : {}),
    images,
  };
}

function sanitizeHtmlMedia(raw: any) {
  if (!raw || typeof raw !== 'object') return undefined;

  const images = Array.isArray(raw.images)
    ? raw.images
        .map((img: any) => {
          const src = typeof img?.src === 'string' ? img.src.trim() : '';
          return {
            src,
            alt: typeof img?.alt === 'string' ? img.alt.replace(/[<>]/g, '').slice(0, 200) : '',
            ...(isUuid(img?.asset_id) ? { asset_id: img.asset_id } : {}),
          };
        })
        .filter((img: any) => isSafeCourseAssetPath(img.src))
        .slice(0, 50)
    : [];

  if (images.length === 0) return undefined;
  return { images };
}

/** Quiz rich text uses the same allowlist sanitizer as text blocks. */
function sanitizeMediaQuizHtml(raw: unknown, fallback: string, maxLength: number): string {
  return sanitizeCourseRichText(raw, fallback, maxLength);
}

function sanitizeMediaQuizId(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function sanitizeMediaQuizMode(raw: unknown, fallback: 'single_select' | 'multiple_select'): 'single_select' | 'multiple_select' {
  return raw === 'single_select' || raw === 'multiple_select' ? raw : fallback;
}

export function sanitizeMediaQuizData(raw: any) {
  const parsed = parseComponentJson(raw);
  if (!parsed || typeof parsed !== 'object') throw courseBlockDataInvalid('Dữ liệu câu hỏi kèm media phải là object');

  const mode = sanitizeMediaQuizMode(parsed.mode, 'single_select');
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw courseBlockDataInvalid('Câu hỏi kèm media cần ít nhất một câu hỏi');
  }

  const questions = parsed.questions.slice(0, 50).map((question: any, questionIndex: number) => {
    const questionMode = sanitizeMediaQuizMode(question?.mode, mode);
    const mediaType = question?.media?.type === 'video' ? 'video' : 'image';
    const storagePath = typeof question?.media?.storage_path === 'string'
      ? question.media.storage_path.trim()
      : '';
    if (!isSafeCourseAssetPath(storagePath)) {
      throw courseBlockDataInvalid(`Câu hỏi ${questionIndex + 1} cần tải media của khóa học lên`);
    }

    if (!Array.isArray(question?.choices) || question.choices.length < 2) {
      throw courseBlockDataInvalid(`Câu hỏi ${questionIndex + 1} cần ít nhất hai lựa chọn`);
    }

    const choices = question.choices.slice(0, 12).map((choice: any, choiceIndex: number) => ({
      id: sanitizeMediaQuizId(choice?.id, `choice_${choiceIndex}`),
      html: sanitizeMediaQuizHtml(choice?.html, `Lựa chọn ${choiceIndex + 1}`, 2000),
      correct: choice?.correct === true,
    }));

    const correctCount = choices.filter((choice: any) => choice.correct).length;
    if (correctCount === 0) {
      throw courseBlockDataInvalid(`Câu hỏi ${questionIndex + 1} cần ít nhất một đáp án đúng`);
    }
    if (questionMode === 'single_select' && correctCount !== 1) {
      throw courseBlockDataInvalid(`Câu hỏi ${questionIndex + 1} phải có đúng một đáp án đúng`);
    }

    const hints = Array.isArray(question?.hints)
      ? question.hints
          .slice(0, 10)
          .map((hint: unknown) => sanitizeMediaQuizHtml(hint, '', 2000))
          .filter(Boolean)
      : [];

    return {
      id: sanitizeMediaQuizId(question?.id, `q_${questionIndex + 1}`),
      mode: questionMode,
      prompt_html: sanitizeMediaQuizHtml(question?.prompt_html, `Câu hỏi ${questionIndex + 1}`, 4000),
      explanation_html: sanitizeMediaQuizHtml(question?.explanation_html, '', 8000),
      hints,
      media: {
        type: mediaType,
        storage_path: storagePath,
        alt: typeof question?.media?.alt === 'string'
          ? question.media.alt.replace(/[<>]/g, '').slice(0, 200)
          : '',
      },
      choices,
    };
  });

  return {
    version: 1,
    mode: questions[0]?.mode ?? mode,
    require_correct_to_advance: true,
    questions,
  };
}

export function getMediaQuizMetadataMode(data: any): 'single_select' | 'multiple_select' | 'mixed' {
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const hasSingle = questions.some((question: any) => question?.mode !== 'multiple_select');
  const hasMultiple = questions.some((question: any) => question?.mode === 'multiple_select');
  if (hasSingle && hasMultiple) return 'mixed';
  return hasMultiple ? 'multiple_select' : 'single_select';
}

function plainTextFromHtml(raw: string): string {
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sanitizeImageChoiceQuizData(raw: any) {
  const parsed = parseComponentJson(raw);
  if (!parsed || typeof parsed !== 'object') throw courseBlockDataInvalid('Dữ liệu câu hỏi đáp án hình ảnh phải là object');

  const promptHtml = sanitizeMediaQuizHtml(parsed.prompt_html, '', 4000);
  if (!plainTextFromHtml(promptHtml)) {
    throw courseBlockDataInvalid('Câu hỏi đáp án hình ảnh cần nội dung câu hỏi');
  }

  if (!Array.isArray(parsed.choices) || parsed.choices.length < 2 || parsed.choices.length > 4) {
    throw courseBlockDataInvalid('Câu hỏi đáp án hình ảnh phải có từ 2 đến 4 đáp án');
  }

  const choices = parsed.choices.map((choice: any, choiceIndex: number) => {
    const choiceHtml = sanitizeMediaQuizHtml(choice?.html, '', 2000);
    if (!plainTextFromHtml(choiceHtml)) {
      throw courseBlockDataInvalid(`Đáp án ${choiceIndex + 1} cần nội dung`);
    }

    const storagePath = typeof choice?.image?.storage_path === 'string'
      ? choice.image.storage_path.trim()
      : '';
    if (storagePath && !isSafeCourseAssetPath(storagePath)) {
      throw courseBlockDataInvalid(`Đáp án ${choiceIndex + 1} có đường dẫn hình ảnh không hợp lệ`);
    }

    return {
      id: sanitizeMediaQuizId(choice?.id, `choice_${choiceIndex + 1}`),
      html: choiceHtml,
      correct: choice?.correct === true,
      image: {
        storage_path: storagePath,
        alt: typeof choice?.image?.alt === 'string'
          ? choice.image.alt.replace(/[<>]/g, '').slice(0, 200)
          : '',
      },
    };
  });

  const correctCount = choices.filter((choice: any) => choice.correct).length;
  if (correctCount !== 1) {
    throw courseBlockDataInvalid('Câu hỏi đáp án hình ảnh phải có đúng 1 đáp án đúng');
  }

  const hints = Array.isArray(parsed.hints)
    ? parsed.hints
        .slice(0, 10)
        .map((hint: unknown) => sanitizeMediaQuizHtml(hint, '', 2000))
        .filter(Boolean)
    : [];

  return {
    version: 1,
    prompt_html: promptHtml,
    explanation_html: sanitizeMediaQuizHtml(parsed.explanation_html, '', 8000),
    hints,
    choices,
  };
}

function sanitizeScenarioChatText(raw: unknown, fallback: string, maxLength: number): string {
  const value = typeof raw === 'string' ? raw : fallback;
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength)
    .trim();
}

function sanitizeScenarioChatId(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

function sanitizeScenarioChatPerson(raw: any, fallbackName: string) {
  return {
    name: sanitizeScenarioChatText(raw?.name, fallbackName, 80) || fallbackName,
    description: sanitizeScenarioChatText(raw?.description, '', 240),
  };
}

function getScenarioChatContextDescription(raw: any): string {
  if (typeof raw?.context_description === 'string') return raw.context_description;
  if (typeof raw?.status_line === 'string') return raw.status_line;
  if (!Array.isArray(raw?.rounds)) return '';

  for (const round of raw.rounds) {
    const value = typeof round?.status_line === 'string' ? round.status_line.trim() : '';
    if (value) return value;
  }

  return '';
}

export function sanitizeScenarioChatData(raw: any) {
  const parsed = parseComponentJson(raw);
  if (!parsed || typeof parsed !== 'object') throw courseBlockDataInvalid('Dữ liệu Giao tiếp tình huống phải là object');
  if (!Array.isArray(parsed.rounds) || parsed.rounds.length === 0) {
    throw courseBlockDataInvalid('Giao tiếp tình huống cần ít nhất một lượt hội thoại');
  }

  const contextDescription = sanitizeScenarioChatText(getScenarioChatContextDescription(parsed), '', 1200);
  const rounds = parsed.rounds.slice(0, 100).map((round: any, roundIndex: number) => {
    if (!Array.isArray(round?.choices) || round.choices.length !== 3) {
      throw courseBlockDataInvalid(`Lượt ${roundIndex + 1} phải có đúng 3 câu trả lời`);
    }

    const choices = round.choices.map((choice: any, choiceIndex: number) => ({
      id: sanitizeScenarioChatId(choice?.id, `choice_${choiceIndex + 1}`),
      text: sanitizeScenarioChatText(choice?.text, '', 600),
      correct: choice?.correct === true,
      response_message: sanitizeScenarioChatText(choice?.response_message, '', 1200),
      response_description: sanitizeScenarioChatText(choice?.response_description, '', 300),
      character_status: sanitizeScenarioChatText(choice?.character_status, '', 300),
      explanation: sanitizeScenarioChatText(choice?.explanation, '', 1500),
    }));

    const correctCount = choices.filter((choice: any) => choice.correct).length;
    if (correctCount !== 1) {
      throw courseBlockDataInvalid(`Lượt ${roundIndex + 1} phải có đúng 1 câu trả lời đúng`);
    }

    return {
      id: sanitizeScenarioChatId(round?.id, `round_${roundIndex + 1}`),
      scenario_message: {
        text: sanitizeScenarioChatText(round?.scenario_message?.text, '', 1200),
        description: sanitizeScenarioChatText(round?.scenario_message?.description, '', 300),
      },
      choices,
    };
  });

  return {
    version: 1,
    context_description: contextDescription,
    participant: sanitizeScenarioChatPerson(parsed.participant, 'Nhân vật tình huống'),
    learner: sanitizeScenarioChatPerson(parsed.learner, 'Bạn'),
    rounds,
  };
}

export function sanitizeMetadata(metadata: any) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  // Server-owned AI ID author notes are never accepted from a browser.
  const next = { ...withoutServerOwnedAuthorNotes(metadata) };
  if ('problem_media' in next) {
    const media = sanitizeProblemMedia(next.problem_media);
    if (media) next.problem_media = media;
    else delete next.problem_media;
  }
  if ('html_media' in next) {
    const media = sanitizeHtmlMedia(next.html_media);
    if (media) next.html_media = media;
    else delete next.html_media;
  }
  return next;
}
