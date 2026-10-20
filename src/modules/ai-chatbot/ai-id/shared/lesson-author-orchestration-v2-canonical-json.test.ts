import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CANONICAL_JSON_INVALID,
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonForHash,
  setCanonicalJsonHashPolicy,
  toPersistedJson,
  type CanonicalJsonViolation,
} from './lesson-author-orchestration-v2-canonical-json.logic.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { idmHash } from '../contracts/lesson-author-idm-primitives.contract.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { workspaceHashMatches } from '../content/lesson-author-workspace.logic.js';

/** The encoder orchestrationV2Hash used before canonical-json.logic, frozen here as the oracle. */
function previousCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(previousCanonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${previousCanonical(record[key])}`).join(',')}}`;
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** An array with a hole at each `holes` index (array literals with elisions are a lint error). */
function holey(length: number, holes: readonly number[]): unknown[] {
  const list = new Array<unknown>(length);
  for (let index = 0; index < length; index++) if (!holes.includes(index)) list[index] = index;
  return list;
}

/** mulberry32: a small seeded PRNG, so a failure names the seed that reproduces it. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const STRINGS = ['', 'a', 'Thiết kế', 'Thie\u0302\u0301t ke\u0302\u0301', 'Việt Nam', 'Vie\u0323\u0302t', '😀', '𝒜', 'line\u2028sep\u2029',
  'ctl\u0000\u0001\b\f\n\r\t\u001f\u007f', '"quoted" \\ back', '<tag> & </script>', 'ﬁ', '\uffff'];
const KEYS = ['a', 'b', 'z', 'A', '_', '$', '0', '1', '2', '10', '01', '-1', '1.5', '4294967294', '4294967295', 'đ', 'é',
  'ﬁ', '😀', '𝒜', 'k\u2028', 'data', 'label', '__proto__', 'constructor', 'toString', ' space'];
const NUMBERS = [0, -0, 1, -1, 7, 0.5, 0.1, 1.5, -2.25, 5e-5, 1e-7, 1.5e-7, 123.456, 1e16, 1e20, 1e21, 1.7976931348623157e308,
  5e-324, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, 123456789012345680000];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function jsonValue(next: () => number, depth: number): Json {
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const roll = next();
  if (depth <= 0 || roll < 0.45) {
    const scalar = next();
    if (scalar < 0.1) return null;
    if (scalar < 0.2) return next() < 0.5;
    if (scalar < 0.55) return next() < 0.5 ? pick(NUMBERS) : (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20);
    return next() < 0.7 ? pick(STRINGS) : String.fromCodePoint(...Array.from({ length: Math.floor(next() * 6) },
      () => Math.floor(next() * 0x10ffff)).filter(code => code < 0xd800 || code > 0xdfff));
  }
  if (roll < 0.7) return Array.from({ length: Math.floor(next() * 5) }, () => jsonValue(next, depth - 1));
  const object: Record<string, Json> = {};
  for (let index = Math.floor(next() * 6); index > 0; index--) {
    Object.defineProperty(object, pick(KEYS), { value: jsonValue(next, depth - 1), enumerable: true,
      configurable: true, writable: true });
  }
  return object;
}

function shuffled(value: Json, next: () => number): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => shuffled(item, next));
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [entries[index], entries[other]] = [entries[other]!, entries[index]!];
  }
  const object: Record<string, Json> = {};
  for (const [key, item] of entries) {
    Object.defineProperty(object, key, { value: shuffled(item, next), enumerable: true, configurable: true, writable: true });
  }
  return object;
}

function withPolicy<T>(policy: Parameters<typeof setCanonicalJsonHashPolicy>[0], run: () => T): T {
  const previous = setCanonicalJsonHashPolicy(policy);
  try { return run(); } finally { setCanonicalJsonHashPolicy(previous); }
}

test('plain JSON: canonicalJson is byte-identical to the previous encoder, stable across a JSON round trip and key order', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = random(seed);
    const value = jsonValue(next, 5);
    const expected = previousCanonical(value);
    assert.equal(canonicalJson(value), expected, `seed ${seed}`);
    assert.equal(canonicalJson(value, { strict: false }), expected, `seed ${seed}`);
    assert.equal(canonicalJson(roundTrip(value)), expected, `seed ${seed}: round trip`);
    assert.equal(canonicalJson(shuffled(value, next)), expected, `seed ${seed}: shuffled keys`);
    assert.deepEqual(toPersistedJson(value), roundTrip(value), `seed ${seed}`);
    const hash = orchestrationV2Hash(value);
    assert.equal(hash, sha256(expected), `seed ${seed}: hash`);
    assert.equal(orchestrationV2Hash(roundTrip(value)), hash, `seed ${seed}: hash after round trip`);
    assert.equal(idmHash(value), hash, `seed ${seed}: idmHash`);
  }
});

test('the hashes stored before this module still verify (pinned digests of the previous encoder)', () => {
  // Digests computed with the encoder this module replaced; a change here would orphan stored hashes.
  const pinned: Array<[unknown, string]> = [
    [{ b: [1, 'đ'], a: null }, sha256('{"a":null,"b":[1,"đ"]}')],
    [{ z: { y: [true, false, 0, -0, 0.5, 5e-5, 1e16, 1e21] }, 'ﬁ': 1, '😀': 2 },
      sha256('{"z":{"y":[true,false,0,0,0.5,0.00005,10000000000000000,1e+21]},"😀":2,"ﬁ":1}')],
    [['Thiết kế', 'Thie\u0302\u0301t ke\u0302\u0301', '\u2028', 9007199254740991], sha256(
      '["Thiết kế","Thie\u0302\u0301t ke\u0302\u0301","\u2028",9007199254740991]')],
  ];
  for (const [value, digest] of pinned) {
    assert.equal(orchestrationV2Hash(value), digest);
    assert.equal(sha256(previousCanonical(value)), digest);
  }
});

const BAD: Array<[string, () => unknown, CanonicalJsonViolation, string]> = [
  ['undefined property', () => ({ a: { b: undefined } }), 'undefined', '$.a.b'],
  ['undefined item', () => ({ list: [1, undefined] }), 'undefined', '$.list[1]'],
  ['array hole', () => ({ list: holey(3, [1]) }), 'array_hole', '$.list[1]'],
  ['function', () => ({ fn: () => 1 }), 'function', '$.fn'],
  ['symbol', () => ({ s: Symbol('x') }), 'symbol', '$.s'],
  ['bigint', () => ({ big: 1n }), 'bigint', '$.big'],
  ['NaN', () => ({ n: [Number.NaN] }), 'non_finite_number', '$.n[0]'],
  ['Infinity', () => ({ n: Number.POSITIVE_INFINITY }), 'non_finite_number', '$.n'],
  ['-Infinity', () => ({ n: Number.NEGATIVE_INFINITY }), 'non_finite_number', '$.n'],
  ['Date', () => ({ at: new Date(0) }), 'non_plain_object', '$.at'],
  ['Map', () => ({ m: new Map([['a', 1]]) }), 'non_plain_object', '$.m'],
  ['Set', () => ({ s: new Set([1]) }), 'non_plain_object', '$.s'],
  ['Buffer', () => ({ b: Buffer.from('ab') }), 'non_plain_object', '$.b'],
  ['class instance', () => ({ c: new (class Point { x = 1; })() }), 'non_plain_object', '$.c'],
  ['boxed string', () => ({ s: new String('x') }), 'non_plain_object', '$.s'],
  ['integer-like key', () => ({ data: { 10: undefined } }), 'undefined', '$.data["10"]'],
  ['free-text key is not logged', () => ({ data: { 'Người học': undefined } }), 'undefined', '$.data[?]'],
  ['object cycle', () => { const a: Record<string, unknown> = {}; a.self = { a }; return a; }, 'cycle', '$.self.a'],
  ['array cycle', () => { const a: unknown[] = []; a.push(a); return { a }; }, 'cycle', '$.a[0]'],
  ['top-level undefined', () => undefined, 'undefined', '$'],
];

test('strict canonicalJson throws CANONICAL_JSON_INVALID with the JSON path of each value JSON cannot keep', () => {
  for (const [name, make, violation, path] of BAD) {
    assert.throws(() => canonicalJson(make()), (error: unknown) => {
      assert.ok(error instanceof CanonicalJsonError, name);
      assert.equal(error.code, CANONICAL_JSON_INVALID, name);
      assert.equal(error.violation, violation, name);
      assert.equal(error.path, path, name);
      return true;
    }, name);
  }
});

test('non-strict canonicalJson keeps the previous bytes for values that are not plain JSON', () => {
  for (const value of [{ a: undefined, b: 1 }, holey(4, [1]), [undefined, 2], { at: new Date(0) }, { m: new Map(), n: Number.NaN },
    { f: () => 1, s: Symbol('x') }, { b: Buffer.from('ab') }]) {
    assert.equal(canonicalJson(value, { strict: false }), previousCanonical(value));
  }
  assert.throws(() => canonicalJson(undefined, { strict: false }), CanonicalJsonError);
});

test('toPersistedJson is the jsonb round trip: undefined dropped, holes and NaN null, toJSON applied', () => {
  class Money { amount = 5; toJSON() { return `${this.amount} VND`; } }
  const list = holey(2, [1]);
  list.push(undefined, Number.NaN, () => 1);
  const value = { a: undefined, list, at: new Date(Date.UTC(2026, 9, 20)),
    price: new Money(), nested: { keep: 'x', drop: undefined, s: Symbol('x') } };
  assert.deepEqual(toPersistedJson(value), { list: [0, null, null, null, null], at: '2026-10-20T00:00:00.000Z',
    price: '5 VND', nested: { keep: 'x' } });
  assert.deepEqual(toPersistedJson(value), roundTrip(value));
  assert.throws(() => toPersistedJson({ deep: [{ big: 2n }] }),
    (error: unknown) => error instanceof CanonicalJsonError && error.path === '$.deep[0].big' && error.violation === 'bigint');
  const cyclic: Record<string, unknown> = { list: [] };
  (cyclic.list as unknown[]).push(cyclic);
  assert.throws(() => toPersistedJson(cyclic),
    (error: unknown) => error instanceof CanonicalJsonError && error.path === '$.list[0]' && error.violation === 'cycle');
  assert.throws(() => toPersistedJson(undefined), (error: unknown) => error instanceof CanonicalJsonError && error.path === '$');
});

test('hashing path, default policy: a violation is logged with its path, then hashed exactly as persisted', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const plain = { root: jsonValue(next, 4), list: [jsonValue(next, 2)] };
    // The pre-fix diagram edge: a label key whose value is undefined.
    const edge = { id: 'edge_1', source: 'node_1', target: 'node_2', label: undefined as string | undefined };
    const value = { ...plain, edges: [edge], at: new Date(seed * 1_000), dropped: undefined };
    const logs: Array<{ path: string; violation: string }> = [];
    const hash = withPolicy({ mode: 'log', report: error => logs.push({ path: error.path, violation: error.violation }) },
      () => orchestrationV2Hash(value));
    assert.equal(hash, orchestrationV2Hash(roundTrip(value)), `seed ${seed}`);
    assert.notEqual(sha256(previousCanonical(value)), hash, `seed ${seed}: the previous encoder did not match the stored JSON`);
    // Strict encoding stops at the first violation in key order: the Date.
    assert.deepEqual(logs, [{ path: '$.at', violation: 'non_plain_object' }], `seed ${seed}`);
    const withoutDate = { ...value, at: value.at.toISOString() };
    logs.length = 0;
    withPolicy({ mode: 'log', report: error => logs.push({ path: error.path, violation: error.violation }) },
      () => assert.equal(orchestrationV2Hash(withoutDate), hash, `seed ${seed}`));
    assert.deepEqual(logs, [{ path: '$.dropped', violation: 'undefined' }], `seed ${seed}`);
  }
});

test('hashing path, default policy writes one structured warning line with code, violation and path only', t => {
  const lines: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { lines.push(line); });
  const hash = withPolicy(null, () => orchestrationV2Hash({ title: 'Bài học', data: { edges: [{ label: undefined }] } }));
  assert.equal(hash, orchestrationV2Hash({ title: 'Bài học', data: { edges: [{}] } }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[LessonAuthorCanonicalJson\] \{/);
  const record = JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{'))) as Record<string, unknown>;
  assert.deepEqual({ event: record.event, level: record.level, code: record.code, violation: record.violation,
    path: record.path, action: record.action }, { event: 'canonical_json_hash_violation', level: 'warn',
    code: 'CANONICAL_JSON_INVALID', violation: 'undefined', path: '$.data.edges[0].label',
    action: 'hashed_as_persisted' });
  assert.ok(!lines[0]!.includes('Bài học'), 'no content in the log line');
});

test('the AI ID test suites run with the throw policy (preloaded); production keeps the log default', () => {
  const current = setCanonicalJsonHashPolicy(null);
  const restored = setCanonicalJsonHashPolicy(current);
  assert.equal(current.mode, 'throw', 'run this file through npm run test:lesson-author-orchestration-v2 (it preloads '
    + 'src/test-support/strict-canonical-json-hash.ts)');
  assert.equal(restored.mode, 'log', 'the default policy logs and hashes the value as persisted');
});

test('hashing path, throw policy: a violation throws instead of being logged', () => {
  const logs: string[] = [];
  withPolicy({ mode: 'throw', report: error => logs.push(error.path) }, () => {
    assert.throws(() => orchestrationV2Hash({ a: [1, undefined] }),
      (error: unknown) => error instanceof CanonicalJsonError && error.path === '$.a[1]');
    assert.throws(() => canonicalJsonForHash({ at: new Date(0) }), CanonicalJsonError);
    assert.equal(orchestrationV2Hash({ a: [1, null] }), sha256('{"a":[1,null]}'));
  });
  assert.deepEqual(logs, []);
  // A value the round trip cannot represent still fails in either mode, as before.
  for (const mode of ['log', 'throw'] as const) {
    withPolicy({ mode, report: () => undefined }, () => {
      assert.throws(() => orchestrationV2Hash({ big: 1n }), CanonicalJsonError);
      assert.throws(() => orchestrationV2Hash(undefined), CanonicalJsonError);
    });
  }
});

test('generationSnapshotHash and orchestrationV2Hash agree on plain JSON except integer-like keys; verifiers accept either', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const value = jsonValue(random(seed), 5);
    const integerLike = /"(?:0|[1-9][0-9]*)":/.test(JSON.stringify(value));
    if (!integerLike) assert.equal(generationSnapshotHash(value), orchestrationV2Hash(value), `seed ${seed}`);
    assert.ok(workspaceHashMatches(value, generationSnapshotHash(value)), `seed ${seed}`);
    assert.ok(workspaceHashMatches(value, orchestrationV2Hash(value)), `seed ${seed}`);
  }
  const content = { title: 'Bảng', purpose: null, implementation_notes: null, data: { rows: { 10: 'b', 2: 'a' } } };
  assert.notEqual(generationSnapshotHash(content), orchestrationV2Hash(content));
  assert.ok(workspaceHashMatches(content, generationSnapshotHash(content)));
  assert.ok(workspaceHashMatches(content, orchestrationV2Hash(content)));
  assert.ok(!workspaceHashMatches({ ...content, title: 'Khác' }, orchestrationV2Hash(content)));
  assert.ok(!workspaceHashMatches(content, 'not-a-hash'));
  assert.ok(!workspaceHashMatches(content, null));
});
