// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { env } from '../../../../config/env.js';

export const GEMINI_MODEL = env.GEMINI_CHAT_MODEL;
export const MAX_PROPOSAL_CHAPTERS = 1;
export const MAX_BLUEPRINT_CHAPTERS = 12;
export const MAX_BLUEPRINT_LESSONS_PER_CHAPTER = 12;
export const MAX_COMPACT_BLUEPRINT_LESSONS_PER_CHAPTER = 6;
export const MAX_COMPACT_BLUEPRINT_UNITS_PER_LESSON = 3;
export const MAX_COMPACT_BLUEPRINT_COMPONENTS_PER_UNIT = 3;
export const MAX_COMPACT_BLUEPRINT_TOTAL_LESSONS = 24;
export const MAX_COMPACT_BLUEPRINT_TOTAL_UNITS = 24;
export const MAX_COMPACT_BLUEPRINT_TOTAL_COMPONENTS = 72;
export const MAX_COMPACT_BLUEPRINT_MEDIA_PLANS = 12;
export const MAX_BLUEPRINT_LEARNING_OUTCOMES = 12;
export const MAX_BLUEPRINT_ASSUMPTIONS = 8;
export const MAX_PROPOSAL_LESSONS = 30;
export const MAX_PROPOSAL_UNITS = 80;
export const MAX_PROPOSAL_COMPONENTS = 160;
export const MAX_COMPONENTS_PER_UNIT = 4;
export const MAX_UNIT_HTML_CHARS = 20_000;
export const MIN_UNIT_HTML_TEXT_CHARS = 180;
export const MAX_SOURCE_DOCUMENTS = 5;
export const MAX_SOURCE_DOCUMENT_EXCERPT_CHARS = 2400;
export const MAX_STORED_LESSON_AUTHOR_PROMPT_CHARS = 12_000;
