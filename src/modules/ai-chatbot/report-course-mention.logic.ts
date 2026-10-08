// Which course a report question is about, decided from the tenant's own
// course names (never from an id supplied by the model). Pure: the catalog is
// loaded, tenant-scoped and cached, by report-course-catalog.service.ts.
//
// Order of evidence:
//   1. an explicit reference ("khóa học X", "the X course", a quoted name)
//      naming exactly one catalog course;
//   2. catalog names written in the question as whole tokens ("Customer
//      experience v2 có bao nhiêu học viên?"), the longest one winning;
//   3. the router model's course hint, when it names exactly one course.
// Two different courses tying for the longest match are never guessed: the
// router asks which one was meant. A quoted name, or a reference shared by
// several courses, keeps the snapshot's own name lookup (existing behaviour).

import {
  buildReportUnitWords,
  isReportUnitNameSpan,
  tokenizeQuestion,
  type QuestionToken,
  type ReportGroupLabels,
  type UnitWord,
} from './report-org-unit.logic.js';
import { foldReportText, normalizeReportEntityName, reportEntityTokens, reportTextSimilarity } from './report-text.logic.js';

export interface ReportCatalogCourse {
  id: string;
  name: string;
}

export interface ReportCourseCatalog {
  courses: ReportCatalogCourse[];
  truncated: boolean;
}

export type ReportCourseResolution =
  | { status: 'none' }
  | { status: 'resolved'; course: ReportCatalogCourse; source: 'reference' | 'question' | 'model' }
  | { status: 'ambiguous'; courses: ReportCatalogCourse[] };

export interface ReportCourseReference {
  text: string;
  quoted: boolean;
}

/** Courses listed in one clarification at most. */
export const MAX_REPORT_COURSE_CHOICES = 6;
/** A question that names a course but no period covers the last 12 months. */
export const REPORT_COURSE_DEFAULT_PERIOD_MONTHS = 12;

const NONE: ReportCourseResolution = { status: 'none' };

const COURSE_REFERENCE_PATTERN = /\b(?:kh(?:óa|oá|oa)(?:\s+học)?|course)\s+(?:(?:là|la|về|ve|about)\s+)?(.+?)(?=\s+(?:có|co|bao\s+nhiêu|bao\s+nhieu|số\s+lượng|so\s+luong|số|so|người\s+học|nguoi\s+hoc|học\s+viên|hoc\s+vien|lượt\s+ghi\s+danh|luot\s+ghi\s+danh|enrollments?|learners?|trong|từ|tu|tháng|thang|năm|nam|from|during|in)(?=\s|[?.!,;]|$)|[?.!,;]|$)/iu;
const ENGLISH_TRAILING_COURSE_REFERENCE_PATTERNS = [
  /\b(?:taking|attending|enrolled\s+(?:in|on)|for|about|on)\s+(?:the\s+)?(.+?)\s+course\b/iu,
  /(?:^|[?.!,;]\s*)(?:the\s+)?(.+?)\s+course\b(?=\s+(?:has|have|with|in|from|during|for|enrollments?|learners?|students?)\b|[?.!,;]|$)/iu,
] as const;

/** The course name after "khóa (học)" / before "course", or a quoted name. */
export function findReportCourseReference(question: string): ReportCourseReference | null {
  const quoted = /["“]([^"”]{2,160})["”]/u.exec(question)?.[1]?.trim();
  if (quoted) return { text: quoted, quoted: true };
  const normalizedQuestion = question.replace(/\s+/g, ' ');
  for (const pattern of ENGLISH_TRAILING_COURSE_REFERENCE_PATTERNS) {
    const trailingCourseReference = pattern.exec(normalizedQuestion)?.[1]?.trim();
    if (trailingCourseReference) return { text: trailingCourseReference, quoted: false };
  }
  const leadingCourseReference = COURSE_REFERENCE_PATTERN.exec(normalizedQuestion)?.[1]?.trim();
  return leadingCourseReference ? { text: leadingCourseReference, quoted: false } : null;
}

export function extractReportCourseReference(question: string): string | null {
  return findReportCourseReference(question)?.text ?? null;
}

// Learners, enrollments, progress or completion: what a course detail answers.
const COURSE_QUESTION_CUE = /\b(?:bao nhieu|so luong|so nguoi|nguoi hoc|hoc vien|danh sach|tham gia|hoan thanh|tien do|t[iy] le|ghi danh|dang ky|how many|number of|learners?|students?|participants?|list|who|enrol\w*|complet(?:e|ed|ions?)|progress)\b/;

