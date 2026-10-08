import { withoutAuthorOnlyBlockMetadata } from '../course-authoring/course-author-notes.logic.js';

// Pure learner block serialization (moved verbatim from learner.service.ts so
// the learner boundary is testable without opening database/cache handles).

/** Every learner block response passes through here (course tree and block
 * detail, including anonymous demo learners). Publishing copies the draft
 * metadata verbatim, so AI ID author-only keys are removed at this boundary. */
export function toLearnerBlockRow(input: any) {
  const row = input && typeof input === 'object' ? withoutAuthorOnlyBlockMetadata(input) : input;
  if (row?.block_type === 'la_media_quiz') {
    return {
      ...row,
      data: toLearnerMediaQuizData(row.data),
    };
  }
  if (row?.block_type === 'la_image_choice_quiz') {
    return {
      ...row,
      data: toLearnerImageChoiceQuizData(row.data),
    };
  }
  if (row?.block_type === 'la_scenario_chat') {
    return {
      ...row,
      data: toLearnerScenarioChatData(row.data),
    };
  }
  return row;
}

export function safeJsonParse(value: string): any {
  try { return JSON.parse(value); } catch { return null; }
}

export function mediaQuizModeValue(raw: unknown, fallback: 'single_select' | 'multiple_select'): 'single_select' | 'multiple_select' {
  return raw === 'single_select' || raw === 'multiple_select' ? raw : fallback;
}

export function toLearnerMediaQuizData(raw: any) {
  const data = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!data || typeof data !== 'object') return data;
  const mode = mediaQuizModeValue(data.mode, 'single_select');
  const questions = Array.isArray(data.questions)
    ? data.questions.map((question: any, questionIndex: number) => ({
        id: typeof question?.id === 'string' ? question.id : `q_${questionIndex + 1}`,
        mode: mediaQuizModeValue(question?.mode, mode),
        prompt_html: typeof question?.prompt_html === 'string' ? question.prompt_html : '',
        explanation_html: typeof question?.explanation_html === 'string' ? question.explanation_html : '',
        hints: Array.isArray(question?.hints)
          ? question.hints
              .filter((hint: unknown): hint is string => typeof hint === 'string' && hint.trim().length > 0)
              .slice(0, 10)
          : [],
        media: question?.media && typeof question.media === 'object'
          ? {
              type: question.media.type === 'video' ? 'video' : 'image',
              storage_path: typeof question.media.storage_path === 'string' ? question.media.storage_path : '',
              alt: typeof question.media.alt === 'string' ? question.media.alt : '',
            }
          : null,
        choices: Array.isArray(question?.choices)
          ? question.choices.map((choice: any, choiceIndex: number) => ({
              id: typeof choice?.id === 'string' ? choice.id : `choice_${choiceIndex}`,
              html: typeof choice?.html === 'string' ? choice.html : '',
            }))
          : [],
      }))
    : [];
  return {
    version: 1,
    mode,
    require_correct_to_advance: true,
    questions,
  };
}

export function toLearnerImageChoiceQuizData(raw: any) {
  const data = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!data || typeof data !== 'object') return data;
  const choices = Array.isArray(data.choices)
    ? data.choices.slice(0, 4).map((choice: any, choiceIndex: number) => ({
        id: typeof choice?.id === 'string' ? choice.id : `choice_${choiceIndex + 1}`,
        html: typeof choice?.html === 'string' ? choice.html : '',
        image: {
          storage_path: typeof choice?.image?.storage_path === 'string' ? choice.image.storage_path : '',
          alt: typeof choice?.image?.alt === 'string' ? choice.image.alt : '',
        },
      }))
    : [];

  return {
    version: 1,
    prompt_html: typeof data.prompt_html === 'string' ? data.prompt_html : '',
    hints: Array.isArray(data.hints)
      ? data.hints
          .filter((hint: unknown): hint is string => typeof hint === 'string' && hint.trim().length > 0)
          .slice(0, 10)
      : [],
    choices,
  };
}

export function scenarioChatString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

export function learnerScenarioChatContextDescription(data: any): string {
  if (typeof data?.context_description === 'string') return scenarioChatString(data.context_description);
  if (typeof data?.status_line === 'string') return scenarioChatString(data.status_line);
  if (!Array.isArray(data?.rounds)) return '';

  for (const round of data.rounds) {
    const value = scenarioChatString(round?.status_line).trim();
    if (value) return value;
  }

  return '';
}

export function toLearnerScenarioChatData(raw: any) {
  const data = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!data || typeof data !== 'object') return data;
  const rounds = Array.isArray(data.rounds)
    ? data.rounds.map((round: any, roundIndex: number) => ({
        id: scenarioChatString(round?.id) || `round_${roundIndex + 1}`,
        scenario_message: {
          text: scenarioChatString(round?.scenario_message?.text),
          description: scenarioChatString(round?.scenario_message?.description),
        },
        choices: Array.isArray(round?.choices)
          ? round.choices.slice(0, 3).map((choice: any, choiceIndex: number) => ({
              id: scenarioChatString(choice?.id) || `choice_${choiceIndex + 1}`,
              text: scenarioChatString(choice?.text),
            }))
          : [],
      }))
    : [];

  return {
    version: 1,
    context_description: learnerScenarioChatContextDescription(data),
    participant: {
      name: scenarioChatString(data.participant?.name) || 'Nhân vật tình huống',
      description: scenarioChatString(data.participant?.description),
    },
    learner: {
      name: scenarioChatString(data.learner?.name) || 'Bạn',
      description: scenarioChatString(data.learner?.description),
    },
    rounds,
  };
}
