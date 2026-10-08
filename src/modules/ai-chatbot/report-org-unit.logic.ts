// Pure org-unit resolution for chat reports: finds the group / subgroup /
// team a question refers to by name, never by an ID supplied by the model.
// Matching is diacritics- and case-insensitive with partial and typo
// tolerance; anything that is not a single confident match becomes an
// explicit outcome (ambiguous, not found, multiple) that the router turns
// into a clarification turn with choice chips. For a learner_plus actor a
// unit outside their groups is answered exactly like an unknown name.

import { normalizeReportEntityName, reportEntityTokens, reportTextSimilarity } from './report-text.logic.js';

export type ReportOrgUnitLevel = 'group' | 'subgroup' | 'team';

export interface ReportOrgUnit {
  id: string;
  level: ReportOrgUnitLevel;
  name: string;
  group_id: string;
  group_name: string;
  subgroup_id: string | null;
  subgroup_name: string | null;
}

export interface ReportOrgUnitCatalog {
  units: ReportOrgUnit[];
  truncated: boolean;
}

export type ReportGroupLabels = Partial<Record<ReportOrgUnitLevel, string>>;

export interface ReportModelUnitMention {
  name: string;
  level?: ReportOrgUnitLevel | null;
}

export type ReportUnitResolution =
  | { status: 'none' }
  | { status: 'resolved'; unit: ReportOrgUnit; source: 'question' | 'model' }
  | { status: 'ambiguous'; mention: string; candidates: ReportOrgUnit[] }
  | { status: 'not_found'; mention: string; suggestions: ReportOrgUnit[] }
  | { status: 'multiple'; units: ReportOrgUnit[] };

interface UnitWord {
  /** Lower-case tokens as typed; Vietnamese words keep their diacritics. */
  tokens: string[];
  level: ReportOrgUnitLevel | null;
}

interface QuestionToken {
  /** As written (NFC), for messages shown back to the user. */
  original: string;
  raw: string;
  folded: string;
  /** A sentence/list break (",", "?", ";", quotes) separates it from the previous token. */
  breakBefore: boolean;
}

interface IndexedUnit {
  unit: ReportOrgUnit;
  tokens: string[];
  text: string;
}

interface UnitMention {
  /** The name as the user (or the model) wrote it, for clarification messages. */
  display: string;
  text: string;
  tokens: string[];
  level: ReportOrgUnitLevel | null;
  source: 'question' | 'model';
  /** Catalog names written exactly after a unit word ("nhóm Kinh doanh Hà Nội ..."). */
  exactIds: Set<string>;
  /** Whole model-supplied names that only count on an exact match ("Phòng ban" is a real team). */
  aliases: string[];
}

interface ScoredUnit {
  unit: ReportOrgUnit;
  score: number;
}

const RESOLVE_THRESHOLD = 0.8;
const CANDIDATE_THRESHOLD = 0.6;
const SUGGESTION_SIMILARITY = 0.45;
const MAX_CANDIDATES = 6;
const MAX_NAME_TOKENS = 8;
const MAX_MODEL_UNITS = 5;
const LEVEL_RANK: Record<ReportOrgUnitLevel, number> = { group: 1, subgroup: 2, team: 3 };

// Vietnamese unit words are matched with diacritics ("đội", not "doi" which is
// also "đổi"/"đợi"); unambiguous ones are accepted without diacritics too.
const GENERIC_UNIT_WORDS: ReadonlyArray<[string, ReportOrgUnitLevel | null]> = [
  ['nhóm con', 'subgroup'], ['nhom con', 'subgroup'], ['sub group', 'subgroup'], ['subgroup', 'subgroup'],
  ['phòng ban', 'team'], ['phong ban', 'team'], ['bộ phận', 'team'], ['bo phan', 'team'],
  ['chi nhánh', 'subgroup'], ['chi nhanh', 'subgroup'], ['công ty', 'group'], ['cong ty', 'group'],
  ['đơn vị', null], ['don vi', null], ['khối', 'group'], ['phòng', 'team'], ['đội', 'team'],
  ['nhóm', 'group'], ['nhom', 'group'],
  ['department', 'team'], ['dept', 'team'], ['team', 'team'], ['branch', 'subgroup'], ['division', 'group'],
  ['group', 'group'], ['company', 'group'], ['unit', null],
];
/** Common compounds where the unit word is not a unit ("đội ngũ", "phòng chống", "khối lượng"). */
const NOT_A_UNIT_AFTER: Record<string, ReadonlySet<string>> = {
  'đội': new Set(['ngũ']),
  'phòng': new Set(['chống', 'ngừa', 'học', 'thí', 'khi', 'tránh', 'vệ', 'họp']),
  'khối': new Set(['lượng', 'kiến']),
  'đơn vị': new Set(['tính', 'đo']),
  'don vi': new Set(['tinh', 'do']),
  'unit': new Set(['price', 'cost', 'test', 'tests']),
};
const ENGLISH_TRAILING_UNIT_WORDS = new Set(['team', 'group', 'department', 'dept', 'branch', 'division', 'subgroup', 'unit', 'company']);

