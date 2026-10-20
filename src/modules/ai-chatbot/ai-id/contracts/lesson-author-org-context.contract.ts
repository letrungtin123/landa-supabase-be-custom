import { orchestrationV2Hash } from '../shared/lesson-author-orchestration-v2.logic.js';

/**
 * AI ID organization context ("Ngữ cảnh doanh nghiệp", spec ORG_CONTEXT_SPEC §2): the organization
 * profile (version 1) that authors keep for the whole tenant, and the `organization_context` wire object
 * a V2 run freezes at launch (`lesson_author_workspaces.organization_context`) and the IDM pipeline
 * reads as background (`project_context.organization_context`, unit brief `organization_context`).
 *
 * - The profile always has the 7 keys and no other; lengths are Unicode code points (Python `len`).
 * - Node normalises a profile once, on save (`normalizeOrgContextProfile`); Python never rewrites one.
 * - `profile_hash` = sha256 of the canonical JSON of the profile (orchestrationV2Hash; Python
 *   `js_canonical_hash` gives the same hex).
 */

export const ORG_CONTEXT_PROFILE_KEYS = ['organization_summary', 'products_services', 'learner_groups', 'glossary',
  'key_processes', 'culture_tone', 'design_conventions'] as const;
/** Sum of the lengths of every string of a profile. */
export const ORG_CONTEXT_PROFILE_MAX_CHARS = 6_000;
/** Lines of a multi-line text (organization_summary, culture_tone). */
export const ORG_CONTEXT_TEXT_MAX_LINES = 12;
/** Bound of the stored jsonb of a profile and of the frozen workspace column. */
export const ORG_CONTEXT_MAX_JSON_BYTES = 32_768;

export interface OrgContextLearnerGroupV1 { name: string; description: string }
export interface OrgContextGlossaryItemV1 { term: string; meaning: string }

export interface OrgContextProfileV1 {
  organization_summary: string;
  products_services: string[];
  learner_groups: OrgContextLearnerGroupV1[];
  glossary: OrgContextGlossaryItemV1[];
  key_processes: string[];
  culture_tone: string;
  design_conventions: string[];
}

/** The frozen wire object: exactly `lesson_author_workspaces.organization_context`. */
export interface OrganizationContextV1 {
  profile_version: number;
  profile_hash: string;
  profile: OrgContextProfileV1;
}

export type OrgContextProfileIssueReason = 'too_long' | 'too_many' | 'total_too_long' | 'empty' | 'shape';
/** `path` is the JSON path in the request body (`profile`, `profile.learner_groups[2].name`). */
export interface OrgContextProfileIssue { path: string; reason: OrgContextProfileIssueReason }

const TEXTS = { organization_summary: 800, culture_tone: 600 } as const;
const LISTS = {
  products_services: { items: 15, chars: 200 },
  key_processes: { items: 15, chars: 300 },
  design_conventions: { items: 10, chars: 200 },
} as const;
const LEARNER_GROUPS = { items: 12, name: 100, description: 300 } as const;
const GLOSSARY = { items: 40, term: 80, meaning: 300 } as const;
const HASH = /^[0-9a-f]{64}$/;

type TextKey = keyof typeof TEXTS;
type ListKey = keyof typeof LISTS;

/** Unicode code point count (Python `len`). */
export function orgContextTextLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

/** `char_count`: the lengths of every string of the profile (names, descriptions, terms, meanings, items). */
export function orgContextProfileCharCount(profile: OrgContextProfileV1): number {
  const strings = [profile.organization_summary, profile.culture_tone, ...profile.products_services,
    ...profile.key_processes, ...profile.design_conventions,
    ...profile.learner_groups.flatMap(group => [group.name, group.description]),
    ...profile.glossary.flatMap(item => [item.term, item.meaning])];
  return strings.reduce((total, value) => total + orgContextTextLength(value), 0);
}

/** True when every string is empty and every list is empty (an empty profile cannot be confirmed). */
export function isOrgContextProfileEmpty(profile: OrgContextProfileV1): boolean {
  return !profile.organization_summary && !profile.culture_tone && !profile.products_services.length
    && !profile.learner_groups.length && !profile.glossary.length && !profile.key_processes.length
    && !profile.design_conventions.length;
}

export function emptyOrgContextProfile(): OrgContextProfileV1 {
  return { organization_summary: '', products_services: [], learner_groups: [], glossary: [], key_processes: [],
    culture_tone: '', design_conventions: [] };
}

