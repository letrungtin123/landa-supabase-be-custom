import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonLogger, formatLogRecord, type LogLevel } from './json-logger.js';

// BE-S14: one `[Tag] {json}` line per record, event/level/ts first, never throws.

function capture() {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  return { lines, write: (level: LogLevel, line: string) => lines.push({ level, line }) };
}
const fixedNow = () => new Date('2026-10-19T01:02:03.004Z');

test('a record is [Tag] then JSON with event, level and ts first, then the logger and call fields', () => {
  const out = capture();
  const logger = createJsonLogger({ tag: 'Heartbeat', fields: { role: 'background', pid: 7 }, write: out.write, now: fixedNow });
  logger.info('process_heartbeat', { uptime_seconds: 12 });
  assert.deepEqual(out.lines, [{
    level: 'info',
    line: '[Heartbeat] {"event":"process_heartbeat","level":"info","ts":"2026-10-19T01:02:03.004Z","role":"background","pid":7,"uptime_seconds":12}',
  }]);
  const json = JSON.parse(out.lines[0].line.slice('[Heartbeat] '.length));
  assert.equal(json.event, 'process_heartbeat');
});

test('levels go to their own writer level; fields cannot replace event, level or ts', () => {
  const out = capture();
  const logger = createJsonLogger({ tag: 'X', write: out.write, now: fixedNow });
  logger.warn('slow', { event: 'other', level: 'debug', ts: 'never', ms: 5 });
  logger.error('failed');
  assert.deepEqual(out.lines.map((entry) => entry.level), ['warn', 'error']);
  assert.equal(out.lines[0].line, '[X] {"event":"slow","level":"warn","ts":"2026-10-19T01:02:03.004Z","ms":5}');
});

test('child loggers add fields; the call fields win over the logger fields', () => {
  const out = capture();
  const child = createJsonLogger({ tag: 'W', fields: { a: 1 }, write: out.write, now: fixedNow }).child({ b: 2 });
  child.info('e', { a: 3 });
  assert.equal(out.lines[0].line, '[W] {"event":"e","level":"info","ts":"2026-10-19T01:02:03.004Z","a":3,"b":2}');
});

test('errors, bigints and circular values are serialized; nothing throws', () => {
  const error = Object.assign(new Error('boom'), { code: 'E_X' });
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  const text = formatLogRecord({ event: 'e', error, big: 12n, circular, missing: undefined });
  assert.deepEqual(JSON.parse(text), {
    event: 'e',
    error: { name: 'Error', message: 'boom', code: 'E_X' },
    big: '12',
    circular: { name: 'loop', self: '[Circular]' },
  });
  const throwing = { toJSON() { throw new Error('no'); } };
  assert.equal(formatLogRecord({ event: 'e', level: 'info', ts: 't', throwing }), '{"event":"e","level":"info","ts":"t","log_error":"unserializable_fields"}');
});

test('the default writer is the console (PM2 log files)', (t) => {
  const seen: string[] = [];
  t.mock.method(console, 'log', (line: string) => { seen.push(`log ${line}`); });
  t.mock.method(console, 'warn', (line: string) => { seen.push(`warn ${line}`); });
  t.mock.method(console, 'error', (line: string) => { seen.push(`error ${line}`); });
  const logger = createJsonLogger({ tag: 'T', now: fixedNow });
  logger.info('a');
  logger.warn('b');
  logger.error('c');
  assert.deepEqual(seen.map((line) => line.split(' ')[0] + ' ' + JSON.parse(line.slice(line.indexOf('{'))).event), ['log a', 'warn b', 'error c']);
});
