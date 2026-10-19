// ═══════════════════════════════════════════════════════════════
// Course publish checks: what a media quiz, image-choice question or scenario
// conversation needs before it can be published, and the course images an
// image-choice question uses. Pure; moved unchanged from
// course-authoring.service.ts.
// ═══════════════════════════════════════════════════════════════

import { AppError } from '../../utils/errors.js';
import { extractStoragePath } from '../../config/storage.js';
import { mediaQuizModeValue } from './course-block-defaults.logic.js';

function htmlPlainText(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function imageChoiceString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getImageChoiceQuizImagePaths(raw: any): string[] {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) return [];

  return Array.from(new Set(
    data.choices
      .map((choice: any) => {
        const value = imageChoiceString(choice?.image?.storage_path);
        return extractStoragePath(value) || value;
      })
      .filter(Boolean),
  ));
}

export function assertPublishableImageChoiceQuizData(raw: any, label: string): void {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') {
    throw new AppError(`${label} cần dữ liệu câu hỏi trước khi publish`, 400);
  }
  if (!htmlPlainText(data.prompt_html)) {
    throw new AppError(`${label} cần nội dung câu hỏi trước khi publish`, 400);
  }
  if (!Array.isArray(data.choices) || data.choices.length < 2 || data.choices.length > 4) {
    throw new AppError(`${label} phải có từ 2 đến 4 đáp án`, 400);
  }
  const correctCount = data.choices.filter((choice: any) => choice?.correct === true).length;
  if (correctCount !== 1) {
    throw new AppError(`${label} phải có đúng 1 đáp án đúng`, 400);
  }
  data.choices.forEach((choice: any, index: number) => {
    if (!htmlPlainText(choice?.html)) {
      throw new AppError(`${label} - đáp án ${index + 1} cần nội dung`, 400);
    }
    if (!imageChoiceString(choice?.image?.storage_path)) {
      throw new AppError(`${label} - đáp án ${index + 1} cần upload hình ảnh`, 400);
    }
  });
}

export function assertPublishableMediaQuizData(raw: any, label: string): void {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new AppError(`${label} cần ít nhất một câu hỏi kèm media trước khi publish`, 400);
  }
  const dataMode = mediaQuizModeValue(data.mode, 'single_select');
  data.questions.forEach((question: any, index: number) => {
    const questionMode = mediaQuizModeValue(question?.mode, dataMode);
    if (!question?.media?.storage_path || typeof question.media.storage_path !== 'string') {
      throw new AppError(`${label} - câu hỏi ${index + 1} cần tải media lên trước khi publish`, 400);
    }
    if (!Array.isArray(question?.choices) || question.choices.length < 2) {
      throw new AppError(`${label} - câu hỏi ${index + 1} cần ít nhất hai lựa chọn trước khi publish`, 400);
    }
    const correctCount = question.choices.filter((choice: any) => choice?.correct === true).length;
    if (correctCount === 0) {
      throw new AppError(`${label} - câu hỏi ${index + 1} cần ít nhất một đáp án đúng trước khi publish`, 400);
    }
    if (questionMode === 'single_select' && correctCount !== 1) {
      throw new AppError(`${label} - câu hỏi ${index + 1} phải có đúng một đáp án đúng trước khi publish`, 400);
    }
  });
}

function scenarioChatText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function assertPublishableScenarioChatData(raw: any, label: string): void {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.rounds) || data.rounds.length === 0) {
    throw new AppError(`${label} cần ít nhất một lượt hội thoại trước khi publish`, 400);
  }
  if (!scenarioChatText(data.participant?.name)) {
    throw new AppError(`${label} cần tên nhân vật tình huống trước khi publish`, 400);
  }
  if (!scenarioChatText(data.learner?.name)) {
    throw new AppError(`${label} cần tên học viên trước khi publish`, 400);
  }

  data.rounds.forEach((round: any, index: number) => {
    if (!scenarioChatText(round?.scenario_message?.text)) {
      throw new AppError(`${label} - lượt ${index + 1} cần nội dung bong bóng tình huống`, 400);
    }
    if (!Array.isArray(round?.choices) || round.choices.length !== 3) {
      throw new AppError(`${label} - lượt ${index + 1} phải có đúng 3 câu trả lời`, 400);
    }
    const correctCount = round.choices.filter((choice: any) => choice?.correct === true).length;
    if (correctCount !== 1) {
      throw new AppError(`${label} - lượt ${index + 1} phải có đúng 1 câu trả lời đúng`, 400);
    }
    round.choices.forEach((choice: any, choiceIndex: number) => {
      if (!scenarioChatText(choice?.text)) {
        throw new AppError(`${label} - lượt ${index + 1}, câu ${choiceIndex + 1} cần nội dung câu trả lời`, 400);
      }
      if (!scenarioChatText(choice?.response_message)) {
        throw new AppError(`${label} - lượt ${index + 1}, câu ${choiceIndex + 1} cần bong bóng phản hồi`, 400);
      }
      if (!scenarioChatText(choice?.explanation)) {
        throw new AppError(`${label} - lượt ${index + 1}, câu ${choiceIndex + 1} cần giải thích`, 400);
      }
    });
  });
}
