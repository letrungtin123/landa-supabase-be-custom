import assert from 'node:assert/strict';
import test from 'node:test';
import { errorKind, logSwallowedError, swallowAndLog } from './best-effort.js';

// Best-effort failures are recorded with a tag and the error kind only, and
// recording them never changes what the caller does next.

function captureWarn(t: test.TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return lines;
}

test('errorKind is the class name and code, never the message', () => {
  const pgError = Object.assign(new Error('duplicate key value violates "users_email_key" (a@b.c)'), { name: 'DatabaseError', code: '23505' });
  assert.equal(errorKind(pgError), 'DatabaseError:23505');
  assert.equal(errorKind(Object.assign(new Error('/tmp/tenant-a/secret.pdf'), { code: 'ENOENT' })), 'Error:ENOENT');
  assert.equal(errorKind(new TypeError('x')), 'TypeError');
  assert.equal(errorKind('a string with data'), 'string');
  assert.equal(errorKind(undefined), 'undefined');
  assert.equal(errorKind(null), 'null');
  assert.equal(errorKind({ name: 'Weird name <script>', code: 7 }), 'Weird_name__script_:7');
  const hostile = { get name(): string { throw new Error('getter'); } };
  assert.equal(errorKind(hostile), 'object');
});

test('logSwallowedError writes one JSON line with tag and kind only', (t) => {
  const lines = captureWarn(t);
  logSwallowedError('kb.storage_cleanup', Object.assign(new Error('tenant 1111 file x.pdf'), { code: 'ECONNRESET' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[BestEffort\] /);
  assert.deepEqual(JSON.parse(lines[0]!.slice('[BestEffort] '.length)),
    { event: 'best_effort_failed', tag: 'kb.storage_cleanup', error_kind: 'Error:ECONNRESET' });
  assert.doesNotMatch(lines[0]!, /tenant|x\.pdf/);
});

test('a temp file that is already gone is not reported when the caller says so', (t) => {
  const lines = captureWarn(t);
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
  logSwallowedError('kb.temp_file_cleanup', missing, { ignoreMissingFile: true });
  assert.equal(lines.length, 0);
  logSwallowedError('kb.temp_file_cleanup', Object.assign(new Error('busy'), { code: 'EBUSY' }), { ignoreMissingFile: true });
  logSwallowedError('kb.storage_cleanup', missing);
  assert.equal(lines.length, 2);
});

test('logging never throws, even when console.warn does', (t) => {
  t.mock.method(console, 'warn', () => { throw new Error('stdout closed'); });
  assert.doesNotThrow(() => logSwallowedError('x', new Error('y')));
});

test('swallowAndLog keeps `.catch(() => undefined)` control flow: resolves undefined, never rethrows', async (t) => {
  const lines = captureWarn(t);
  const value = await Promise.reject(new Error('cleanup failed')).catch(swallowAndLog('assignments.storage_cleanup'));
  assert.equal(value, undefined);
  assert.equal(await Promise.resolve(42).catch(swallowAndLog('unused')), 42);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"tag":"assignments\.storage_cleanup"/);
});
