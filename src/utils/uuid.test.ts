import assert from 'node:assert/strict';
import test from 'node:test';
import { isRfcUuid, isUuid, RFC_UUID_PATTERN, UUID_PATTERN } from './uuid.js';

// The shared helpers replaced local copies of these regexes (wave 1 refactor).
// Each group proves the replacement accepts and refuses exactly what the
// replaced copy did, for every call-site form that was rewritten.
const REPLACED_ANY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLACED_RFC = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// config/env.ts optionalUuidCsv: lower-case only, applied after toLowerCase().
const REPLACED_ENV_CSV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const versions = ['0', '1', '4', '5', '6', '7', '8', 'f'];
const variants = ['0', '7', '8', '9', 'a', 'b', 'c', 'f'];
const generated = versions.flatMap(version => variants.map(variant => `2a1f4063-3d34-${version}e1a-${variant}7f3-11ee0ac0a008`));
const STRINGS: string[] = [
  ...generated,
  ...generated.map(value => value.toUpperCase()),
  '2A1f4063-3D34-4e1A-a7F3-11Ee0aC0a008',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '2a1f40633d344e1aa7f311ee0ac0a008',
  '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a00',
  '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a0088',
  '2a1f4063-3d34-4e1a-a7f311ee0ac0a008',
  '2a1f4063-3d34-4e1a-11ee0ac0a008',
  ' 2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
  '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008 ',
  '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008\n',
  '\n2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
  '{2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008}',
  'urn:uuid:2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
  '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a00g',
  'g2a1f063-3d34-4e1a-a7f3-11ee0ac0a008',
  '2a1f4063_3d34_4e1a_a7f3_11ee0ac0a008',
  '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008,2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
  '٢a1f4063-3d34-4e1a-a7f3-11ee0ac0a008',
  'course-v1:A+1+2026',
  'not-a-uuid',
  'undefined',
  'null',
  '',
];
const UUID = '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008';
const NON_STRINGS: unknown[] = [undefined, null, 0, 1, true, {}, [], [UUID], [[UUID]], { toString: () => UUID }, new String(UUID), Symbol('x')];

test('the shared patterns are the replaced regexes, character for character', () => {
  assert.equal(UUID_PATTERN.source, REPLACED_ANY_SHAPE.source);
  assert.equal(UUID_PATTERN.flags, REPLACED_ANY_SHAPE.flags);
  assert.equal(RFC_UUID_PATTERN.source, REPLACED_RFC.source);
  assert.equal(RFC_UUID_PATTERN.flags, REPLACED_RFC.flags);
  // No g/y flag: one shared instance keeps no state between calls.
  assert.equal(UUID_PATTERN.global || UUID_PATTERN.sticky || RFC_UUID_PATTERN.global || RFC_UUID_PATTERN.sticky, false);
});

test('any-shape group: R.test(x) sites keep the same answer for every string', () => {
  for (const value of STRINGS) {
    assert.equal(UUID_PATTERN.test(value), REPLACED_ANY_SHAPE.test(value), JSON.stringify(value));
    assert.equal(isUuid(value), REPLACED_ANY_SHAPE.test(value), JSON.stringify(value));
  }
  // A shared instance answers the same when called again (no lastIndex state).
  for (const value of STRINGS) assert.equal(UUID_PATTERN.test(value), REPLACED_ANY_SHAPE.test(value));
});

test('any-shape group: `typeof x === "string" && R.test(x)` became isUuid(x), for every value', () => {
  for (const value of [...STRINGS, ...NON_STRINGS]) {
    const before = typeof value === 'string' && REPLACED_ANY_SHAPE.test(value);
    assert.equal(isUuid(value), before, String(typeof value === 'symbol' ? 'symbol' : value));
    // Negated form: `typeof x !== "string" || !R.test(x)` became !isUuid(x).
    assert.equal(!isUuid(value), typeof value !== 'string' || !REPLACED_ANY_SHAPE.test(value));
  }
});

test('any-shape group: R.test(x) on a non-string still converts it, so those sites kept `.test()`', () => {
  // Documents why only guarded call sites moved to isUuid(): the regex accepts
  // a value whose string form is a UUID, isUuid refuses every non-string.
  for (const value of NON_STRINGS.filter(item => typeof item !== 'symbol')) {
    assert.equal(UUID_PATTERN.test(value as string), REPLACED_ANY_SHAPE.test(value as string));
  }
  assert.equal(UUID_PATTERN.test([UUID] as unknown as string), true);
  assert.equal(isUuid([UUID]), false);
});

test('RFC group: version 1-5 and variant 8/9/a/b only, same answers as the replaced copies', () => {
  for (const value of [...STRINGS, ...NON_STRINGS]) {
    if (typeof value === 'string') {
      assert.equal(RFC_UUID_PATTERN.test(value), REPLACED_RFC.test(value), value);
      assert.equal(isRfcUuid(value), REPLACED_RFC.test(value), value);
    }
    assert.equal(isRfcUuid(value), typeof value === 'string' && REPLACED_RFC.test(value));
  }
  assert.equal(isRfcUuid('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(isRfcUuid('2a1f4063-3d34-8e1a-a7f3-11ee0ac0a008'), false);
  assert.equal(isRfcUuid(UUID), true);
});

test('env CSV group: a lower-cased item is a UUID for isUuid exactly when the lower-case-only regex matched', () => {
  for (const value of STRINGS) {
    const item = value.toLowerCase();
    assert.equal(isUuid(item), REPLACED_ENV_CSV.test(item), JSON.stringify(value));
  }
});
