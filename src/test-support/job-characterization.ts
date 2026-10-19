// Test only: the harness of the background job characterization tests
// (golden digests), for the jobs that move onto src/platform/job-runner.
//
// A case drives a job's worker or service functions with doubles in place of
// PostgreSQL, RabbitMQ, Redis, fetch (Storage, the AI service) and the clock,
// and records every event in order:
//   - each SQL statement: its exact text (CRLF read as LF: a Windows checkout
//     has CRLF in the source), its parameters and where it went (the pool or
//     client:1, client:2, ...), plus each client checkout, listener and release;
//   - each RabbitMQ prefetch, consume, publish, ack and nack;
//   - each Redis command with its arguments;
//   - each fetch request (method, path, body);
//   - each log line;
//   - each interval started or cleared, with its period (and each timeout,
//     when the suite fakes setTimeout), and the marks a case sets while it
//     moves the fake clock;
//   - the result, or the error thrown.
// UUIDs other than the suite's fixed ones are numbered by first appearance
// (<uuid-1>, <uuid-2>, ...), so a lease token stays one token in a case.
// The outcome is reduced to a sha256 digest and compared with the golden
// file, which was written by the code before the change under test.
//
// Import this module dynamically, after the test has set process.env: it
// loads the database, Redis and RabbitMQ config and connects the RabbitMQ
// double.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import amqp from 'amqplib';
import pg from 'pg';
import { pool } from '../config/database.js';
import * as rabbit from '../config/rabbitmq/index.js';
import * as redis from '../config/redis.js';

export type JobEvent = Record<string, unknown>;

let events: JobEvent[] = [];
let recordingCase = false;

export function record(event: JobEvent): void {
  if (recordingCase) events.push(event);
}