/** sha256 hex of the canonical JSON of the profile. */
export function orgContextProfileHash(profile: OrgContextProfileV1): string {
  return orchestrationV2Hash(profile);
}

// --- Normalisation on save ------------------------------------------------------------------------
// C0/C1 controls and DEL; the whitespace controls among them become a space, line breaks (CR, LF,
// U+2028/U+2029) a line break of a multi-line text or a space, every other one is removed. Unpaired
// surrogates are removed too (PostgreSQL jsonb and Python JSON reject them).
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const SPACE_RUN = /\p{Zs}+/gu;
const TAB = 0x09, LINE_FEED = 0x0a, VERTICAL_TAB = 0x0b, FORM_FEED = 0x0c, CARRIAGE_RETURN = 0x0d;
const LINE_SEPARATOR = 0x2028, PARAGRAPH_SEPARATOR = 0x2029;

function cleanLine(value: string): string {
  return value.replace(SPACE_RUN, ' ').trim();
}

/** Code point by code point: CR LF, CR, LF and U+2028/9 → LF; tab, VT, FF → space; other C0/C1 and DEL → nothing. */
function stripControls(value: string): string {
  let out = '';
  let previous = -1;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === LINE_FEED && previous === CARRIAGE_RETURN) { previous = code; continue; }
    previous = code;
    if (code === LINE_FEED || code === CARRIAGE_RETURN || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) out += '\n';
    else if (code === TAB || code === VERTICAL_TAB || code === FORM_FEED) out += ' ';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    else out += character;
  }
  return out;
}

function baseClean(value: string): string {
  return stripControls(value.replace(LONE_SURROGATES, '').normalize('NFC'));
}

/** A single-line text: NFC, controls stripped (a line break becomes a space), spaces collapsed, trimmed. */
export function normalizeOrgContextLine(value: string): string {
  return cleanLine(baseClean(value).replace(/\n/g, ' '));
}

/**
 * A multi-line text: each line as a single line (spaces collapsed, trimmed) and the whole text trimmed
 * (edge empty lines go). More than 12 lines is not shortened here: the save refuses it (`too_long`).
 */
export function normalizeOrgContextText(value: string): string {
  return baseClean(value).split('\n').map(cleanLine).join('\n').replace(/^\n+|\n+$/g, '');
}

/** Lines of a normalised multi-line text (0 for an empty one). */
export function orgContextTextLines(value: string): number {
  return value ? value.split('\n').length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

class IssueFound extends Error {
  constructor(readonly issue: OrgContextProfileIssue) { super(issue.reason); }
}
const issue = (path: string, reason: OrgContextProfileIssueReason): never => {
  throw new IssueFound({ path, reason });
};

function bounded(value: string, path: string, maximum: number): string {
  if (orgContextTextLength(value) > maximum) issue(path, 'too_long');
  return value;
}

function stringList(value: unknown, path: string, limits: { items: number; chars: number }): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return issue(path, 'shape');
  const kept = (value as string[]).map((item, index) => ({ index, text: normalizeOrgContextLine(item) }))
    .filter(item => item.text);
  if (kept.length > limits.items) issue(path, 'too_many');
  return kept.map(item => bounded(item.text, `${path}[${item.index}]`, limits.chars));
}

function pairList<K extends string, V extends string>(value: unknown, path: string, keys: readonly [K, V],
  limits: { items: number } & Record<K | V, number>, required: readonly (K | V)[]): Array<Record<K | V, string>> {
  if (!Array.isArray(value)) return issue(path, 'shape');
  const kept: Array<{ index: number; item: Record<K | V, string> }> = [];
  value.forEach((raw, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(raw) || !hasExactKeys(raw, keys) || keys.some(key => typeof raw[key] !== 'string')) {
      issue(at, 'shape');
    }
    const record = raw as Record<K | V, string>;
    const item = Object.fromEntries(keys.map(key => [key, normalizeOrgContextLine(record[key])])) as Record<K | V, string>;
    if (keys.every(key => !item[key])) return;
    for (const key of required) if (!item[key]) issue(`${at}.${key}`, 'empty');
    for (const key of keys) bounded(item[key], `${at}.${key}`, limits[key]);
    kept.push({ index, item });
  });
  if (kept.length > limits.items) issue(path, 'too_many');
  return kept.map(entry => entry.item);
}

/**
 * Normalise and validate a profile from a request (or an AI draft): the first problem as `{path, reason}`,
 * or the profile as it is stored. Shape problems (`shape`) are found before any length. An author's text
 * of more than 12 lines is refused (`too_long`); an AI draft's (`foldExtraLines`) keeps its first 11 lines
 * and joins the rest into the 12th.
 */
