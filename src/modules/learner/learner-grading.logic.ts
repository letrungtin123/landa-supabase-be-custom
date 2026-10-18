// ═══════════════════════════════════════════════════════════════
// Learner answer grading: the server-side grading of a submitted block
// answer (problem OLX in its five types, media quiz, image choice, scenario
// chat, crossword, sortable). Pure: no I/O. Moved from learner.service.ts
// with the same rules, messages and answer shapes; the submission is read
// field by field exactly as before (a missing body still fails the same way).
// ═══════════════════════════════════════════════════════════════

import { mediaQuizModeValue, safeJsonParse, scenarioChatString } from './learner-block-row.logic.js';
import { problemExplanationHtml, resolveSortableSubmission } from './learner-answer-key.logic.js';

/** A JSON object read field by field (the client's submission, a block's data). */
type Fields = Record<string, unknown>;
type Maybe<T> = T | null | undefined;

/** The published block being answered: the row of the block lookup. */
export interface GradedBlock {
  id: unknown;
  block_type: unknown;
  data: unknown;
  metadata: unknown;
}

interface ChoiceFields {
  id?: unknown;
  correct?: unknown;
}

interface MediaQuizQuestion {
  id?: unknown;
  mode?: unknown;
  choices?: unknown;
  explanation_html?: unknown;
}

interface ScenarioChoice extends ChoiceFields {
  response_message?: unknown;
  response_description?: unknown;
  character_status?: unknown;
  explanation?: unknown;
}

interface ScenarioRound {
  id?: unknown;
  choices?: unknown;
}

type UserAnswers = Record<string, string | string[]>;

/** The answer to POST /api/learner/blocks/:blockId/submit for this block and submission. */
export function gradeBlockAnswer(block: GradedBlock, body: unknown) {
  const submission = body as Fields;
  switch (block.block_type) {
    case 'problem':
      return gradeProblem(block, (submission.answers || {}) as UserAnswers);

    case 'la_media_quiz':
      return gradeMediaQuiz(block, body);

    case 'la_image_choice_quiz':
      return gradeImageChoiceQuiz(block, body);

    case 'la_scenario_chat':
      return gradeScenarioChat(block, body);

    case 'la_crossword':
      return gradeCrossword(block, (submission.answers || {}) as Record<string, string>);

    case 'la_sortable':
      return gradeSortable(block, Array.isArray(submission.answer) ? submission.answer : []);

    default:
      return {
        status: 'ok',
        message: 'Block type không hỗ trợ submit',
        feedback: submitFeedback('unsupported_block_type'),
        score: 0,
      };
  }
}

/** Grade problem block — parse OLX XML, support all 5 problem types */
type SubmitFeedbackCode =
  | 'correct'
  | 'incorrect'
  | 'partial_answers'
  | 'partial_words'
  | 'partial_positions'
  | 'content_unavailable'
  | 'question_not_found'
  | 'round_not_found'
  | 'answer_not_found'
  | 'missing_correct_answer'
  | 'unsupported_problem_type'
  | 'unsupported_block_type';

function submitFeedback(
  code: SubmitFeedbackCode,
  params?: Record<string, number>,
) {
  return params && Object.keys(params).length > 0 ? { code, params } : { code };
}

function normalizeMediaQuizAnswer(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return Array.from(new Set(
    values
      .map(value => typeof value === 'string' ? value.trim() : String(value ?? '').trim())
      .filter(Boolean),
  ));
}

/** The block's data: JSON text parsed, else the stored value. */
function blockJsonData<T>(block: GradedBlock): Maybe<T> {
  return (typeof block.data === 'string' ? safeJsonParse(block.data) : block.data) as Maybe<T>;
}