/** A JSON-safe copy: an Error becomes { error, code }, a Buffer its length, undefined null. */
export function describe(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Error) return { error: value.message, code: (value as { code?: unknown }).code ?? null };
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return '<function>';
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}>`;
  if (typeof value !== 'object' || value === null) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error) return { error: item.message, code: (item as { code?: unknown }).code ?? null };
      if (typeof item === 'bigint') return `${item}n`;
      if (Buffer.isBuffer(item)) return `<buffer ${item.length}>`;
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'Buffer') {
        return `<buffer ${((item as { data?: unknown[] }).data ?? []).length}>`;
      }
      return item;
    }) ?? 'null',
  );
}

// ── PostgreSQL double ──

export interface SqlResult {
  rows: unknown[];
  rowCount?: number;
}
/** The answer to one statement; undefined: no rows. */
export type SqlAnswer = (text: string, params: unknown[]) => SqlResult | Error | Promise<SqlResult | Error> | undefined;
type SqlValue =
  unknown[] | SqlResult | Error | (() => unknown[] | SqlResult | Error | Promise<unknown[] | SqlResult | Error>);

function toResult(value: unknown[] | SqlResult | Error): SqlResult | Error {
  return Array.isArray(value) ? { rows: value } : value;
}

/**
 * Answers by pattern, first match wins. A value is the rows, a result with
 * its rowCount, an Error to throw, or a function called per statement (for
 * sequences and gates).
 */
export function answers(table: Array<[RegExp, SqlValue]>): SqlAnswer {
  return text => {
    for (const [pattern, value] of table) {
      if (!pattern.test(text)) continue;
      const resolved = typeof value === 'function' ? value() : value;
      return resolved instanceof Promise ? resolved.then(toResult) : toResult(resolved);
    }
    return undefined;
  };
}

/** The values one after another; the last one repeats. */
export function sequence(...values: Array<unknown[] | SqlResult | Error>): () => unknown[] | SqlResult | Error {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

export function sqlError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}

function installDb(t: TestContext, answer: SqlAnswer | undefined): void {
  let clients = 0;
  const handler =
    (via: string) =>
    async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
      const raw = typeof config === 'string' ? config : config.text;
      const params = typeof config === 'string' ? values : (config.values ?? []);
      // Exact text except line endings: a Windows checkout (core.autocrlf) has CRLF in the source.
      const text = raw.replace(/\r\n/g, '\n');
      record({ via, sql: text, params: describe(params) });
      let answered = answer?.(text, params);
      if (answered instanceof Promise) answered = await answered;
      if (answered instanceof Error) throw answered;
      // A copy per statement: the code under test may change the rows it reads.
      const rows = structuredClone(answered?.rows ?? []);
      return { rows, rowCount: answered?.rowCount ?? rows.length };
    };
  t.mock.method(
    pg.Pool.prototype,
    'query',
    function (this: unknown, config: string | { text: string }, values?: unknown[]) {
      return handler(this === pool ? 'pool' : 'other-pool')(config, values);
    },
  );
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: unknown) {
    const via = `${this === pool ? 'client' : 'other-client'}:${++clients}`;
    record({ connect: via });
    const client = {
      query: handler(via),
      on(event: string) {
        record({ listen: via, event });
        return client;
      },
      off(event: string) {
        record({ unlisten: via, event });
        return client;
      },
      release(error?: unknown) {
        record({ release: via, error: error === undefined ? null : describe(error) });
      },
    };
    return client;
  });
}

// ── RabbitMQ double ──

let publishFails = false;
const consumers = new Map<string, (msg: unknown) => Promise<void>>();

const channel = {
  sendToQueue(queue: string, content: Buffer, options: unknown, callback?: (error: Error | null) => void) {
    record({ publish: queue, payload: content.toString(), options: describe(options) });
    callback?.(publishFails ? new Error('broker refused') : null);
    return true;
  },
  async prefetch(count: number) {
    record({ prefetch: count });
  },
  async consume(queue: string, handler: (msg: unknown) => Promise<void>) {
    record({ consume: queue });
    consumers.set(queue, handler);
    return { consumerTag: `tag-${queue}` };
  },
  ack(msg: { content: Buffer }) {
    record({ ack: msg.content.toString() });
  },
  nack(msg: { content: Buffer }, allUpTo: boolean, requeue: boolean) {
    record({ nack: msg.content.toString(), allUpTo, requeue });
  },
  async cancel() {},
  async close() {},
  async assertQueue() {},
  on() {},
};
const connection = {
  async createConfirmChannel() {
    return channel;
  },
  on() {},
  async close() {},
};

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
// Outside a case the console is silent (connections, teardown).
for (const method of consoleMethods) {
  const original = console[method];
  console[method] = () => undefined;
  test.after(() => {
    console[method] = original;
  });
}

const realConnect = amqp.connect;
(amqp as { connect: unknown }).connect = async () => connection;
await rabbit.connectRabbitMQ('amqp://double');
(amqp as { connect: unknown }).connect = realConnect;

// ── Redis double ──

export type RedisAnswer = (command: string, args: unknown[]) => unknown;
const defaultRedisAnswer: RedisAnswer = command =>
  command === 'incr' || command === 'del' ? 1 : command === 'set' ? 'OK' : null;
let redisAnswer: RedisAnswer = defaultRedisAnswer;

const redisClient = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'isOpen' || property === 'isReady') return true;
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return async (...args: unknown[]) => {
        record({ redis: property, args: describe(args) });
        const value = redisAnswer(property, args);
        if (value instanceof Error) throw value;
        return value;
      };
    },
  },
);
redis.installRedisClient(redisClient as Parameters<typeof redis.installRedisClient>[0]);

// ── fetch double (Storage, AI service) ──

export type FetchAnswer = (method: string, path: string, body: string | null) => Response | Error | undefined;
let fetchAnswer: FetchAnswer | undefined;

function describeBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return `<buffer ${body.length}>`;
  return `<${(body as object).constructor?.name ?? typeof body}>`;
}

globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const body = describeBody(init?.body);
  record({ fetch: `${method} ${path}`, body });
  const answered = fetchAnswer?.(method, path, body);
  if (answered instanceof Error) throw answered;
  return (
    answered ??
    new globalThis.Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  );
}) as typeof fetch;

test.after(async () => {
  redis.installRedisClient(null);
  await rabbit.closeRabbitMQ();
  await pool.end();
});

// ── Cases ──

export type TimerApi = 'setInterval' | 'setTimeout' | 'Date';

export interface Gate {
  /** Resolves with `value` once open() is called. */
  wait<T>(value: T): Promise<T>;
  open(): void;
}

export interface JobCaseContext {
  t: TestContext;
  mark(label: string): void;
  /** Lets every pending promise chain run. */
  settle(): Promise<void>;
  /** Moves the fake clock (setInterval / setTimeout / Date) and settles. */
  tick(ms: number): Promise<void>;
  /** Hands a message to the consumer of `queue`, as RabbitMQ would. */
  deliver(queue: string, body: unknown, retries?: number): Promise<void>;
  setPublishFails(fails: boolean): void;
  setRedis(answer: RedisAnswer): void;
  setFetch(answer: FetchAnswer): void;
  gate(): Gate;
}

export interface JobCase {
  name: string;
  sql?: SqlAnswer;
  run(context: JobCaseContext): Promise<unknown> | unknown;
}

export interface JobSuite {
  /** Shown in each test name. */
  title: string;
  goldenPath: string;
  /** Environment variable that rewrites the golden file when it is "1". */
  writeEnv: string;
  /** Environment variable naming a file that receives every outcome in full. */
  fullOutEnv: string;
  cases: JobCase[];
  /** UUIDs of the test, kept as they are; every other UUID is numbered. */
  fixedIds: string[];
  /** The fake clock of case n starts n hours after `now` (process caches of an hour or less have expired). */
  now: number;
  /** Faked timer APIs; default setInterval and Date. */
  timers?: TimerApi[];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(resolve => setImmediate(resolve));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function numberUuids(json: string, fixed: Set<string>): string {
  const seen = new Map<string, string>();
  return json.replace(UUID, id => {
    const key = id.toLowerCase();
    if (fixed.has(key)) return id;
    if (!seen.has(key)) seen.set(key, `<uuid-${seen.size + 1}>`);
    return seen.get(key)!;
  });
}

/** Records every interval (and faked timeout) started or cleared, until the returned function runs. */
function recordTimers(apis: TimerApi[]): () => void {
  const saved = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.setInterval = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    record({ setInterval: ms ?? null });
    return saved.setInterval(callback, ms, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    record({ clearInterval: true });
    return saved.clearInterval(timer);
  }) as typeof clearInterval;
  if (apis.includes('setTimeout')) {
    globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
      record({ setTimeout: ms ?? null });
      return saved.setTimeout(callback, ms, ...args);
    }) as typeof setTimeout;
  }
  return () => {
    Object.assign(globalThis, saved);
  };
}

export function registerJobCharacterization(suite: JobSuite): void {
  const fixed = new Set(suite.fixedIds.map(id => id.toLowerCase()));
  const apis = suite.timers ?? ['setInterval', 'Date'];
  const write = process.env[suite.writeEnv] === '1';
  const fullOut = process.env[suite.fullOutEnv]?.trim() || '';
  const golden: Record<string, string> = existsSync(suite.goldenPath)
    ? (JSON.parse(readFileSync(suite.goldenPath, 'utf8')) as Record<string, string>)
    : {};
  const written: Record<string, string> = {};
  const full: Record<string, unknown> = {};

  test(`${suite.title}: the case names are unique`, () => {
    assert.equal(new Set(suite.cases.map(item => item.name)).size, suite.cases.length);
  });

  for (const [index, item] of suite.cases.entries()) {
    test(`${suite.title}: ${item.name}`, async t => {
      events = [];
      publishFails = false;
      redisAnswer = defaultRedisAnswer;
      fetchAnswer = undefined;
      consumers.clear();
      installDb(t, item.sql);
      for (const level of consoleMethods) {
        t.mock.method(console, level, (...args: unknown[]) => {
          record({ [level]: args.map(describe) });
        });
      }
      t.mock.timers.enable({ apis, now: suite.now + index * 3_600_000 });
      const restoreTimers = recordTimers(apis);
      const context: JobCaseContext = {
        t,
        mark: label => record({ mark: label }),
        settle,
        async tick(ms) {
          t.mock.timers.tick(ms);
          await settle();
        },
        async deliver(queue, body, retries) {
          const handler = consumers.get(queue);
          assert.ok(handler, `no consumer on ${queue}`);
          await handler({
            content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
            properties: { headers: retries === undefined ? {} : { 'x-retries': retries } },
          });
        },
        setPublishFails(fails) {
          publishFails = fails;
        },
        setRedis(answer) {
          redisAnswer = answer;
        },
        setFetch(answer) {
          fetchAnswer = answer;
        },
        gate() {
          let release: () => void = () => undefined;
          const opened = new Promise<void>(resolve => {
            release = resolve;
          });
          return {
            wait: async value => {
              await opened;
              return value;
            },
            open: () => release(),
          };
        },
      };
      recordingCase = true;
      let result: unknown;
      try {
        result = describe((await item.run(context)) ?? null);
      } catch (error) {
        result = { thrown: describe(error) };
      } finally {
        await settle();
        recordingCase = false;
        restoreTimers();
      }
      const outcome = JSON.parse(numberUuids(JSON.stringify({ events, result }), fixed)) as unknown;
      const value = createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
      if (fullOut) full[item.name] = outcome;
      if (write) {
        written[item.name] = value;
        return;
      }
      assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
      assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
    });
  }

  test(`${suite.title}: every golden entry still has its case`, () => {
    if (fullOut) writeFileSync(fullOut, `${JSON.stringify(full, null, 1)}\n`);
    if (write) {
      const sorted = Object.fromEntries(
        Object.keys(written)
          .sort()
          .map(name => [name, written[name]]),
      );
      writeFileSync(suite.goldenPath, `${JSON.stringify(sorted, null, 1)}\n`);
      return;
    }
    assert.deepStrictEqual(Object.keys(golden).sort(), suite.cases.map(item => item.name).sort());
  });
}