export function normalizeOrgContextProfile(value: unknown, path = 'profile', options: { foldExtraLines?: boolean } = {}):
  { ok: true; profile: OrgContextProfileV1 } | { ok: false; issue: OrgContextProfileIssue } {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ORG_CONTEXT_PROFILE_KEYS)) issue(path, 'shape');
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(TEXTS) as TextKey[]) if (typeof raw[key] !== 'string') issue(`${path}.${key}`, 'shape');
    const text = (key: TextKey) => {
      let normalized = normalizeOrgContextText(raw[key] as string);
      if (orgContextTextLines(normalized) > ORG_CONTEXT_TEXT_MAX_LINES) {
        if (!options.foldExtraLines) issue(`${path}.${key}`, 'too_long');
        const lines = normalized.split('\n');
        normalized = [...lines.slice(0, ORG_CONTEXT_TEXT_MAX_LINES - 1),
          lines.slice(ORG_CONTEXT_TEXT_MAX_LINES - 1).filter(Boolean).join(' ')].join('\n');
      }
      return bounded(normalized, `${path}.${key}`, TEXTS[key]);
    };
    const list = (key: ListKey) => stringList(raw[key], `${path}.${key}`, LISTS[key]);
    const profile: OrgContextProfileV1 = {
      organization_summary: text('organization_summary'),
      products_services: list('products_services'),
      learner_groups: pairList(raw.learner_groups, `${path}.learner_groups`, ['name', 'description'], LEARNER_GROUPS,
        ['name']).map(group => ({ name: group.name, description: group.description })),
      glossary: pairList(raw.glossary, `${path}.glossary`, ['term', 'meaning'], GLOSSARY, ['term', 'meaning'])
        .map(item => ({ term: item.term, meaning: item.meaning })),
      key_processes: list('key_processes'),
      culture_tone: text('culture_tone'),
      design_conventions: list('design_conventions'),
    };
    if (orgContextProfileCharCount(profile) > ORG_CONTEXT_PROFILE_MAX_CHARS
      || Buffer.byteLength(JSON.stringify(profile), 'utf8') > ORG_CONTEXT_MAX_JSON_BYTES) issue(path, 'total_too_long');
    return { ok: true, profile };
  } catch (error) {
    if (error instanceof IssueFound) return { ok: false, issue: error.issue };
    throw error;
  }
}

/** The reason a profile cannot be confirmed (it is empty), or null. */
export function orgContextConfirmIssue(profile: OrgContextProfileV1, path = 'profile'): OrgContextProfileIssue | null {
  return isOrgContextProfileEmpty(profile) ? { path, reason: 'empty' } : null;
}

// --- Strict readers (stored rows and the wire) ----------------------------------------------------
/** Called with the JSON path of the first offending value; must throw. */
export type OrgContextFail = (path: string) => never;

function exactString(value: unknown, path: string, minimum: number, maximum: number, fail: OrgContextFail): string {
  if (typeof value !== 'string') return fail(path);
  const length = orgContextTextLength(value);
  if (length < minimum || length > maximum) fail(path);
  return value;
}

function exactList<T>(value: unknown, path: string, maximum: number, item: (entry: unknown, at: string) => T,
  fail: OrgContextFail): T[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(path);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function exactPair(value: unknown, path: string, keys: readonly [string, string], fail: OrgContextFail): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return fail(path);
  return value;
}

/**
 * A profile exactly as stored or sent (no rewriting): the 7 keys, string types, the caps of §2 and the
 * 6000 total. Python's `IdmOrgProfileV1` accepts the same set.
 */