function gradeMediaQuiz(block: GradedBlock, body: unknown) {
  const data = blockJsonData<{ questions?: unknown; mode?: unknown }>(block);
  if (!data || typeof data !== 'object' || !Array.isArray(data.questions)) {
    return { status: 'error', message: 'Câu hỏi kèm media chưa có dữ liệu câu hỏi', feedback: submitFeedback('content_unavailable'), score: 0 };
  }
  const questions = data.questions as Array<Maybe<MediaQuizQuestion>>;
  const submission = body as Maybe<Fields>;

  const questionId = typeof submission?.question_id === 'string' ? submission.question_id : '';
  const questionIndex = questions.findIndex(question => question?.id === questionId);
  if (questionIndex < 0) {
    return { status: 'error', message: 'Không tìm thấy câu hỏi', feedback: submitFeedback('question_not_found'), score: 0 };
  }

  const question = questions[questionIndex];
  const mode = mediaQuizModeValue(question?.mode, mediaQuizModeValue(data.mode, 'single_select'));
  const choices = (Array.isArray(question?.choices) ? question.choices : []) as Array<Maybe<ChoiceFields>>;
  const correctSet = new Set<string>(
    choices
      .filter(choice => choice?.correct === true)
      .map(choice => String(choice!.id)),
  );
  if (correctSet.size === 0) {
    return { status: 'error', message: 'Câu hỏi chưa có đáp án đúng', feedback: submitFeedback('missing_correct_answer'), score: 0, question_id: questionId };
  }

  const answers = submission?.answers as Maybe<Fields>;
  const answerSource = submission?.answer ?? answers?.[questionId] ?? submission?.answers;
  const submitted = normalizeMediaQuizAnswer(answerSource);
  const submittedSet = new Set<string>(mode === 'single_select' ? submitted.slice(0, 1) : submitted);
  const isCorrect = submittedSet.size === correctSet.size
    && [...correctSet].every(answer => submittedSet.has(answer));
  const isLastQuestion = questionIndex >= questions.length - 1;
  const nextQuestion = questions[questionIndex + 1];

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác! Media tiếp theo đã được mở.' : 'Chưa đúng, hãy thử lại.',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    question_id: questionId,
    completed: isCorrect && isLastQuestion,
    next_question_id: isCorrect && nextQuestion?.id ? nextQuestion.id : null,
    explanation_html: isCorrect && typeof question?.explanation_html === 'string' ? question.explanation_html : undefined,
    correctness: { [questionId]: isCorrect ? 'correct' : 'incorrect' },
  };
}

function gradeImageChoiceQuiz(block: GradedBlock, body: unknown) {
  const data = blockJsonData<{ choices?: unknown; explanation_html?: unknown }>(block);
  if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) {
    return { status: 'error', message: 'Câu hỏi đáp án hình ảnh chưa có dữ liệu', feedback: submitFeedback('content_unavailable'), score: 0 };
  }
  const submission = body as Maybe<Fields>;

  const answerFromMap = submission?.answers && typeof submission.answers === 'object'
    ? Object.values(submission.answers)[0]
    : undefined;
  const choiceIdField = submission?.choice_id;
  const answerField = submission?.answer;
  const choiceId = typeof choiceIdField === 'string'
    ? choiceIdField.trim()
    : typeof answerField === 'string'
      ? answerField.trim()
      : typeof answerFromMap === 'string'
        ? answerFromMap.trim()
        : '';

  const choices = (data.choices as Array<Maybe<ChoiceFields>>).slice(0, 4);
  const choice = choices.find(item => item?.id === choiceId);
  if (!choice) {
    return { status: 'error', message: 'Không tìm thấy đáp án', feedback: submitFeedback('answer_not_found'), score: 0 };
  }

  const isCorrect = choice.correct === true;
  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, hãy thử lại.',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    choice_id: choiceId,
    completed: isCorrect,
    explanation_html: isCorrect && typeof data.explanation_html === 'string' ? data.explanation_html : undefined,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
  };
}

