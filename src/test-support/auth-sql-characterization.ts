// Test only: harness of the auth, SSO and demo-login characterization goldens.
//
// A case runs handlers or service functions against a pg double and records
// every SQL statement (text without whitespace differences, parameters, pool
// or transaction client), the Redis commands, outbound requests and bcrypt
// calls the test file reports, and the answer (status, body, headers and
// cookies set, or the error passed to next). The outcome is stored as a
// SHA-256 digest per case in a golden file written by the code before a
// refactor; the refactor must keep every digest equal.
//
// Normalized before hashing, so a digest depends on behavior only:
// - access tokens: replaced by their decoded header and payload and whether
//   they verify (the signature depends on the local JWT secret);
// - random UUIDs (refresh tokens, session ids, one-time tokens): numbered in
//   order of appearance, and their SHA-256 hex (the stored refresh token
//   hash) by the same number, so "the hash stored is the hash of the token
//   returned" stays part of the outcome.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';

export const CHARACTERIZATION_NOW = Date.parse('2026-10-18T03:04:05.000Z');

export interface Statement {
  via: string;
  text: string;
  params: unknown[];
}

/** Rows for one statement, or undefined for the file's default answer. */
export type Answer = (text: string, index: number, params: unknown[]) => { rows: unknown[] } | Error | undefined;
export type DefaultAnswer = (text: string) => unknown[];

/** Records every statement; `answer` (per case) then `fallback` (per file) choose the rows. */
export function installDb(t: TestContext, pool: unknown, fallback: DefaultAnswer, answer?: Answer): Statement[] {
  const statements: Statement[] = [];
  const handler =
    (via: string) =>
    async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      statements.push({ via, text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
      const custom = answer?.(text, statements.length - 1, statements[statements.length - 1].params);
      if (custom instanceof Error) throw custom;
      const rows =
        custom?.rows ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(text) ? [] : fallback(text));
      return { rows, rowCount: rows.length };
    };
  t.mock.method(pg.Pool.prototype, 'query', async function (this: unknown, config: string, values?: unknown[]) {
    return handler(this === pool ? 'pool' : 'other-pool')(config, values);
  });
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: unknown) {
    return { query: handler(this === pool ? 'client' : 'other-client'), release() {} };
  });
  return statements;
}

/** Rows of the statements whose text matches, in order: `rowsWhen([/x/, []], [/y/, [ROW]])`. */
export function rowsWhen(...rules: Array<[RegExp, unknown[] | Error]>): Answer {
  return text => {
    for (const [pattern, rows] of rules) {
      if (pattern.test(text)) return rows instanceof Error ? rows : { rows };
    }
    return undefined;
  };
}

export interface CallOptions {
  user?: Record<string, unknown> | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  cookies: unknown[];
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  send(body: unknown): FakeResponse;
  setHeader(name: string, value: unknown): FakeResponse;
  set(name: string, value: unknown): FakeResponse;
  header(name: string, value: unknown): FakeResponse;
  cookie(...args: unknown[]): FakeResponse;
  clearCookie(...args: unknown[]): FakeResponse;
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/** A fake request, for handlers and middleware alike. */
export function fakeRequest(options: CallOptions = {}): Request {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value;
  return {
    user: options.user ?? undefined,
    query: options.query ?? {},
    params: options.params ?? {},
    body: 'body' in options ? options.body : {},
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    ip: options.ip ?? '203.0.113.7',
    socket: { remoteAddress: options.ip ?? '203.0.113.7' },
    originalUrl: '/api/test',
  } as unknown as Request;
}

/** Runs one handler; the answer, or the error passed to next, or whether next() was called. */
export async function call(handler: Handler, options: CallOptions = {}) {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    header(name, value) {
      this.headers[name] = value;
      return this;
    },
    cookie(...args) {
      this.cookies.push(['set', ...args]);
      return this;
    },
    clearCookie(...args) {
      this.cookies.push(['clear', ...args]);
      return this;
    },
  };
  const req = fakeRequest(options);
  let nextCalled = false;
  let passed: unknown;
  await handler(req, res as unknown as Response, (error?: unknown) => {
    nextCalled = true;
    passed = error;
  });
  if (passed !== undefined) return { next: describeError(passed) };
  return {
    status: res.statusCode,
    body: res.body,
    headers: res.headers,
    cookies: res.cookies,
    next_called: nextCalled,
    req_user: (req as { user?: unknown }).user ?? null,
  };
}

export function describeError(error: unknown) {
  const value = error as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
  return {
    name: value?.name ?? null,
    message: value?.message ?? String(error),
    statusCode: value?.statusCode ?? null,
    code: value?.code ?? null,
  };
}

/** Awaits `run`; a rejection is recorded as the result. */
export async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: await run() };
  } catch (error) {
    return { thrown: describeError(error) };
  }
}

interface RouterLayer {
  handle: unknown;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}

