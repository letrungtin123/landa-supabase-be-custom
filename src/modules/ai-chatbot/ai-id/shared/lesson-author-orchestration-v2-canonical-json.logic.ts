import { createJsonLogger } from '../../../../utils/json-logger.js';

/**
 * Canonical JSON of the V2/IDM contract hashes (orchestrationV2Hash, idmHash).
 *
 * The encoding: object keys sorted by UTF-16 code unit (Array.prototype.sort),
 * no whitespace, strings and numbers exactly as JSON.stringify writes them.
 * For plain JSON values (strings, finite numbers, booleans, null, arrays,
 * plain objects) the bytes are those of the encoder this module replaced, so
 * every hash already stored still verifies.
 *
 * A stored hash is re-checked against the payload read back from jsonb, i.e.
 * after a JSON round trip. The old encoder also accepted values that do not
 * survive that trip (it wrote an undefined property as `"key":undefined`, an
 * array hole as nothing, a Date as `{}`), so a hash taken on such an
 * in-memory object never verified again. Strict mode refuses those values.
 */

export const CANONICAL_JSON_INVALID = 'CANONICAL_JSON_INVALID' as const;

export type CanonicalJsonViolation =
  | 'undefined'
  | 'array_hole'
  | 'function'
  | 'symbol'
  | 'bigint'
  | 'non_finite_number'
  | 'non_plain_object'
  | 'cycle';