const STOP_WORDS = new Set([
  'tu', 'den', 'toi', 'trong', 'tai', 'cua', 'va', 'voi', 'so', 'co', 'bao', 'nhieu', 'la', 'gi', 'nao', 'nhu', 'giua', 'theo', 'cho', 'o',
  'luot', 'hom', 'tuan', 'quy', 'ngay', 'nay', 'truoc', 'qua', 'roi', 'gan', 've', 'cac', 'nhung',
  'in', 'from', 'to', 'for', 'during', 'of', 'and', 'with', 'this', 'last', 'since', 'until', 'between', 'by', 'on', 'at', 'vs', 'versus',
  'compared', 'has', 'have', 'had', 'how', 'what', 'which', 'who', 'is', 'are', 'was', 'were', 'did', 'do', 'does', 'the', 'a', 'an',
  'learners', 'learner', 'students', 'student', 'courses', 'course', 'enrollments', 'enrollment', 'completion', 'completions', 'rate',
  'report', 'reports', 'month', 'months', 'week', 'weeks', 'year', 'years', 'quarter', 'today', 'yesterday', 'please', 'show', 'me',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);
/** Vietnamese words that are also common inside unit names stop a name only in these contexts. */
const CONDITIONAL_STOPS: Record<string, RegExp> = {
  nam: /^(?:\d+|nay|ngoai|truoc|qua|roi)$/,
  thang: /^(?:\d+|nay|truoc|qua|roi)$/,
  hoc: /^(?:vien|sinh)$/,
  khoa: /^hoc$/,
  nguoi: /^hoc$/,
  ty: /^le$/,
  ti: /^le$/,
  tien: /^do$/,
  hoan: /^thanh$/,
  ghi: /^danh$/,
  dang: /^ky$/,
};

function lowerTokens(value: string): string[] {
  return value.normalize('NFC').toLocaleLowerCase('vi-VN').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function tokenizeQuestion(question: string): QuestionToken[] {
  const text = question.normalize('NFC');
  const tokens: QuestionToken[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = match.index ?? 0;
    const raw = match[0].toLocaleLowerCase('vi-VN');
    tokens.push({
      original: match[0],
      raw,
      folded: normalizeReportEntityName(raw),
      breakBefore: tokens.length > 0 && /[,?!;:\n"“”«»'‘’]/.test(text.slice(previousEnd, start)),
    });
    previousEnd = start + match[0].length;
  }
  return tokens;
}

export function buildReportUnitWords(labels: ReportGroupLabels = {}): UnitWord[] {
  const words: UnitWord[] = [];
  const add = (text: string, level: ReportOrgUnitLevel | null) => {
    const tokens = lowerTokens(text);
    if (tokens.length > 0 && !words.some((word) => word.tokens.join(' ') === tokens.join(' '))) words.push({ tokens, level });
  };
  // Tenant labels ("Khối", "Chi nhánh"...) decide the level before the generic vocabulary does.
  for (const level of ['team', 'subgroup', 'group'] as const) {
    const label = labels[level]?.trim();
    if (label) {
      add(label, level);
      add(normalizeReportEntityName(label), level);
    }
  }
  for (const [text, level] of GENERIC_UNIT_WORDS) add(text, level);
  return words.sort((left, right) => right.tokens.length - left.tokens.length);
}

function unitWordAt(tokens: QuestionToken[], index: number, words: UnitWord[]): UnitWord | null {
  for (const word of words) {
    if (index + word.tokens.length > tokens.length) continue;
    if (!word.tokens.every((token, offset) => tokens[index + offset].raw === token)) continue;
    const next = tokens[index + word.tokens.length];
    if (next && NOT_A_UNIT_AFTER[word.tokens.join(' ')]?.has(next.raw)) return null;
    return word;
  }
  return null;
}

export function hasReportUnitWord(question: string, labels: ReportGroupLabels = {}): boolean {
  const tokens = tokenizeQuestion(question);
  const words = buildReportUnitWords(labels);
  return tokens.some((_token, index) => unitWordAt(tokens, index, words) !== null);
}

function isStop(tokens: QuestionToken[], index: number): boolean {
  const token = tokens[index].folded;
  if (STOP_WORDS.has(token)) return true;
  const condition = CONDITIONAL_STOPS[token];
  return Boolean(condition && tokens[index + 1] && condition.test(tokens[index + 1].folded));
}

function exactNamesAt(tokens: QuestionToken[], index: number, catalog: IndexedUnit[]): IndexedUnit[] {
  let best: IndexedUnit[] = [];
  for (const entry of catalog) {
    const length = entry.tokens.length;
    if (length === 0 || index + length > tokens.length) continue;
    const matches = entry.tokens.every((token, offset) => tokens[index + offset].folded === token
      && (offset === 0 || !tokens[index + offset].breakBefore));
    if (!matches) continue;
    if (best.length === 0 || length > best[0].tokens.length) best = [entry];
    else if (length === best[0].tokens.length) best.push(entry);
  }
  return best;
}

function collectNameAfter(tokens: QuestionToken[], index: number): QuestionToken[] {
  const name: QuestionToken[] = [];
  for (let cursor = index; cursor < tokens.length && name.length < MAX_NAME_TOKENS; cursor += 1) {
    if ((cursor > index && tokens[cursor].breakBefore) || isStop(tokens, cursor)) break;
    name.push(tokens[cursor]);
  }
  return name;
}

function collectNameBefore(tokens: QuestionToken[], index: number): QuestionToken[] {
  const name: QuestionToken[] = [];
  for (let cursor = index - 1; cursor >= 0 && name.length < MAX_NAME_TOKENS; cursor -= 1) {
    if (tokens[cursor + 1].breakBefore || isStop(tokens, cursor)) break;
    name.unshift(tokens[cursor]);
  }
  return name;
}

function mentionFromTokens(name: QuestionToken[], level: ReportOrgUnitLevel | null, exactIds: Set<string> = new Set()): UnitMention {
  const tokens = name.map((token) => token.folded);
  return {
    display: name.map((token) => token.original).join(' '),
    text: tokens.join(' '),
    tokens,
    level,
    source: 'question',
    exactIds,
    aliases: [],
  };
}

function indexCatalog(units: ReportOrgUnit[]): IndexedUnit[] {
  return units.map((unit) => {
    const tokens = reportEntityTokens(unit.name);
    return { unit, tokens, text: tokens.join(' ') };
  });
}

function questionMentions(question: string, catalog: IndexedUnit[], words: UnitWord[]): UnitMention[] {
  const tokens = tokenizeQuestion(question);
  const mentions: UnitMention[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = unitWordAt(tokens, index, words);
    if (!word) continue;
    const nameStart = index + word.tokens.length;
    const opensName = nameStart < tokens.length && !tokens[nameStart].breakBefore;
    const exact = opensName ? exactNamesAt(tokens, nameStart, catalog) : [];
    const name = exact.length > 0
      ? tokens.slice(nameStart, nameStart + exact[0].tokens.length)
      : opensName ? collectNameAfter(tokens, nameStart) : [];
    if (name.length > 0) {
      mentions.push(mentionFromTokens(name, word.level, new Set(exact.map((entry) => entry.unit.id))));
      index = nameStart + name.length - 1;
      continue;
    }
    if (word.tokens.length === 1 && ENGLISH_TRAILING_UNIT_WORDS.has(word.tokens[0])) {
      const before = collectNameBefore(tokens, index);
      if (before.length > 0) mentions.push(mentionFromTokens(before, word.level));
    }
  }
  return mentions;
}

function modelMentions(units: ReportModelUnitMention[], words: UnitWord[]): UnitMention[] {
  const mentions: UnitMention[] = [];
  for (const unit of units.slice(0, MAX_MODEL_UNITS)) {
    const full = reportEntityTokens(unit.name);
    if (full.length === 0) continue;
    const raw = lowerTokens(unit.name);
    const leading = words.find((word) => word.tokens.length < raw.length && word.tokens.every((token, offset) => raw[offset] === token));
    const tokens = leading ? full.slice(leading.tokens.length) : full;
    mentions.push({
      display: unit.name.trim().replace(/\s+/g, ' '),
      text: tokens.join(' '),
      tokens,
      level: unit.level ?? leading?.level ?? null,
      source: 'model',
      exactIds: new Set(),
      aliases: leading ? [full.join(' ')] : [],
    });
  }
  return mentions;
}

export function scoreReportUnitMatch(mentionTokens: string[], unitTokens: string[]): number {
  if (mentionTokens.length === 0 || unitTokens.length === 0) return 0;
  const mention = mentionTokens.join(' ');
  const unit = unitTokens.join(' ');
  if (mention === unit) return 1;
  const startsWith = (long: string[], short: string[]) => short.every((token, index) => long[index] === token);
  if (mentionTokens.length > unitTokens.length && startsWith(mentionTokens, unitTokens)) return 0.9;
  if (unitTokens.length > mentionTokens.length && startsWith(unitTokens, mentionTokens)) return 0.8;
  if (` ${unit} `.includes(` ${mention} `)) return 0.72;
  if (mentionTokens.every((token) => unitTokens.includes(token))) return 0.68;
  if (mention.length >= 4 && unit.length >= 4) {
    const similarity = reportTextSimilarity(mention, unit);
    if (similarity >= 0.8) return 0.5 + 0.4 * similarity;
  }
  return 0;
}

function scoreMention(mention: UnitMention, catalog: IndexedUnit[]): ScoredUnit[] {
  return catalog
    .map((entry) => {
      const base = mention.exactIds.has(entry.unit.id) || mention.aliases.includes(entry.text)
        ? 1
        : scoreReportUnitMatch(mention.tokens, entry.tokens);
      const levelBonus = base > 0 && mention.level === entry.unit.level ? 0.05 : 0;
      return { unit: entry.unit, score: base + levelBonus };
    })
    .filter((candidate) => candidate.score >= CANDIDATE_THRESHOLD)
    .sort((left, right) => right.score - left.score
      || LEVEL_RANK[left.unit.level] - LEVEL_RANK[right.unit.level]
      || left.unit.name.localeCompare(right.unit.name));
}

function isWithin(unit: ReportOrgUnit, ancestor: ReportOrgUnit): boolean {
  if (unit.id === ancestor.id) return true;
  if (ancestor.level === 'group') return unit.group_id === ancestor.id;
  if (ancestor.level === 'subgroup') return unit.subgroup_id === ancestor.id;
  return false;
}

function suggestionsFor(mention: UnitMention, catalog: IndexedUnit[]): ReportOrgUnit[] {
  return catalog
    .map((entry) => ({ unit: entry.unit, similarity: reportTextSimilarity(mention.text, entry.text) }))
    .filter((candidate) => candidate.similarity >= SUGGESTION_SIMILARITY)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 3)
    .map((candidate) => candidate.unit);
}

function dedupeMentions(mentions: UnitMention[]): UnitMention[] {
  const output: UnitMention[] = [];
  for (const mention of mentions) {
    if (!mention.text) continue;
    const duplicate = output.some((existing) => ` ${existing.text} `.includes(` ${mention.text} `)
      || ` ${mention.text} `.includes(` ${existing.text} `));
    if (!duplicate) output.push(mention);
  }
  return output;
}

export function isReportUnitPermitted(unit: ReportOrgUnit, allowedGroupIds: readonly string[] | null): boolean {
  return allowedGroupIds === null || allowedGroupIds.includes(unit.group_id);
}

/**
 * learner_plus: a match outside the actor's groups becomes `hidden(unit)`, the
 * same "not found" answer an unknown name gets, so the reply neither confirms
 * that the unit exists nor shows its real name.
 */
function applyPermissions(
  resolution: ReportUnitResolution,
  allowedGroupIds: readonly string[],
  hidden: (unit: ReportOrgUnit) => ReportUnitResolution,
): ReportUnitResolution {
  switch (resolution.status) {
    case 'resolved':
      return isReportUnitPermitted(resolution.unit, allowedGroupIds) ? resolution : hidden(resolution.unit);
    case 'ambiguous': {
      const permitted = resolution.candidates.filter((unit) => isReportUnitPermitted(unit, allowedGroupIds));
      if (permitted.length === 0) return hidden(resolution.candidates[0]);
      if (permitted.length === 1) return { status: 'resolved', unit: permitted[0], source: 'question' };
      return { ...resolution, candidates: permitted };
    }
    case 'multiple': {
      const forbidden = resolution.units.find((unit) => !isReportUnitPermitted(unit, allowedGroupIds));
      return forbidden ? hidden(forbidden) : resolution;
    }
    default:
      return resolution;
  }
}

function decideSingle(mention: UnitMention, scored: ScoredUnit[]): ReportUnitResolution {
  const [top, second] = scored;
  if (top.score >= RESOLVE_THRESHOLD && (!second || second.score < top.score - 0.04)) {
    return { status: 'resolved', unit: top.unit, source: mention.source };
  }
  return {
    status: 'ambiguous',
    mention: mention.display,
    candidates: scored.filter((candidate) => candidate.score >= top.score - 0.1).slice(0, MAX_CANDIDATES).map((candidate) => candidate.unit),
  };
}

export function resolveReportOrgUnits(input: {
  question: string;
  modelUnits?: ReportModelUnitMention[];
  catalog: ReportOrgUnitCatalog;
  labels?: ReportGroupLabels;
  allowedGroupIds: readonly string[] | null;
}): ReportUnitResolution {
  const words = buildReportUnitWords(input.labels);
  const catalog = indexCatalog(input.catalog.units);
  const allowed = input.allowedGroupIds;
  // A restricted actor is only ever suggested units inside their own groups.
  const suggestionPool = allowed === null ? catalog : catalog.filter((entry) => isReportUnitPermitted(entry.unit, allowed));
  const mentions = dedupeMentions([
    ...questionMentions(input.question, catalog, words),
    ...modelMentions(input.modelUnits ?? [], words),
  ]);
  if (mentions.length === 0) return { status: 'none' };

  const scored = mentions.map((mention) => ({ mention, candidates: scoreMention(mention, catalog) }));
  // Echoes only the text as written (never a catalog name) with permitted suggestions.
  const notFound = (mention: UnitMention): ReportUnitResolution => ({
    status: 'not_found', mention: mention.display, suggestions: suggestionsFor(mention, suggestionPool),
  });
  const missing = scored.find((entry) => entry.candidates.length === 0);
  if (missing) return notFound(missing.mention);
  const permit = (resolution: ReportUnitResolution): ReportUnitResolution => (allowed === null
    ? resolution
    : applyPermissions(resolution, allowed, (unit) => notFound(
      scored.find((entry) => entry.candidates.some((candidate) => candidate.unit.id === unit.id))?.mention ?? scored[0].mention,
    )));
  if (scored.length === 1) return permit(decideSingle(scored[0].mention, scored[0].candidates));

  // Several mentions: a unit consistent with all of them ("team Marketing,
  // chi nhánh Miền Nam") is a refinement; otherwise they are separate units.
  const pool = [...new Map(scored.flatMap((entry) => entry.candidates.map((candidate) => [candidate.unit.id, candidate.unit] as const))).values()];
  const consistent = pool.filter((unit) => scored.every((entry) => entry.candidates.some((candidate) => isWithin(unit, candidate.unit))));
  if (consistent.length > 0) {
    const deepest = Math.max(...consistent.map((unit) => LEVEL_RANK[unit.level]));
    const best = consistent.filter((unit) => LEVEL_RANK[unit.level] === deepest);
    return permit(best.length === 1
      ? { status: 'resolved', unit: best[0], source: scored[0].mention.source }
      : { status: 'ambiguous', mention: scored.map((entry) => entry.mention.display).join(' / '), candidates: best.slice(0, MAX_CANDIDATES) });
  }
  const distinct = [...new Map(scored.map((entry) => [entry.candidates[0].unit.id, entry.candidates[0].unit] as const)).values()];
  return permit(distinct.length === 1
    ? { status: 'resolved', unit: distinct[0], source: scored[0].mention.source }
    : { status: 'multiple', units: distinct.slice(0, MAX_CANDIDATES) });
}

/**
 * The unit with its ancestors, so the dashboard filter editor shows the whole
 * path; resolveReportHierarchy re-validates the chain against the tenant.
 */
export function reportUnitFilter(unit: ReportOrgUnit): { group_id?: string; subgroup_id?: string; team_id?: string } {
  if (unit.level === 'team') return { group_id: unit.group_id, ...(unit.subgroup_id ? { subgroup_id: unit.subgroup_id } : {}), team_id: unit.id };
  if (unit.level === 'subgroup') return { group_id: unit.group_id, subgroup_id: unit.id };
  return { group_id: unit.id };
}

/** Ancestors shown next to a unit name in a chip ("Công ty A / Chi nhánh B"). */
export function reportUnitPath(unit: ReportOrgUnit): string[] {
  if (unit.level === 'group') return [];
  if (unit.level === 'subgroup') return [unit.group_name];
  return [unit.group_name, unit.subgroup_name ?? ''].filter(Boolean);
}

export function findReportUnitById(catalog: ReportOrgUnitCatalog, id: string | undefined): ReportOrgUnit | null {
  return id ? catalog.units.find((unit) => unit.id === id) ?? null : null;
}

export function permittedReportGroups(catalog: ReportOrgUnitCatalog, allowedGroupIds: readonly string[]): ReportOrgUnit[] {
  return catalog.units.filter((unit) => unit.level === 'group' && allowedGroupIds.includes(unit.id));
}
