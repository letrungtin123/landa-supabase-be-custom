// ═══════════════════════════════════════════════════════════════
// Course block defaults: the name, data and metadata a new block starts with,
// per block type and UI locale. Pure; moved unchanged from
// course-authoring.service.ts.
// ═══════════════════════════════════════════════════════════════

import { getDefaultProblemXml, type CourseComponentLocale } from './course-authoring-problem-defaults.logic.js';

export function getDefaultName(blockType: string, locale: CourseComponentLocale): string {
  const names: Record<CourseComponentLocale, Record<string, string>> = {
    en: {
      chapter: 'New chapter',
      sequential: 'New lesson',
      vertical: 'New unit',
      video: 'Video',
      html: 'Text',
      problem: 'Question',
      la_media_quiz: 'Media quiz',
      la_image_choice_quiz: 'Image-choice question',
      la_scenario_chat: 'Scenario conversation',
      la_crossword: 'Crossword challenge',
      la_sortable: 'Sorting exercise',
      la_diagram: 'Diagram',
      la_faq: 'FAQ',
      la_pdf: 'PDF',
    },
    vi: {
    chapter: 'Chương mới',
    sequential: 'Bài học mới',
    vertical: 'Unit mới',
    video: 'Video',
    html: 'Văn bản',
    problem: 'Câu hỏi',
    la_media_quiz: 'Câu hỏi kèm media',
    la_image_choice_quiz: 'Câu hỏi đáp án hình ảnh',
    la_scenario_chat: 'Giao tiếp tình huống',
    la_crossword: 'Đố vui ô chữ',
    la_sortable: 'sắp xếp ô chữ',
    la_diagram: 'Biểu đồ',
    la_faq: 'FAQ',
    la_pdf: 'PDF',
    },
  };
  return names[locale][blockType] ?? (locale === 'en' ? 'New block' : 'Block mới');
}

function mediaQuizModeFromBoilerplate(boilerplate?: string): 'single_select' | 'multiple_select' {
  return boilerplate === 'media_quiz_multiple_select' ? 'multiple_select' : 'single_select';
}

export function mediaQuizModeValue(raw: unknown, fallback: 'single_select' | 'multiple_select'): 'single_select' | 'multiple_select' {
  return raw === 'single_select' || raw === 'multiple_select' ? raw : fallback;
}

function makeDefaultImageChoiceQuizChoice(
  index: number,
  correct: boolean,
  locale: CourseComponentLocale,
) {
  const labels = locale === 'en'
    ? { correct: 'Correct answer', incorrect: `Incorrect answer ${index}` }
    : { correct: 'Đáp án đúng', incorrect: `Đáp án sai ${index}` };
  return {
    id: `choice_${index + 1}`,
    html: `<p>${correct ? labels.correct : labels.incorrect}</p>`,
    correct,
    image: {
      storage_path: '',
      alt: '',
    },
  };
}

