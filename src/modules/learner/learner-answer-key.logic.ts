// ═══════════════════════════════════════════════════════════════
// Learner answer keys — what a learner may NOT receive before answering
//
// Grading is server-side (POST /api/learner/blocks/:id/submit reads the
// published block from the database), so the learner payload never needs the
// answer key:
//   - problem (OLX): `correct` / `answer` attributes, <solution>, per-choice
//     hints, tolerance, additional answers and scripts are removed;
//   - crossword: every word keeps its length, never its answer;
//   - sortable: items are sent in a stable shuffled order with opaque ids
//     (the stored order is the answer key and the ids were 1..N in order).
// The explanation (<solution>) is returned by the submit endpoint only after
// a correct answer.
// ═══════════════════════════════════════════════════════════════

import { createHmac } from 'crypto';
import { env } from '../../config/env.js';

/** Part of the learner block cache keys: bump when the learner payload shape changes. */
export const LEARNER_BLOCK_SERIALIZATION_VERSION = 'answer-keys-hidden-v1';

const PROBLEM_ANSWER_ELEMENTS = [
  'solution', 'choicehint', 'optionhint', 'correcthint', 'compoundhint', 'stringequalhint',
  'numericalhint', 'additional_answer', 'responseparam', 'script', 'answer',
];
const PROBLEM_ANSWER_ATTRIBUTE_TAGS = [
  'choice', 'option', 'optioninput', 'stringresponse', 'numericalresponse', 'formularesponse', 'customresponse',
];

const PAIRED_ELEMENT = new RegExp(`<(${PROBLEM_ANSWER_ELEMENTS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const SELF_CLOSING_ELEMENT = new RegExp(`<(?:${PROBLEM_ANSWER_ELEMENTS.join('|')})\\b[^>]*\\/>`, 'gi');
const ANSWER_ATTRIBUTE = new RegExp(
  `(<(?:${PROBLEM_ANSWER_ATTRIBUTE_TAGS.join('|')})\\b[^>]*?)\\s+(?:correct|answer)\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
  'gi',
);

/** Problem OLX as a learner may see it: no answer key, no solution. */
export function toLearnerProblemOlx(olx: string): string {
  let next = olx.replace(PAIRED_ELEMENT, '').replace(SELF_CLOSING_ELEMENT, '');
  for (let previous = ''; previous !== next;) {
    previous = next;
    next = next.replace(ANSWER_ATTRIBUTE, '$1');
  }
  return next;
}

/** The explanation of a problem (<solution> content), shown after a correct answer. */
export function problemExplanationHtml(olx: string): string {
  const solution = /<solution\b[^>]*>([\s\S]*?)<\/solution\s*>/i.exec(olx)?.[1] ?? '';
  const detailed = /<div\b[^>]*class\s*=\s*["'][^"']*\bdetailed-solution\b[^"']*["'][^>]*>([\s\S]*)<\/div\s*>/i.exec(solution)?.[1];
  return (detailed ?? solution).trim();
}

function parseMaybeJson(value: unknown): { parsed: any; wasString: boolean } {
  if (typeof value !== 'string') return { parsed: value, wasString: false };
  try { return { parsed: JSON.parse(value), wasString: true }; } catch { return { parsed: null, wasString: true }; }
}

function withSameEncoding(value: unknown, wasString: boolean): unknown {
  return wasString ? JSON.stringify(value) : value;
}

function crosswordWordWithoutAnswer(word: any): any {
  if (!word || typeof word !== 'object') return word;
  const { answer, ...rest } = word;
  const length = typeof answer === 'string' && answer.length > 0
    ? answer.length
    : (Number.isInteger(rest.length) && rest.length > 0 ? rest.length : 0);
  return { ...rest, length };
}

/** Crossword data (`{ words, keyword_coordinates, ... }`) with lengths instead of answers. */
export function toLearnerCrosswordData(value: unknown): unknown {
  const { parsed, wasString } = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.words)) return value;
  return withSameEncoding({ ...parsed, words: parsed.words.map(crosswordWordWithoutAnswer) }, wasString);
}

function answerKeySecret(): string {
  return env.JWT_SECRET;
}

/** Opaque, stable id of one sortable item (cannot be ordered back to 1..N). */
export function sortableOpaqueItemId(blockId: string, itemId: unknown, secret = answerKeySecret()): string {
  return `s_${createHmac('sha256', secret).update(`sortable-item:${blockId}:${String(itemId)}`).digest('hex').slice(0, 20)}`;
}

/** Sortable data (`{ items, ... }`) in a stable shuffled order with opaque ids. */
export function toLearnerSortableData(value: unknown, blockId: string, secret = answerKeySecret()): unknown {
  const { parsed, wasString } = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return value;
  const items = parsed.items
    .map((item: any) => {
      if (!item || typeof item !== 'object') return item;
      const opaque = sortableOpaqueItemId(blockId, item.id, secret);
      return { ...item, id: opaque };
    })
    // Sorting by the opaque id is a stable permutation unrelated to the answer.
    .sort((a: any, b: any) => String(a?.id).localeCompare(String(b?.id)));
  return withSameEncoding({ ...parsed, items }, wasString);
}

/** Maps a submitted order (opaque ids, or the stored ids of an older client) to stored ids. */
export function resolveSortableSubmission(blockId: string, storedItemIds: unknown[], submitted: unknown[], secret = answerKeySecret()): unknown[] {
  const byOpaque = new Map(storedItemIds.map((id) => [sortableOpaqueItemId(blockId, id, secret), id]));
  return submitted.map((value) => (typeof value === 'string' && byOpaque.has(value) ? byOpaque.get(value) : value));
}