export function readOrgContextProfile(value: unknown, path: string, fail: OrgContextFail): OrgContextProfileV1 {
  if (!isRecord(value) || !hasExactKeys(value, ORG_CONTEXT_PROFILE_KEYS)) return fail(path);
  const list = (key: ListKey) => exactList(value[key], `${path}.${key}`, LISTS[key].items,
    (entry, at) => exactString(entry, at, 1, LISTS[key].chars, fail), fail);
  const profile: OrgContextProfileV1 = {
    organization_summary: exactString(value.organization_summary, `${path}.organization_summary`, 0,
      TEXTS.organization_summary, fail),
    products_services: list('products_services'),
    learner_groups: exactList(value.learner_groups, `${path}.learner_groups`, LEARNER_GROUPS.items, (entry, at) => {
      const group = exactPair(entry, at, ['name', 'description'], fail);
      return { name: exactString(group.name, `${at}.name`, 1, LEARNER_GROUPS.name, fail),
        description: exactString(group.description, `${at}.description`, 0, LEARNER_GROUPS.description, fail) };
    }, fail),
    glossary: exactList(value.glossary, `${path}.glossary`, GLOSSARY.items, (entry, at) => {
      const item = exactPair(entry, at, ['term', 'meaning'], fail);
      return { term: exactString(item.term, `${at}.term`, 1, GLOSSARY.term, fail),
        meaning: exactString(item.meaning, `${at}.meaning`, 1, GLOSSARY.meaning, fail) };
    }, fail),
    key_processes: list('key_processes'),
    culture_tone: exactString(value.culture_tone, `${path}.culture_tone`, 0, TEXTS.culture_tone, fail),
    design_conventions: list('design_conventions'),
  };
  if (orgContextProfileCharCount(profile) > ORG_CONTEXT_PROFILE_MAX_CHARS) fail(path);
  return profile;
}

/** The wire object, its version and its hash checked against the profile. */
export function readOrganizationContext(value: unknown, path: string, fail: OrgContextFail): OrganizationContextV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['profile_version', 'profile_hash', 'profile'])) return fail(path);
  const version = value.profile_version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) fail(`${path}.profile_version`);
  if (typeof value.profile_hash !== 'string' || !HASH.test(value.profile_hash)) fail(`${path}.profile_hash`);
  const profile = readOrgContextProfile(value.profile, `${path}.profile`, fail);
  if (orgContextProfileHash(profile) !== value.profile_hash) fail(`${path}.profile_hash`);
  return { profile_version: version as number, profile_hash: value.profile_hash as string, profile };
}

/** The wire object of a stored profile version. */
export function buildOrganizationContext(version: number, profile: OrgContextProfileV1): OrganizationContextV1 {
  return { profile_version: version, profile_hash: orgContextProfileHash(profile), profile };
}

/** A stored column value of another shape (fails closed, never sent). */
export class OrgContextStoredInvalidError extends Error {
  readonly code = 'ORG_CONTEXT_STORED_INVALID';
  constructor(readonly path: string) {
    super('ORG_CONTEXT_STORED_INVALID');
    this.name = 'OrgContextStoredInvalidError';
  }
}

/** `lesson_author_workspaces.organization_context`: null when the run has none (or the column does not exist). */
export function readStoredOrganizationContext(value: unknown): OrganizationContextV1 | null {
  if (value === null || value === undefined) return null;
  return readOrganizationContext(value, 'organization_context', path => { throw new OrgContextStoredInvalidError(path); });
}

/** `readStoredOrganizationContext`, calling `invalid` (which throws the caller's own error) for another shape. */
export function readStoredOrganizationContextOr(value: unknown, invalid: () => never): OrganizationContextV1 | null {
  try {
    return readStoredOrganizationContext(value);
  } catch (error) {
    if (error instanceof OrgContextStoredInvalidError) return invalid();
    throw error;
  }
}

/** Whether two frozen contexts (or their absence) are the same. */
export function sameOrganizationContext(left: OrganizationContextV1 | null, right: OrganizationContextV1 | null): boolean {
  if (!left || !right) return left === right;
  return left.profile_version === right.profile_version && left.profile_hash === right.profile_hash;
}

/**
 * The request/bootstrap identity input with the frozen context: the same operation with another context
 * hashes differently. Absent context → the identity is returned unchanged, so every hash taken before
 * this feature still verifies.
 */
export function withOrganizationContextIdentity<T extends Record<string, unknown>>(
  identity: T, context: OrganizationContextV1 | null | undefined,
): T | (T & { organization_context: { profile_version: number; profile_hash: string } }) {
  if (!context) return identity;
  return { ...identity, organization_context: { profile_version: context.profile_version,
    profile_hash: context.profile_hash } };
}

// --- AI service: POST /v1/lesson-author/org-context/distill ------------------------------------------
export interface OrgContextDistillUsage {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  totalTokens: number;
  /** Part of inputTokens served from the provider's context cache (absent when none). */
  cachedInputTokens?: number;
}

/** The AI draft, already normalised as Node stores it. */
export interface OrgContextDistillResponse {
  profile: OrgContextProfileV1;
  source_document_ids: string[];
  source_chars: number;
  truncated: boolean;
  usage: OrgContextDistillUsage;
  usage_complete: boolean;
  provider_calls: number;
}

