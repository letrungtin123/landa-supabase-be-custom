// IDM contract primitives: the canonical hashes, the Python/Rust whitespace and length rules,
// the id patterns and the primitive field readers that the contract readers are built from.
// Split out of lesson-author-idm.contract.ts (move only), which re-exports the public names.

import { createHash } from 'node:crypto';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { IDM_SCOPE_KEY_PREFIX, IdmError } from './lesson-author-idm-types.contract.js';

// --- Canonical hash ------------------------------------------------------------------------
/**
 * Same canonical encoding as Python `canonical_hash`
 * (`json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))` → sha256):
 * the shared V2 hash. Key order differs from Python only for keys containing
 * astral-plane characters; every IDM key is ASCII.
 */
export function idmHash(value: unknown): string {
  return orchestrationV2Hash(value);
}

function hashWithout(value: object, key: string): string {
  return idmHash(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));
}

/** `canonical_hash` of a design payload without its `design_hash` (Python `design_hash_of`). */
export function idmDesignHash(design: object): string {
  return hashWithout(design, 'design_hash');
}

/** `canonical_hash` of a unit brief without its `brief_hash` (Python `brief_hash_of`). */
export function idmBriefHash(brief: object): string {
  return hashWithout(brief, 'brief_hash');
}

/** Python `block_scope_key`: `idmcb_` + sha256(snapshot ␞ block ␞ sorted fact keys)[:32]. */
export function idmBlockScopeKey(sourceSnapshotHash: string, blockId: string, factKeys: readonly string[]): string {
  const sorted = [...factKeys].sort((left, right) => compareCodePoints(left, right));
  const material = [sourceSnapshotHash, blockId, sorted.join(',')].join('\u001e');
  return IDM_SCOPE_KEY_PREFIX + createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/** Python string ordering (by code point), independent of UTF-16 surrogate layout. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (delta) return delta;
  }
  return a.length - b.length;
}

// --- Primitive readers -----------------------------------------------------------------------
// pydantic-core strips Unicode White_Space (Rust `str::trim`), Python `str.strip` additionally
// strips U+001C..U+001F. IDM models use the former; `ArchitectureComponentAuthorReviewV2` the latter.
const RUST_WHITESPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_WHITESPACE = `${RUST_WHITESPACE}\\u001c-\\u001f`;
const RUST_EDGE_WHITESPACE = new RegExp(`^[${RUST_WHITESPACE}]|[${RUST_WHITESPACE}]$`, 'u');
export const PYTHON_EDGE_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE}]|[${PYTHON_WHITESPACE}]$`, 'u');
export const PYTHON_BLANK = new RegExp(`^[${PYTHON_WHITESPACE}]*$`, 'u');
const RUST_TRIM = new RegExp(`^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`, 'gu');

const BLOCK_ID = /^cb_[0-9]{4}$/;
export const SECTION_ID = /^sec_[0-9]{3}$/;
const LO_ID = /^lo_[1-9][0-9]?$/;
const MUST_DO_ID = /^md_[1-9][0-9]?$/;
export const LESSON_KEY = /^lsn_[0-9]{3}$/;
export const MODULE_KEY = /^mod_[0-9]{2}$/;
export const SCOPE_KEY = /^idmcb_[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const COMPONENT_PLAN_ID = /^cp2_[a-f0-9]{32}$/;
export const PRACTICE_ID = /^pt_[1-9]$/;
export const PATTERN_SECTION_KEY = /^[a-z][a-z_]{1,39}$/;
export const DETERMINISTIC_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

export type Reader<T> = (value: unknown, path: string) => T;

export function invalid(path: string): never {
  throw new IdmError('IDM_CONTRACT_INVALID', path);
}

/** Unicode code point count (Python `len`). */
export function idmTextLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

/** Strip like pydantic `str_strip_whitespace` (Unicode White_Space). */
export function idmStripWhitespace(value: string): string {
  return value.replace(RUST_TRIM, '');
}

const PYTHON_TRIM = new RegExp(`^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`, 'gu');
const PYTHON_SPACE_RUN = new RegExp(`[${PYTHON_WHITESPACE}]+`, 'gu');
/** Python `str.strip()`: the characters for which `str.isspace()` is true. */
export function idmPythonStrip(value: string): string {
  return value.replace(PYTHON_TRIM, '');
}
/** Python `re.sub(r"\s+", " ", value)` (a str pattern's `\s` is `str.isspace()`). */
export function idmPythonCollapseWhitespace(value: string): string {
  return value.replace(PYTHON_SPACE_RUN, ' ');
}
/** Python `len(re.findall(r"\w+", value))`: a str `\w` is `str.isalnum()` or `_`. */
export function idmPythonWordCount(value: string): number {
  return value.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

export function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid(path);
  return record;
}

/** Whether `value` is an object carrying `key` (selects the contract-2 shape of a versioned model). */
export function hasKey(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
}

/** IDM-model string: already stripped by pydantic, so no edge whitespace survives. */
export function text(value: unknown, path: string, minimum: number, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || RUST_EDGE_WHITESPACE.test(value)) return invalid(path);
  const length = idmTextLength(value);
  if (length < minimum || length > maximum || (pattern !== undefined && !pattern.test(value))) invalid(path);
  return value;
}

export function nullableText(value: unknown, path: string, maximum: number, pattern?: RegExp): string | null {
  return value === null ? null : text(value, path, 0, maximum, pattern);
}

/** Non-IDM model string (no stripping): only type and code point length are constrained. */
export function rawText(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') return invalid(path);
  const length = idmTextLength(value);
  if (length < minimum || length > maximum) invalid(path);
  return value;
}

export function oneOf<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(path);
  return value as T;
}

export function integer(value: unknown, path: string, minimum: number, maximum = UNBOUNDED): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(path);
  return value as number;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path);
  return value as boolean;
}

export function list<T>(value: unknown, path: string, minimum: number, maximum: number, item: Reader<T>): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return invalid(path);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

export function dictionary<V>(value: unknown, path: string, key: Reader<string>, item: Reader<V>): Record<string, V> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  // Object.fromEntries defines own data properties, so a `__proto__` key cannot alter the prototype.
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) =>
    [key(name, `${path}{${name}}`), item(entry, `${path}.${name}`)]));
}

export const factKey: Reader<string> = (value, path) => text(value, path, 1, 255);
export const blockId: Reader<string> = (value, path) => text(value, path, 0, 8, BLOCK_ID);
export const loId: Reader<string> = (value, path) => text(value, path, 0, 5, LO_ID);
export const mustDoId: Reader<string> = (value, path) => text(value, path, 0, 5, MUST_DO_ID);
export const sha256: Reader<string> = (value, path) => text(value, path, 0, 64, SHA256);
export const line = (maximum: number): Reader<string> => (value, path) => text(value, path, 1, maximum);
export const anyKey: Reader<string> = (value, path) => text(value, path, 0, UNBOUNDED);
export const nullable = <T>(reader: Reader<T>): Reader<T | null> => (value, path) => value === null ? null : reader(value, path);