function gradeScenarioChat(block: GradedBlock, body: unknown) {
  const data = blockJsonData<{ rounds?: unknown }>(block);
  if (!data || typeof data !== 'object' || !Array.isArray(data.rounds)) {
    return { status: 'error', message: 'Giao tiếp tình huống chưa có dữ liệu', feedback: submitFeedback('content_unavailable'), score: 0 };
  }
  const rounds = data.rounds as Array<Maybe<ScenarioRound>>;
  const submission = body as Maybe<Fields>;

  const roundId = typeof submission?.round_id === 'string' ? submission.round_id : '';
  const choiceId = typeof submission?.choice_id === 'string' ? submission.choice_id : '';
  const roundIndex = rounds.findIndex(round => round?.id === roundId);
  if (roundIndex < 0) {
    return { status: 'error', message: 'Không tìm thấy lượt hội thoại', feedback: submitFeedback('round_not_found'), score: 0 };
  }

  const round = rounds[roundIndex];
  const choices = (Array.isArray(round?.choices) ? round.choices : []) as Array<Maybe<ScenarioChoice>>;
  const choice = choices.find(item => item?.id === choiceId);
  if (!choice) {
    return { status: 'error', message: 'Không tìm thấy câu trả lời', feedback: submitFeedback('answer_not_found'), score: 0, round_id: roundId };
  }

  const isCorrect = choice.correct === true;
  const nextRound = isCorrect ? rounds[roundIndex + 1] : null;
  const completed = isCorrect && roundIndex >= rounds.length - 1;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, hãy thử lại.',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    round_id: roundId,
    choice_id: choiceId,
    completed,
    next_round_id: isCorrect && nextRound?.id ? nextRound.id : null,
    response_message: scenarioChatString(choice.response_message),
    response_description: scenarioChatString(choice.response_description),
    character_status: scenarioChatString(choice.character_status),
    explanation: scenarioChatString(choice.explanation),
    correctness: { [roundId]: isCorrect ? 'correct' : 'incorrect' },
  };
}

/** Correct answers and the explanation are disclosed only after a correct answer. */
function withAnswerDisclosure<T extends { status?: string; correct_answers?: unknown }>(result: T, data: string): T & { explanation_html?: string } {
  if (result.status !== 'correct') {
    const { correct_answers: _hidden, ...rest } = result;
    return rest as T;
  }
  const explanation = problemExplanationHtml(data);
  return explanation ? { ...result, explanation_html: explanation } : result;
}

function gradeProblem(block: GradedBlock, userAnswers: UserAnswers) {
  const data = typeof block.data === 'string' ? block.data : '';
  return withAnswerDisclosure(gradeProblemOlx(data, userAnswers), data);
}

function gradeProblemOlx(data: string, userAnswers: UserAnswers) {
  if (!data) return { status: 'error', message: 'Không có dữ liệu câu hỏi', feedback: submitFeedback('content_unavailable'), correctness: {} };

  // ── 1. multiplechoiceresponse (single-select radio) ──
  if (data.includes('<multiplechoiceresponse') || (data.includes('<choicegroup') && !data.includes('<checkboxgroup'))) {
    return gradeMultipleChoice(data, userAnswers);
  }

  // ── 2. choiceresponse (multi-select checkbox) ──
  if (data.includes('<choiceresponse') || data.includes('<checkboxgroup')) {
    return gradeCheckbox(data, userAnswers);
  }

  // ── 3. optionresponse (dropdown) ──
  if (data.includes('<optionresponse')) {
    return gradeDropdown(data, userAnswers);
  }

  // ── 4. stringresponse (text input) ──
  if (data.includes('<stringresponse')) {
    return gradeStringInput(data, userAnswers);
  }

  // ── 5. numericalresponse (number input) ──
  if (data.includes('<numericalresponse')) {
    return gradeNumericalInput(data, userAnswers);
  }

  return { status: 'error', message: 'Loại câu hỏi chưa được hỗ trợ', feedback: submitFeedback('unsupported_problem_type'), correctness: {} };
}

/** 1. Single-select (radio) */
function gradeMultipleChoice(data: string, userAnswers: UserAnswers) {
  const choiceMatches = [...data.matchAll(/<choice\s+correct="(true|false)"[^>]*>(.*?)<\/choice>/gi)];
  if (choiceMatches.length === 0) return { status: 'error', message: 'Không tìm thấy đáp án', feedback: submitFeedback('answer_not_found'), correctness: {} };

  const correctIndices: string[] = [];
  const choiceTexts: Record<string, string> = {};
  choiceMatches.forEach((m, i) => {
    const id = `choice_${i}`;
    choiceTexts[id] = m[2];
    if (m[1] === 'true') correctIndices.push(id);
  });

  const userAnswer = Object.values(userAnswers)[0];
  const userStr = Array.isArray(userAnswer) ? userAnswer[0] : String(userAnswer || '');

  const isCorrect = correctIndices.includes(userStr) ||
    choiceMatches.some(m => m[1] === 'true' && m[2] === userStr);

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: correctIndices.map(id => choiceTexts[id]),
  };
}