export class OrgContextDistillResponseError extends Error {
  readonly code = 'ORG_CONTEXT_DISTILL_RESPONSE_INVALID';
  constructor(readonly path: string) {
    super('ORG_CONTEXT_DISTILL_RESPONSE_INVALID');
    this.name = 'OrgContextDistillResponseError';
  }
}

const DISTILL_RESPONSE_KEYS = ['profile', 'source_document_ids', 'source_chars', 'truncated', 'usage', 'usage_complete',
  'provider_calls'] as const;
const nonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0;

/**
 * Strict reader of the distill answer: exactly its keys, the source ids a subset of the requested ones
 * (each once, at least one), and the profile normalised and checked like an author's save.
 */
export function readOrgContextDistillResponse(value: unknown, requested: readonly string[]): OrgContextDistillResponse {
  const fail = (path: string): never => { throw new OrgContextDistillResponseError(path); };
  if (!isRecord(value) || !hasExactKeys(value, DISTILL_RESPONSE_KEYS)) return fail('response');
  const ids = value.source_document_ids;
  const allowed = new Set(requested);
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !allowed.has(id))
    || new Set(ids).size !== ids.length) fail('response.source_document_ids');
  if (!nonNegativeInteger(value.source_chars)) fail('response.source_chars');
  if (typeof value.truncated !== 'boolean') fail('response.truncated');
  if (typeof value.usage_complete !== 'boolean') fail('response.usage_complete');
  if (!nonNegativeInteger(value.provider_calls)) fail('response.provider_calls');
  const usage = value.usage;
  if (!isRecord(usage) || Object.values(usage).some(entry => !nonNegativeInteger(entry))) fail('response.usage');
  const counts = usage as Record<string, number>;
  const normalized = normalizeOrgContextProfile(value.profile, 'response.profile', { foldExtraLines: true });
  if (!normalized.ok) return fail(normalized.issue.path);
  const inputTokens = counts.inputTokens ?? 0, outputTokens = counts.outputTokens ?? 0;
  const embeddingTokens = counts.embeddingTokens ?? 0;
  return {
    profile: normalized.profile, source_document_ids: [...ids as string[]], source_chars: value.source_chars as number,
    truncated: value.truncated as boolean, usage_complete: value.usage_complete as boolean,
    provider_calls: value.provider_calls as number,
    usage: { inputTokens, outputTokens, embeddingTokens,
      totalTokens: counts.totalTokens ?? inputTokens + outputTokens + embeddingTokens,
      ...(counts.cachedInputTokens ? { cachedInputTokens: counts.cachedInputTokens } : {}) },
  };
}

// --- Launch refusals ---------------------------------------------------------------------------------
export const ORG_CONTEXT_NOT_APPLICABLE = 'ORG_CONTEXT_NOT_APPLICABLE';
export const ORG_CONTEXT_NOT_CONFIRMED = 'ORG_CONTEXT_NOT_CONFIRMED';
export type OrgContextLaunchErrorCode = typeof ORG_CONTEXT_NOT_APPLICABLE | typeof ORG_CONTEXT_NOT_CONFIRMED;

/** `[HTTP status, Vietnamese, English]` of a workspace Create that asked for the organization profile. */
export const ORG_CONTEXT_LAUNCH_ERRORS: Readonly<Record<OrgContextLaunchErrorCode, readonly [number, string, string]>> =
  Object.freeze({
    ORG_CONTEXT_NOT_APPLICABLE: [422,
      'Khoá học này chưa dùng được hồ sơ doanh nghiệp. Hãy tắt "Dùng hồ sơ doanh nghiệp" rồi thử lại, hoặc liên hệ quản trị viên.',
      'The organization profile cannot be used for this course. Turn off "Use the organization profile" and try again, or contact your administrator.'],
    ORG_CONTEXT_NOT_CONFIRMED: [409,
      'Hồ sơ doanh nghiệp chưa được xác nhận. Hãy xác nhận hồ sơ ở thẻ "Ngữ cảnh doanh nghiệp" rồi thử lại.',
      'The organization profile is not confirmed yet. Confirm it in the "Organization context" tab and try again.'],
  });

export class OrgContextLaunchError extends Error {
  constructor(readonly code: OrgContextLaunchErrorCode) {
    super(code);
    this.name = 'OrgContextLaunchError';
  }
}

export function isOrgContextLaunchErrorCode(value: unknown): value is OrgContextLaunchErrorCode {
  return typeof value === 'string' && Object.hasOwn(ORG_CONTEXT_LAUNCH_ERRORS, value);
}
