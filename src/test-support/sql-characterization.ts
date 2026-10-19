// Test only: the harness of the SQL characterization tests (golden digests).
//
// A characterization test drives route handlers or service functions with a
// pg double instead of a database, and records for every case:
//   - each SQL statement in order: text, parameters, and whether it went to
//     the pool or to which transaction client (client:1, client:2, ...), plus
//     the release of each client;
//   - the requests a fetch double answered (Storage), when the test installs one;
//   - the answer: status, body and headers, the error passed to next, or the
//     error thrown.
// The outcome is reduced to a sha256 digest and compared with the golden file,
// which was written by the code before the change under test. Moving SQL into
// repositories must keep every digest equal.
//
// rawSql: true keeps every statement text byte for byte (whitespace too);
// otherwise runs of whitespace count as one space.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import type { NextFunction, Request, Response } from 'express';

/** Rows for one statement, an error to throw for it, or undefined for the default row. */
export type Answer = (
  text: string,
  index: number,
) => { rows: unknown[] } | { error: Record<string, unknown> } | undefined;

export interface Statement {
  via: string;
  text: string;
  params: unknown[];
}

export function plain(value: unknown): unknown {
  return value === undefined
    ? null
    : JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item)));
}

const NO_ROWS = /^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i;

/** Replaces Pool#query and Pool#connect of every pg pool for the current test. */
export function installDb(t: TestContext, pool: pg.Pool, defaultRow: unknown, answer?: Answer): Statement[] {
  const statements: Statement[] = [];
  let clients = 0;
  const handler =
    (via: string) =>
    async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ via, text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
      const custom = answer?.(text, statements.length - 1);
      if (custom && 'error' in custom) {
        throw Object.assign(new Error(String(custom.error.message ?? 'database error')), custom.error);
      }
      // Copies: code under test may change the rows it reads.
      const rows = structuredClone(custom?.rows ?? (NO_ROWS.test(text) ? [] : [defaultRow]));
      return { rows, rowCount: rows.length };
    };
  t.mock.method(pg.Pool.prototype, 'query', async function (this: unknown, config: string, values?: unknown[]) {
    return handler(this === pool ? 'pool' : 'other-pool')(config, values);
  });
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: unknown) {
    const via = `${this === pool ? 'client' : 'other-client'}:${++clients}`;
    return {
      query: handler(via),
      release() {
        statements.push({ via, text: '<release>', params: [] });
      },
    };
  });
  return statements;
}

export const noRowsAt =
  (...indexes: number[]): Answer =>
  (_text, index) =>
    indexes.includes(index) ? { rows: [] } : undefined;
export const noRowsWhen =
  (pattern: RegExp): Answer =>
  text =>
    pattern.test(text) ? { rows: [] } : undefined;
export const rowsWhen =
  (pattern: RegExp, rows: unknown[]): Answer =>
  text =>
    pattern.test(text) ? { rows } : undefined;
export const failWhen =
  (pattern: RegExp, error: Record<string, unknown>): Answer =>
  text =>
    pattern.test(text) ? { error } : undefined;
/** The first answer of `answers` that is not undefined. */
export const answers =
  (...list: Answer[]): Answer =>
  (text, index) => {
    for (const item of list) {
      const value = item(text, index);
      if (value !== undefined) return value;
    }
    return undefined;
  };

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  ended: boolean;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  send(body: unknown): FakeResponse;
  end(body?: unknown): FakeResponse;
  type(value: string): FakeResponse;
  set(name: string | Record<string, unknown>, value?: unknown): FakeResponse;
  setHeader(name: string, value: unknown): FakeResponse;
  header(name: string, value: unknown): FakeResponse;
  getHeader(name: string): unknown;
  redirect(statusOrUrl: number | string, url?: string): void;
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export interface CallOptions {
  user?: Record<string, unknown> | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
  files?: unknown;
  headers?: Record<string, string>;
  originalUrl?: string;
  method?: string;
  path?: string;
  tenantContext?: Record<string, unknown>;
}