export function isReportCourseQuestion(question: string): boolean {
  return COURSE_QUESTION_CUE.test(foldReportText(question));
}

// Names made only of these words (or numbers / "v2") are too generic to be
// found in free text: "Test 1", "Khoá học 1", "test final". They still
// resolve when written as an explicit reference ("khóa học Test 1").
const GENERIC_COURSE_TOKENS = new Set([
  'test', 'tests', 'testing', 'demo', 'thu', 'nghiem', 'mau', 'sample', 'example', 'draft', 'copy', 'final', 'new', 'moi', 'ban', 'sao',
  'khoa', 'hoc', 'course', 'courses', 'lop', 'class', 'bai', 'lesson', 'module', 'modun', 'chuong', 'chapter', 'unit',
  'dao', 'tao', 'training', 'bao', 'cao', 'report', 'vien', 'nguoi', 'learner', 'learners', 'student', 'students',
  'version', 'ver', 'phien', 'pilot',
]);
const NUMBER_OR_VERSION = /^(?:v|ver)?\d+$/;
const MIN_SCANNED_NAME_LENGTH = 4;
const TIME_UNIT_TOKENS = new Set([
  'ngay', 'tuan', 'thang', 'nam', 'quy', 'gio', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'quarter', 'quarters',
]);
const TYPO_MIN_NAME_LENGTH = 8;
const TYPO_MIN_TOKEN_LENGTH = 5;
const TYPO_TOKEN_SIMILARITY = 0.8;

interface IndexedCourse {
  course: ReportCatalogCourse;
  tokens: string[];
  text: string;
  /** Token offsets the name itself separates with punctuation ("BiC Modun 1: Change Mindset"). */
  breaks: ReadonlySet<number>;
}

interface Occurrence {
  entry: IndexedCourse;
  start: number;
  end: number;
}

function indexCourses(courses: readonly ReportCatalogCourse[]): IndexedCourse[] {
  return courses.flatMap((course) => {
    const tokens = reportEntityTokens(course.name);
    if (tokens.length === 0) return [];
    const written = tokenizeQuestion(course.name);
    const breaks = new Set(written.length === tokens.length
      ? written.flatMap((token, offset) => (token.breakBefore ? [offset] : []))
      : []);
    return [{ course, tokens, text: tokens.join(' '), breaks }];
  });
}

function coursesNamed(name: string, entries: readonly IndexedCourse[]): ReportCatalogCourse[] {
  const text = normalizeReportEntityName(name);
  return text ? entries.filter((entry) => entry.text === text).map((entry) => entry.course) : [];
}

export function isScannableReportCourseName(name: string): boolean {
  const tokens = reportEntityTokens(name);
  if (tokens.join(' ').length < MIN_SCANNED_NAME_LENGTH) return false;
  return !tokens.every((token) => GENERIC_COURSE_TOKENS.has(token) || NUMBER_OR_VERSION.test(token));
}

/** "Customer Experience V3" must not be read as "Customer Experience". */
function continuesName(tokens: QuestionToken[], end: number): boolean {
  const next = tokens[end + 1];
  if (!next || next.breakBefore) return false;
  if (/^v\d+$/.test(next.folded)) return true;
  if (!/^\d{1,3}$/.test(next.folded)) return false;
  // "Customer Experience 3 tháng gần đây": the number starts a period.
  const after = tokens[end + 2];
  return !(after && !after.breakBefore && TIME_UNIT_TOKENS.has(after.folded));
}

function typoTokenMatches(written: string, name: string): boolean {
  if (/\d/.test(written) || /\d/.test(name)) return false;
  if (written.length < TYPO_MIN_TOKEN_LENGTH || name.length < TYPO_MIN_TOKEN_LENGTH) return false;
  return reportTextSimilarity(written, name) >= TYPO_TOKEN_SIMILARITY;
}