export function getDefaultData(
  blockType: string,
  boilerplate: string | undefined,
  locale: CourseComponentLocale,
): any {
  // Manual Course Studio passes a boilerplate for its five explicit Problem
  // choices. Keeping the legacy empty-data path when no boilerplate is sent
  // prevents this UI correction from changing AI-generated block behaviour.
  if (blockType === 'problem' && boilerplate) {
    return getDefaultProblemXml(boilerplate, locale);
  }

  if (blockType === 'la_image_choice_quiz') {
    const labels = locale === 'en'
      ? { question: 'Your question' }
      : { question: 'Câu hỏi của bạn' };
    return {
      version: 1,
      prompt_html: `<p>${labels.question}</p>`,
      explanation_html: '',
      hints: [],
      choices: [
        makeDefaultImageChoiceQuizChoice(0, true, locale),
        makeDefaultImageChoiceQuizChoice(1, false, locale),
      ],
    };
  }

  if (blockType === 'la_scenario_chat') {
    const labels = locale === 'en'
      ? {
        participantName: 'Scenario character',
        participantDescription: 'The other person in this scenario',
        learnerName: 'You',
        learnerDescription: 'Learner',
        context: 'The situation begins',
        scenarioText: 'Hello, I need to discuss this situation with you.',
        scenarioDescription: 'Choose the most appropriate response.',
        correctChoice: 'Appropriate response',
        correctResponse: 'Thank you. This response fits the situation.',
        responseDescription: 'Character response',
        correctExplanation: 'This answer is correct because it shows an appropriate attitude and content for the communication goal.',
        incorrectChoiceOne: 'Less appropriate response 1',
        incorrectResponseOne: 'This response may lead the conversation in the wrong direction.',
        incorrectExplanationOne: 'This answer is not quite right. Choose a clearer and more appropriate response.',
        incorrectChoiceTwo: 'Less appropriate response 2',
        incorrectResponseTwo: 'I did not receive the information needed from this response.',
        incorrectExplanationTwo: 'This answer is not quite right because it does not address the core of the situation.',
      }
      : {
        participantName: 'Nhân vật tình huống',
        participantDescription: 'Người đối thoại trong kịch bản',
        learnerName: 'Bạn',
        learnerDescription: 'Học viên',
        context: 'Tình huống bắt đầu',
        scenarioText: 'Chào bạn, tôi cần trao đổi với bạn về tình huống này.',
        scenarioDescription: 'Hãy chọn phản hồi phù hợp nhất.',
        correctChoice: 'Phản hồi phù hợp',
        correctResponse: 'Cảm ơn bạn, cách phản hồi này phù hợp với tình huống.',
        responseDescription: 'Phản hồi của nhân vật',
        correctExplanation: 'Đáp án này đúng vì thể hiện thái độ và nội dung phù hợp với mục tiêu giao tiếp.',
        incorrectChoiceOne: 'Phản hồi chưa phù hợp 1',
        incorrectResponseOne: 'Cách phản hồi này có thể khiến cuộc trao đổi đi sai hướng.',
        incorrectExplanationOne: 'Đáp án này chưa đúng. Hãy chọn cách phản hồi rõ ràng và phù hợp hơn.',
        incorrectChoiceTwo: 'Phản hồi chưa phù hợp 2',
        incorrectResponseTwo: 'Tôi chưa nhận được thông tin cần thiết từ câu trả lời này.',
        incorrectExplanationTwo: 'Đáp án này chưa đúng vì chưa xử lý trọng tâm của tình huống.',
      };
    return {
      version: 1,
      participant: {
        name: labels.participantName,
        description: labels.participantDescription,
      },
      learner: {
        name: labels.learnerName,
        description: labels.learnerDescription,
      },
      context_description: labels.context,
      rounds: [
        {
          id: 'round_1',
          scenario_message: {
            text: labels.scenarioText,
            description: labels.scenarioDescription,
          },
          choices: [
            {
              id: 'choice_1',
              text: labels.correctChoice,
              correct: true,
              response_message: labels.correctResponse,
              response_description: labels.responseDescription,
              character_status: '',
              explanation: labels.correctExplanation,
            },
            {
              id: 'choice_2',
              text: labels.incorrectChoiceOne,
              correct: false,
              response_message: labels.incorrectResponseOne,
              response_description: labels.responseDescription,
              character_status: '',
              explanation: labels.incorrectExplanationOne,
            },
            {
              id: 'choice_3',
              text: labels.incorrectChoiceTwo,
              correct: false,
              response_message: labels.incorrectResponseTwo,
              response_description: labels.responseDescription,
              character_status: '',
              explanation: labels.incorrectExplanationTwo,
            },
          ],
        },
      ],
    };
  }

  if (blockType !== 'la_media_quiz') return {};
  const mode = mediaQuizModeFromBoilerplate(boilerplate);
  const labels = locale === 'en'
    ? {
      question: 'Question 1',
      correct: 'Correct answer',
      incorrect: 'Incorrect answer',
      additionalCorrect: 'Another correct answer',
    }
    : {
      question: 'Câu hỏi 1',
      correct: 'Đáp án đúng',
      incorrect: 'Đáp án sai',
      additionalCorrect: 'Một đáp án đúng khác',
    };
  return {
    version: 1,
    mode,
    require_correct_to_advance: true,
    questions: [
      {
        id: 'q1',
        mode,
        prompt_html: `<p>${labels.question}</p>`,
        explanation_html: '',
        hints: [],
        media: null,
        choices: [
          { id: 'choice_0', html: `<p>${labels.correct}</p>`, correct: true },
          { id: 'choice_1', html: `<p>${labels.incorrect}</p>`, correct: false },
          ...(mode === 'multiple_select'
            ? [{ id: 'choice_2', html: `<p>${labels.additionalCorrect}</p>`, correct: true }]
            : []),
        ],
      },
    ],
  };
}

export function getDefaultMetadata(blockType: string, boilerplate?: string): Record<string, unknown> {
  if (blockType !== 'la_media_quiz') return {};
  return { media_quiz_mode: mediaQuizModeFromBoilerplate(boilerplate) };
}