/** Calls one Express handler with a fake request and response. */
export async function callHandler(handler: Handler, options: CallOptions, defaultUser: Record<string, unknown>) {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = Buffer.isBuffer(body) ? `<buffer ${body.length}>` : body;
      return this;
    },
    end(body) {
      this.ended = true;
      if (body !== undefined) this.body = Buffer.isBuffer(body) ? `<buffer ${body.length}>` : body;
      return this;
    },
    type(value) {
      this.headers['content-type'] = value;
      return this;
    },
    set(name, value) {
      if (typeof name === 'string') this.headers[name.toLowerCase()] = value;
      else for (const [key, item] of Object.entries(name)) this.headers[key.toLowerCase()] = item;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    header(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    redirect(statusOrUrl, url) {
      this.statusCode = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      this.headers.location = typeof statusOrUrl === 'number' ? url : statusOrUrl;
    },
  };
  let passed: unknown;
  let nextCalled = false;
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const req = {
    user: options.user === null ? undefined : { ...defaultUser, ...options.user },
    query: options.query ?? {},
    params: { ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    files: options.files,
    originalUrl: options.originalUrl ?? '/api',
    path: options.path ?? '/',
    method: options.method ?? 'GET',
    tenantContext: options.tenantContext,
    get: (name: string) => headers[name.toLowerCase()],
    header: (name: string) => headers[name.toLowerCase()],
    headers,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
  await handler(req, res as unknown as Response, (error?: unknown) => {
    nextCalled = true;
    passed = error;
  });
  if (passed !== undefined) {
    const error = passed as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
    return {
      next: {
        name: error?.name ?? null,
        message: error?.message ?? String(passed),
        statusCode: error?.statusCode ?? null,
        code: error?.code ?? null,
      },
    };
  }
  return { status: res.statusCode, body: res.body, headers: res.headers, ...(nextCalled ? { next: 'called' } : {}) };
}

export interface Case {
  name: string;
  run: () => Promise<unknown>;
  answer?: Answer;
}

export interface Suite {
  /** Shown in each test name. */
  title: string;
  goldenPath: string;
  /** Environment variable that rewrites the golden file when it is "1". */
  writeEnv: string;
  /** Environment variable naming a file that receives every outcome in full. */
  fullOutEnv: string;
  pool: pg.Pool;
  defaultRow: unknown;
  cases: Case[];
  /** UUIDs of the test; any other UUID is recorded as "<random-uuid>". */
  fixedIds: string[];
  now: number;
  rawSql?: boolean;
  /** Requests recorded by the test's fetch double, emptied before each case. */
  storage?: string[];
  /** Extra per-case setup (mocks), after the database double is installed. */
  beforeEach?: (t: TestContext) => void;
  /** Also replace random UUIDs inside longer strings (file names, Storage paths). */
  embeddedUuids?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMBEDDED_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function registerCharacterization(suite: Suite): void {
  const fixed = new Set(suite.fixedIds.map(id => id.toLowerCase()));
  const scrub = (item: string): string =>
    suite.embeddedUuids
      ? item.replace(EMBEDDED_UUID, id => (fixed.has(id.toLowerCase()) ? id : '<random-uuid>'))
      : item;
  const stable = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item !== 'string'
          ? item
          : UUID.test(item) && !fixed.has(item.toLowerCase())
            ? '<random-uuid>'
            : scrub(item),
      ),
    );
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
      // Case n runs n hours after `now`: a process cache with a time limit of
      // an hour or less, filled by an earlier case, has expired in every case.
      t.mock.timers.enable({ apis: ['Date'], now: suite.now + index * 3_600_000 });
      t.mock.method(console, 'log', () => undefined);
      t.mock.method(console, 'warn', () => undefined);
      t.mock.method(console, 'error', () => undefined);
      if (suite.storage) suite.storage.length = 0;
      const statements = installDb(t, suite.pool, suite.defaultRow, item.answer);
      suite.beforeEach?.(t);
      let result: unknown;
      try {
        result = plain(await item.run());
      } catch (error) {
        const failure = error as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
        result = {
          thrown: failure?.name ?? null,
          message: failure?.message ?? String(error),
          statusCode: failure?.statusCode ?? null,
          code: failure?.code ?? null,
        };
      }
      const outcome = stable({
        statements: statements.map(s => ({
          via: s.via,
          sql: suite.rawSql ? s.text : s.text.replace(/\s+/g, ' ').trim(),
          params: plain(s.params),
        })),
        storage: suite.storage ? [...suite.storage] : [],
        result,
      });
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

/** A fetch double that records "<METHOD> <path>" and answers 200 with `body`. */
export function installFetchRecorder(requests: string[], body: unknown = { Key: 'k', path: 'p' }): void {
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const sent = typeof init?.body === 'string' ? ` ${init.body}` : '';
    requests.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}${sent}`);
    return new globalThis.Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