/** 2. Multi-select (checkbox) */
function gradeCheckbox(data: string, userAnswers: UserAnswers) {
  const choiceMatches = [...data.matchAll(/<choice\s+correct="(true|false)"[^>]*>(.*?)<\/choice>/gi)];
  if (choiceMatches.length === 0) return { status: 'error', message: 'Không tìm thấy đáp án', feedback: submitFeedback('answer_not_found'), correctness: {} };

  const correctSet = new Set<string>();
  const choiceTexts: Record<string, string> = {};
  choiceMatches.forEach((m, i) => {
    const id = `choice_${i}`;
    choiceTexts[id] = m[2];
    if (m[1] === 'true') correctSet.add(id);
  });

  // FE sends { "olx_multi_0": ["choice_0", "choice_1", ...] }
  const userVal = Object.values(userAnswers)[0];
  const userSelected = new Set(Array.isArray(userVal) ? userVal : [String(userVal || '')]);

  // Check exact match
  const isCorrect = correctSet.size === userSelected.size &&
    [...correctSet].every(id => userSelected.has(id));

  const correctCount = [...correctSet].filter(id => userSelected.has(id)).length;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : `Đúng ${correctCount}/${correctSet.size} đáp án. Thử lại nhé!`,
    feedback: submitFeedback(isCorrect ? 'correct' : 'partial_answers', isCorrect ? undefined : { correct: correctCount, total: correctSet.size }),
    score: Math.round((correctCount / correctSet.size) * 100),
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [...correctSet].map(id => choiceTexts[id]),
  };
}

/** 3. Dropdown (optionresponse) */
function gradeDropdown(data: string, userAnswers: UserAnswers) {
  const correctMatch = data.match(/<optioninput[^>]*\scorrect="([^"]+)"/i);
  let correctAnswer = correctMatch ? correctMatch[1] : '';

  if (!correctAnswer) {
    const optionMatches = [...data.matchAll(/<option\s+[^>]*correct="(true|false)"[^>]*>([\s\S]*?)<\/option>/gi)];
    const correctOption = optionMatches.find(m => m[1].toLowerCase() === 'true');
    correctAnswer = correctOption ? correctOption[2].replace(/<[^>]+>/g, '').trim() : '';
  }

  if (!correctAnswer) return { status: 'error', message: 'Không tìm thấy đáp án đúng', feedback: submitFeedback('missing_correct_answer'), correctness: {} };

  const userVal = Object.values(userAnswers)[0];
  const userStr = Array.isArray(userVal) ? userVal[0] : String(userVal || '');

  // FE sends option text directly (id = text for dropdown)
  const isCorrect = userStr === correctAnswer;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [correctAnswer],
  };
}

/** 4. String input (stringresponse) */
function gradeStringInput(data: string, userAnswers: UserAnswers) {
  // Parse correct answer and type from <stringresponse answer="..." type="ci|cs">
  const answerMatch = data.match(/<stringresponse\s+answer="([^"]+)"[^>]*/i);
  const correctAnswer = answerMatch ? answerMatch[1] : '';
  const isCaseInsensitive = data.includes('type="ci"');

  if (!correctAnswer) return { status: 'error', message: 'Không tìm thấy đáp án đúng', feedback: submitFeedback('missing_correct_answer'), correctness: {} };

  const userVal = Object.values(userAnswers)[0];
  const userStr = Array.isArray(userVal) ? userVal[0] : String(userVal || '');

  const isCorrect = isCaseInsensitive
    ? userStr.toLowerCase().trim() === correctAnswer.toLowerCase().trim()
    : userStr.trim() === correctAnswer.trim();

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [correctAnswer],
  };
}