/** Whole-token match at `start`; with `typo`, exactly one long alphabetic token may differ by a small edit. */
function matchesAt(tokens: QuestionToken[], start: number, entry: IndexedCourse, typo: boolean): boolean {
  if (start + entry.tokens.length > tokens.length) return false;
  if (typo && (entry.tokens.length < 2 || entry.text.length < TYPO_MIN_NAME_LENGTH)) return false;
  let differences = 0;
  for (let offset = 0; offset < entry.tokens.length; offset += 1) {
    const token = tokens[start + offset];
    if (offset > 0 && token.breakBefore && !entry.breaks.has(offset)) return false;
    if (token.folded === entry.tokens[offset]) continue;
    if (!typo || differences > 0 || !typoTokenMatches(token.folded, entry.tokens[offset])) return false;
    differences += 1;
  }
  return !typo || differences === 1;
}

function occurrencesIn(tokens: QuestionToken[], entries: readonly IndexedCourse[], words: UnitWord[], typo: boolean): Occurrence[] {
  const found: Occurrence[] = [];
  for (const entry of entries) {
    for (let start = 0; start < tokens.length; start += 1) {
      if (!matchesAt(tokens, start, entry, typo)) continue;
      const end = start + entry.tokens.length - 1;
      // "team Marketing" names a unit, "Customer Experience V3" another course.
      if (isReportUnitNameSpan(tokens, start, end, words) || continuesName(tokens, end)) continue;
      found.push({ entry, start, end });
    }
  }
  return found;
}

function longestMatch(occurrences: Occurrence[]): ReportCourseResolution {
  if (occurrences.length === 0) return NONE;
  const length = (occurrence: Occurrence) => occurrence.end - occurrence.start + 1;
  const longest = Math.max(...occurrences.map(length));
  const courses = [...new Map(occurrences
    .filter((occurrence) => length(occurrence) === longest)
    .map((occurrence) => [occurrence.entry.course.id, occurrence.entry.course] as const)).values()];
  return courses.length === 1
    ? { status: 'resolved', course: courses[0], source: 'question' }
    : { status: 'ambiguous', courses: courses.slice(0, MAX_REPORT_COURSE_CHOICES) };
}

/**
 * Catalog course names written in the question as whole tokens (accents,
 * case and punctuation ignored). The longest match wins ("Customer
 * Experience V2" over "Customer Experience"); different courses tying for
 * the longest match are `ambiguous`. A one-letter typo in one long word is
 * accepted only when nothing matches exactly. Skipped: short or generic
 * names, names shared with an org unit, and names written as a unit.
 */
export function scanReportCourseNames(input: {
  question: string;
  catalog: ReportCourseCatalog;
  labels?: ReportGroupLabels;
  unitNames?: readonly string[];
}): ReportCourseResolution {
  const unitNames = new Set((input.unitNames ?? []).map(normalizeReportEntityName).filter(Boolean));
  const entries = indexCourses(input.catalog.courses)
    .filter((entry) => isScannableReportCourseName(entry.course.name) && !unitNames.has(entry.text));
  if (entries.length === 0) return NONE;
  const tokens = tokenizeQuestion(input.question);
  const words = buildReportUnitWords(input.labels);
  const exact = occurrencesIn(tokens, entries, words, false);
  return longestMatch(exact.length > 0 ? exact : occurrencesIn(tokens, entries, words, true));
}

/** Only for questions about learners, enrollments, progress or completion. */
export function resolveReportCourseMention(input: {
  question: string;
  catalog: ReportCourseCatalog;
  modelCourse?: string | null;
  labels?: ReportGroupLabels;
  unitNames?: readonly string[];
}): ReportCourseResolution {
  if (!isReportCourseQuestion(input.question)) return NONE;
  const entries = indexCourses(input.catalog.courses);
  if (entries.length === 0) return NONE;
  const reference = findReportCourseReference(input.question);
  if (reference) {
    const named = coursesNamed(reference.text, entries);
    if (named.length === 1) return { status: 'resolved', course: named[0], source: 'reference' };
    if (reference.quoted || named.length > 1) return NONE;
  }
  const scanned = scanReportCourseNames(input);
  if (scanned.status !== 'none') return scanned;
  const hinted = input.modelCourse ? coursesNamed(input.modelCourse, entries) : [];
  return hinted.length === 1 ? { status: 'resolved', course: hinted[0], source: 'model' } : NONE;
}

/** Distinct names for a clarification; one name means several courses share it. */
export function reportCourseChoiceNames(courses: readonly ReportCatalogCourse[]): string[] {
  const names = new Map<string, string>();
  for (const course of courses) {
    const key = normalizeReportEntityName(course.name);
    if (!names.has(key)) names.set(key, course.name);
  }
  return [...names.values()];
}