/** Method, path and middleware chain of every route of an Express router; functions are named through `names`. */
export function describeRouter(router: unknown, names: ReadonlyMap<unknown, string>) {
  const nameOf = (fn: unknown) => names.get(fn) ?? `<${(fn as { name?: string }).name || 'anonymous'}>`;
  return (router as { stack: RouterLayer[] }).stack.map(layer =>
    layer.route
      ? {
          path: layer.route.path,
          methods: Object.keys(layer.route.methods).sort(),
          chain: layer.route.stack.map(item => nameOf(item.handle)),
        }
      : { use: nameOf(layer.handle) },
  );
}

const JWT_TEXT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The outcome as JSON text with access tokens decoded and random UUIDs numbered. */
export function normalizeOutcome(
  outcome: unknown,
  fixedIds: ReadonlySet<string>,
  verifyJwt: (token: string) => boolean,
  transform?: (text: string) => unknown,
): string {
  const text = JSON.stringify(outcome, (_key, item: unknown) => {
    if (typeof item === 'string' && JWT_TEXT.test(item)) {
      const decoded = jwt.decode(item, { complete: true });
      if (decoded) return { jwt: { header: decoded.header, payload: decoded.payload }, verifies: verifyJwt(item) };
    }
    if (typeof item === 'string' && transform) return transform(item);
    return item === undefined ? null : item;
  });
  const numbered = new Map<string, string>();
  for (const match of text.match(UUID_TEXT) ?? []) {
    const id = match.toLowerCase();
    if (!fixedIds.has(id) && !numbered.has(id)) numbered.set(id, `uuid#${numbered.size + 1}`);
  }
  let out = text;
  for (const [id, label] of numbered) {
    out = out.split(sha256(id)).join(`<sha256 ${label}>`);
    out = out.replace(new RegExp(id, 'gi'), `<${label}>`);
  }
  // The hash of a token that never left the server (e.g. the successor kept
  // for a refresh handoff): numbered too.
  const hashes = new Map<string, string>();
  return out.replace(/\b[0-9a-f]{64}\b/g, hash => {
    if (!hashes.has(hash)) hashes.set(hash, `<sha256 of an unseen value #${hashes.size + 1}>`);
    return hashes.get(hash)!;
  });
}

export interface Case {
  name: string;
  run: (t: TestContext) => Promise<unknown>;
  answer?: Answer;
}

export interface CharacterizationOptions {
  label: string;
  goldenPath: string;
  /** `<PREFIX>_GOLDEN_WRITE=1` rewrites the golden file; `<PREFIX>_FULL_OUT=<file>` writes every outcome. */
  envPrefix: string;
  pool: unknown;
  fallback: DefaultAnswer;
  fixedIds: ReadonlySet<string>;
  verifyJwt: (token: string) => boolean;
  /** Extra records of the case (Redis commands, outbound requests, bcrypt calls), read after it ran. */
  records: () => Record<string, unknown>;
  /** Clears those records before each case. */
  reset: () => void;
  /** Replaces a string of the outcome by a stable value (e.g. a secret encrypted with a random IV). */
  transform?: (text: string) => unknown;
}

/** Registers one test per case plus the golden bookkeeping tests. */
export function runCharacterization(cases: Case[], options: CharacterizationOptions): void {
  const write = process.env[`${options.envPrefix}_GOLDEN_WRITE`] === '1';
  const fullOut = process.env[`${options.envPrefix}_FULL_OUT`]?.trim() || '';
  const golden: Record<string, string> = existsSync(options.goldenPath)
    ? (JSON.parse(readFileSync(options.goldenPath, 'utf8')) as Record<string, string>)
    : {};
  const written: Record<string, string> = {};
  const full: Record<string, unknown> = {};

  test(`${options.label}: the case names are unique`, () => {
    assert.equal(new Set(cases.map(item => item.name)).size, cases.length);
  });

  for (const item of cases) {
    test(`${options.label}: ${item.name}`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: CHARACTERIZATION_NOW });
      t.mock.method(console, 'log', () => undefined);
      t.mock.method(console, 'warn', () => undefined);
      t.mock.method(console, 'error', () => undefined);
      options.reset();
      const statements = installDb(t, options.pool, options.fallback, item.answer);
      let result: unknown;
      try {
        result = await item.run(t);
      } catch (error) {
        result = { thrown: describeError(error) };
      }
      const outcome = {
        statements: statements.map(s => ({ via: s.via, sql: s.text.replace(/\s+/g, ' ').trim(), params: s.params })),
        ...options.records(),
        result,
      };
      const text = normalizeOutcome(outcome, options.fixedIds, options.verifyJwt, options.transform);
      const value = sha256(text);
      if (fullOut) full[item.name] = JSON.parse(text);
      if (write) {
        written[item.name] = value;
        return;
      }
      assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
      assert.equal(value, golden[item.name], `outcome changed:\n${text.slice(0, 4000)}`);
    });
  }

  test(`${options.label}: every golden entry still has its case`, () => {
    if (fullOut) writeFileSync(fullOut, `${JSON.stringify(full, null, 1)}\n`);
    if (write) {
      const sorted = Object.fromEntries(
        Object.keys(written)
          .sort()
          .map(name => [name, written[name]]),
      );
      writeFileSync(options.goldenPath, `${JSON.stringify(sorted, null, 1)}\n`);
      return;
    }
    assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
  });
}