/** A value that is not plain JSON, with the JSON path of the first offending node. */
export class CanonicalJsonError extends Error {
  readonly code = CANONICAL_JSON_INVALID;
  constructor(
    readonly path: string,
    readonly violation: CanonicalJsonViolation,
  ) {
    super(`${CANONICAL_JSON_INVALID}: ${violation} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

type PathSegment = string | number;

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TOKEN_KEY = /^[A-Za-z0-9_$.:-]{1,64}$/;
const MAX_PATH_CHARS = 512;

/**
 * `$.nodes[2].content.data["10"]`. A key that is not a short token (free text
 * a provider or an author may have written) is shown as `[?]`: the path is
 * logged and must carry no learner content.
 */
function formatPath(segments: readonly PathSegment[]): string {
  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${segment}]`;
    else if (IDENTIFIER_KEY.test(segment)) path += `.${segment}`;
    else if (TOKEN_KEY.test(segment)) path += `[${JSON.stringify(segment)}]`;
    else path += '[?]';
    if (path.length > MAX_PATH_CHARS) return `${path.slice(0, MAX_PATH_CHARS - 3)}...`;
  }
  return path;
}

function violationAt(segments: readonly PathSegment[], violation: CanonicalJsonViolation): CanonicalJsonError {
  return new CanonicalJsonError(formatPath(segments), violation);
}

function encodeStrict(value: unknown, segments: PathSegment[], ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw violationAt(segments, 'non_finite_number');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      throw violationAt(segments, 'undefined');
    case 'function':
      throw violationAt(segments, 'function');
    case 'symbol':
      throw violationAt(segments, 'symbol');
    case 'bigint':
      throw violationAt(segments, 'bigint');
    default:
      break;
  }
  if (value === null) return 'null';
  const object = value as object;
  if (ancestors.has(object)) throw violationAt(segments, 'cycle');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const parts = new Array<string>(object.length);
      for (let index = 0; index < object.length; index++) {
        segments.push(index);
        if (!(index in object)) throw violationAt(segments, 'array_hole');
        parts[index] = encodeStrict(object[index], segments, ancestors);
        segments.pop();
      }
      return `[${parts.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw violationAt(segments, 'non_plain_object');
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = new Array<string>(keys.length);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      segments.push(key);
      parts[index] = `${JSON.stringify(key)}:${encodeStrict(record[key], segments, ancestors)}`;
      segments.pop();
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/** The encoder before this module, byte for byte (it returns undefined for a top-level undefined). */
function encodeLegacy(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string | undefined;
  if (Array.isArray(value)) return `[${value.map(encodeLegacy).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${encodeLegacy(record[key])}`)
    .join(',')}}`;
}

function topLevelViolation(value: unknown): CanonicalJsonViolation {
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return 'symbol';
  return 'undefined';
}

/**
 * Canonical JSON text of `value`.
 *
 * - `strict` (the default): throws CanonicalJsonError (code
 *   CANONICAL_JSON_INVALID, JSON path) on undefined, an array hole, a
 *   function, a symbol, a BigInt, NaN/Infinity, an object that is not a plain
 *   object (Date, Map, Buffer, class instance, boxed primitive) or a cycle.
 * - `strict: false`: the previous encoder, byte for byte for every input it
 *   could encode; only a top-level undefined, function or symbol (for which
 *   the previous encoder returned no text at all) throws CanonicalJsonError.
 */
export function canonicalJson(value: unknown, options: { strict?: boolean } = {}): string {
  if (options.strict === false) {
    const text = encodeLegacy(value);
    if (text === undefined) throw new CanonicalJsonError('$', topLevelViolation(value));
    return text;
  }
  return encodeStrict(value, [], new Set());
}

function locateUnserializable(
  value: unknown,
  segments: PathSegment[],
  ancestors: Set<object>,
): CanonicalJsonError | null {
  if (typeof value === 'bigint') return violationAt(segments, 'bigint');
  if (value === null || typeof value !== 'object') return null;
  if (ancestors.has(value)) return violationAt(segments, 'cycle');
  ancestors.add(value);
  try {
    const children: Array<[PathSegment, unknown]> = Array.isArray(value)
      ? value.map((item, index): [PathSegment, unknown] => [index, item])
      : Object.entries(value);
    for (const [segment, child] of children) {
      segments.push(segment);
      const found = locateUnserializable(child, segments, ancestors);
      if (found) return found;
      segments.pop();
    }
    return null;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * `value` exactly as a jsonb column stores and returns it: a JSON round trip
 * (undefined, function and symbol properties dropped, undefined/holes in
 * arrays become null, NaN/Infinity become null, toJSON is applied so a Date
 * becomes its ISO string). Hash this result and store this result.
 * Throws CanonicalJsonError for a BigInt, a cycle, or a top-level value JSON
 * cannot represent.
 */
export function toPersistedJson<T>(value: T): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value) as string | undefined;
  } catch (error) {
    throw locateUnserializable(value, [], new Set()) ?? error;
  }
  if (text === undefined) throw new CanonicalJsonError('$', topLevelViolation(value));
  return JSON.parse(text) as T;
}

/**
 * What the hashing path does with a value that is not plain JSON.
 * - 'log' (the default, for this release): log the violation with its path,
 *   then hash the value as it will be persisted (toPersistedJson). The hash
 *   then matches the stored payload, which is all a reader re-checks.
 * - 'throw': throw the CanonicalJsonError. The AI ID test suites set it
 *   (scripts/test-lesson-author-orchestration-v2.mjs and the test:lesson-author*
 *   scripts of package.json preload src/test-support/strict-canonical-json-hash.ts),
 *   so a producer that builds a non-JSON value fails its tests instead of only logging.
 * The default does not depend on NODE_ENV or any other setting: every
 * production process gets 'log' without having to opt in.
 */
export type CanonicalJsonHashViolationMode = 'log' | 'throw';

export interface CanonicalJsonHashPolicy {
  mode: CanonicalJsonHashViolationMode;
  report(error: CanonicalJsonError): void;
}

const logger = createJsonLogger({ tag: 'LessonAuthorCanonicalJson' });

const DEFAULT_HASH_POLICY: CanonicalJsonHashPolicy = Object.freeze({
  mode: 'log' as const,
  report: (error: CanonicalJsonError) =>
    logger.warn('canonical_json_hash_violation', {
      code: error.code,
      violation: error.violation,
      path: error.path,
      action: 'hashed_as_persisted',
    }),
});

let hashPolicy: CanonicalJsonHashPolicy = DEFAULT_HASH_POLICY;

/** Replace the hashing policy (null restores the default); returns the previous one. */
export function setCanonicalJsonHashPolicy(next: Partial<CanonicalJsonHashPolicy> | null): CanonicalJsonHashPolicy {
  const previous = hashPolicy;
  hashPolicy = next === null ? DEFAULT_HASH_POLICY : Object.freeze({ ...DEFAULT_HASH_POLICY, ...next });
  return previous;
}

/** The canonical text a contract hash is taken over (see CanonicalJsonHashPolicy). */
export function canonicalJsonForHash(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (!(error instanceof CanonicalJsonError) || hashPolicy.mode === 'throw') throw error;
    hashPolicy.report(error);
    return canonicalJson(toPersistedJson(value));
  }
}