/** 5. Numerical input (numericalresponse) */
function gradeNumericalInput(data: string, userAnswers: UserAnswers) {
  // Parse correct answer from <numericalresponse answer="...">
  const answerMatch = data.match(/<numericalresponse\s+answer="([^"]+)"/i);
  const correctAnswer = answerMatch ? parseFloat(answerMatch[1]) : NaN;

  // Parse tolerance from <responseparam type="tolerance" default="..."/>
  const tolMatch = data.match(/<responseparam\s+type="tolerance"\s+default="([^"]+)"/i);
  const tolerance = tolMatch ? parseFloat(tolMatch[1]) : 0;

  if (isNaN(correctAnswer)) return { status: 'error', message: 'Không tìm thấy đáp án đúng', feedback: submitFeedback('missing_correct_answer'), correctness: {} };

  const userVal = Object.values(userAnswers)[0];
  const userNum = parseFloat(Array.isArray(userVal) ? userVal[0] : String(userVal || ''));

  const isCorrect = !isNaN(userNum) && Math.abs(userNum - correctAnswer) <= tolerance;

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect ? 'Chính xác!' : 'Chưa đúng, thử lại nhé!',
    feedback: submitFeedback(isCorrect ? 'correct' : 'incorrect'),
    score: isCorrect ? 100 : 0,
    correctness: { answer: isCorrect ? 'correct' : 'incorrect' },
    correct_answers: [String(correctAnswer)],
  };
}

/** Grade crossword block — so sánh từng word answer */
function gradeCrossword(block: GradedBlock, userAnswers: Record<string, string>) {
  const meta = (block.metadata || {}) as { crossword_data?: { words?: unknown } };
  const cd = meta.crossword_data || {};
  const words = (cd.words || []) as Array<{ id?: unknown; answer?: string }>;

  if (words.length === 0) {
    return { status: 'error', message: 'Không có dữ liệu ô chữ', feedback: submitFeedback('content_unavailable'), score: 0 };
  }

  let correct = 0;
  const results: Record<string, boolean> = {};

  for (const word of words) {
    const userAnswer = (userAnswers[String(word.id)] || '').toUpperCase().trim();
    const correctAnswer = (word.answer || '').toUpperCase().trim();
    const isCorrect = userAnswer === correctAnswer;
    results[String(word.id)] = isCorrect;
    if (isCorrect) correct++;
  }

  const score = Math.round((correct / words.length) * 100);

  return {
    status: correct === words.length ? 'correct' : 'incorrect',
    message: correct === words.length
      ? 'Hoàn thành ô chữ!'
      : `Đúng ${correct}/${words.length} từ`,
    feedback: submitFeedback(correct === words.length ? 'correct' : 'partial_words', correct === words.length ? undefined : { correct, total: words.length }),
    score,
    results,
  };
}

/** Grade sortable block — check thứ tự */
function gradeSortable(block: GradedBlock, submittedOrder: unknown[]) {
  const meta = (block.metadata || {}) as { sortable_data?: { items?: unknown } };
  const sd = meta.sortable_data || {};
  const items = (sd.items || []) as Array<{ id?: unknown }>;

  if (items.length === 0) {
    return { status: 'error', message: 'Không có dữ liệu sắp xếp', feedback: submitFeedback('content_unavailable'), score: 0 };
  }

  // Correct order = thứ tự id trong items array (1,2,3,4,5). Learners receive
  // opaque ids in a shuffled order (learner-answer-key.logic.ts).
  const correctOrder = items.map(item => item.id);
  const userOrder = resolveSortableSubmission(String(block.id), correctOrder, submittedOrder);
  const isCorrect = JSON.stringify(userOrder) === JSON.stringify(correctOrder);

  // Count how many are in correct position
  let correctPositions = 0;
  for (let i = 0; i < Math.min(userOrder.length, correctOrder.length); i++) {
    if (userOrder[i] === correctOrder[i]) correctPositions++;
  }

  const score = Math.round((correctPositions / correctOrder.length) * 100);

  return {
    status: isCorrect ? 'correct' : 'incorrect',
    message: isCorrect
      ? 'Sắp xếp đúng thứ tự!'
      : `Đúng ${correctPositions}/${correctOrder.length} vị trí`,
    feedback: submitFeedback(isCorrect ? 'correct' : 'partial_positions', isCorrect ? undefined : { correct: correctPositions, total: correctOrder.length }),
    score,
  };
}
