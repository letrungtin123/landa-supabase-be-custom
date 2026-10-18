import assert from 'node:assert/strict';
import test from 'node:test';
import { bestEffort, bestEffortSync, errorKind, logSwallowedError, swallowAndLog } from './best-effort.js';

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

test('bestEffort returns the result of work that succeeds, sync or async, and logs nothing', async (t) => {
  const lines = captureWarn(t);
  assert.equal(await bestEffort('x', async () => 7), 7);
  assert.equal(await bestEffort('x', () => 'sync'), 'sync');
  assert.equal(await bestEffort('x', () => undefined), undefined);
  assert.equal(lines.length, 0);
});

test('bestEffort: a rejection or a throw resolves undefined and is logged by tag and kind, never by message', async (t) => {
  const lines = captureWarn(t);
  const secret = 'FAKE-SECRET-3c1d tenant 1111 avatars/a.png';
  assert.equal(await bestEffort('library.document_storage_cleanup', async () => {
    throw Object.assign(new Error(secret), { code: 'ECONNRESET' });
  }), undefined);
  assert.equal(await bestEffort('users.avatar_cleanup', () => { throw new TypeError(secret); }), undefined);
  assert.equal(await bestEffort('x', () => Promise.reject(secret)), undefined);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(line => JSON.parse(line.slice('[BestEffort] '.length))), [
    { event: 'best_effort_failed', tag: 'library.document_storage_cleanup', error_kind: 'Error:ECONNRESET' },
    { event: 'best_effort_failed', tag: 'users.avatar_cleanup', error_kind: 'TypeError' },
    { event: 'best_effort_failed', tag: 'x', error_kind: 'string' },
  ]);
  assert.doesNotMatch(lines.join('\n'), /FAKE-SECRET|tenant|avatars/);
});

test('bestEffort keeps ignoreMissingFile', async (t) => {
  const lines = captureWarn(t);
  await bestEffort('kb.temp_file_cleanup', async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, { ignoreMissingFile: true });
  assert.equal(lines.length, 0);
});

test('bestEffortSync: result, or undefined and one log line on a throw', (t) => {
  const lines = captureWarn(t);
  assert.equal(bestEffortSync('x', () => 3), 3);
  assert.equal(bestEffortSync('json.parse', () => JSON.parse('{"password":FAKE-SECRET}') as unknown), undefined);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!.slice('[BestEffort] '.length)), { event: 'best_effort_failed', tag: 'json.parse', error_kind: 'SyntaxError' });
  assert.doesNotMatch(lines[0]!, /FAKE-SECRET|password/);
});

test('bestEffortSync: a promise returned by mistake is not left unhandled', async (t) => {
  const lines = captureWarn(t);
  assert.equal(bestEffortSync('x', () => Promise.reject(new RangeError('late'))), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"error_kind":"RangeError"/);
});
