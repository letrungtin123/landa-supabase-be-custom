// Test only: the harness of the SQL characterization tests of the staff
// modules (users, enrollments, assignments, badges, tenant badges,
// notifications, course categories, welcome init). A case calls one
// controller with a fake request; the harness records every SQL statement
// (text without whitespace differences, parameters, pool or transaction
// client), the module's side requests (Storage) and the answer (status, body,
// headers, or the error passed to next), and compares their SHA-256 digest
// with the golden file, which the code before its repository existed wrote.
// Moving SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or what the case's answer gives). Each test file sets its own
// environment and imports config/database.js before it passes `pool` here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import pg from 'pg';

/** A case's answer to one statement: rows (and rowCount), an error to throw, or undefined for the default row. */
export type Answer = (
  text: string,
  index: number,
  params: unknown[],
) => { rows?: unknown[]; rowCount?: number; error?: { code: string; message: string } } | undefined;

export interface Statement {
  via: string;
  text: string;
  params: unknown[];
}

const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i;

/** Replaces pg's Pool query and connect for one test: every statement is recorded and answered. */
export function installDb(
  t: TestContext,
  pool: pg.Pool,
  defaultRow: Record<string, unknown>,
  answer?: Answer,
): Statement[] {
  const statements: Statement[] = [];
  const handler =
    (via: string) =>
    async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      const params = [...(typeof config === 'string' ? values : (config.values ?? []))];
      statements.push({ via, text, params });
      const custom = answer?.(text, statements.length - 1, params);
      if (custom?.error) throw Object.assign(new Error(custom.error.message), { code: custom.error.code });
      const rows = custom?.rows ?? (CONTROL.test(text) ? [] : [defaultRow]);
      return { rows, rowCount: custom?.rowCount ?? rows.length };
    };
  t.mock.method(pg.Pool.prototype, 'query', async function (this: unknown, config: string, values?: unknown[]) {
    return handler(this === pool ? 'pool' : 'other-pool')(config, values);
  });
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: unknown) {
    return { query: handler(this === pool ? 'client' : 'other-client'), release() {} };
  });
  return statements;
}

/** Answers of common shapes. */
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
  (pattern: RegExp, code: string): Answer =>
  text =>
    pattern.test(text) ? { error: { code, message: `${code} double` } } : undefined;
/** The first answer that answers. */
export const answers =
  (...list: Answer[]): Answer =>
  (text, index, params) => {
    for (const item of list) {
      const result = item(text, index, params);
      if (result) return result;
    }
    return undefined;
  };

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  written: unknown[];
  redirected: unknown;
  status(code: number): FakeResponse;
  sendStatus(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  send(body: unknown): FakeResponse;
  setHeader(name: string, value: unknown): FakeResponse;
  set(name: string, value: unknown): FakeResponse;
  header(name: string, value: unknown): FakeResponse;
  type(value: unknown): FakeResponse;
  attachment(name?: unknown): FakeResponse;
  redirect(...args: unknown[]): void;
  write(chunk: unknown): boolean;
  end(chunk?: unknown): FakeResponse;
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Calls a handler with `req` and a fake response; the answer, or the error passed to next. */
export async function callHandler(handler: Handler, req: Record<string, unknown>): Promise<unknown> {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    written: [],
    redirected: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    sendStatus(code) {
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
      return this.setHeader(name, value);
    },
    header(name, value) {
      return this.setHeader(name, value);
    },
    type(value) {
      return this.setHeader('type()', value);
    },
    attachment(name) {
      return this.setHeader('attachment()', name ?? null);
    },
    redirect(...args) {
      this.redirected = args;
    },
    write(chunk) {
      this.written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      return this;
    },
  };
  let passed: unknown;
  await handler(req as unknown as Request, res as unknown as Response, (error?: unknown) => {
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
  return {
    status: res.statusCode,
    body: res.body,
    headers: res.headers,
    ...(res.written.length > 0 ? { written: res.written } : {}),
    ...(res.redirected !== undefined ? { redirected: res.redirected } : {}),
  };
}

export interface CharacterizationCase {
  name: string;
  run: () => Promise<unknown>;
  answer?: Answer;
}

export interface CharacterizationOptions {
  /** Test name prefix, e.g. "users characterization". */
  label: string;
  goldenPath: string;
  /** Rewrite the golden file instead of comparing (an intended change only). */
  writeGolden: boolean;
  /** When set, every outcome is also written in full to this file. */
  fullOut: string;
  cases: CharacterizationCase[];
  pool: pg.Pool;
  defaultRow: Record<string, unknown>;
  now: number;
  /** UUIDs recorded as they are; any other UUID is recorded as "<random-uuid>". */
  fixedIds: string[];
  /** Side requests (Storage) the module's doubles push; emptied before each case. */
  sideRequests?: string[];
  /** Per-case mocks beyond the database. */
  setup?: (t: TestContext) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Defines one test per case plus the golden bookkeeping tests. */
export function runCharacterization(options: CharacterizationOptions): void {
  const fixedIds = new Set(options.fixedIds);
  const stable = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item !== 'string') return item;
        if (UUID.test(item) && !fixedIds.has(item)) return '<random-uuid>';
        if (BCRYPT.test(item)) return '<bcrypt-hash>';
        return item;
      }),
    );
  const digest = (outcome: unknown): string => createHash('sha256').update(JSON.stringify(outcome)).digest('hex');

  const golden: Record<string, string> = existsSync(options.goldenPath)
    ? (JSON.parse(readFileSync(options.goldenPath, 'utf8')) as Record<string, string>)
    : {};
  const written: Record<string, string> = {};
  const full: Record<string, unknown> = {};

  test(`${options.label}: the case names are unique`, () => {
    assert.equal(new Set(options.cases.map(item => item.name)).size, options.cases.length);
  });

  for (const item of options.cases) {
    test(`${options.label}: ${item.name}`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: options.now });
      t.mock.method(console, 'log', () => undefined);
      t.mock.method(console, 'info', () => undefined);
      t.mock.method(console, 'warn', () => undefined);
      t.mock.method(console, 'error', () => undefined);
      options.setup?.(t);
      if (options.sideRequests) options.sideRequests.length = 0;
      const statements = installDb(t, options.pool, options.defaultRow, item.answer);
      let result: unknown;
      try {
        result = plain(await item.run());
      } catch (error) {
        result = { thrown: (error as Error).name, message: (error as Error).message };
      }
      const outcome = stable({
        statements: statements.map(s => ({
          via: s.via,
          sql: s.text.replace(/\s+/g, ' ').trim(),
          params: plain(s.params),
        })),
        side: options.sideRequests ? [...options.sideRequests] : [],
        result,
      });
      const value = digest(outcome);
      if (options.fullOut) full[item.name] = outcome;
      if (options.writeGolden) {
        written[item.name] = value;
        return;
      }
      assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
      assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
    });
  }

  test(`${options.label}: every golden entry still has its case`, () => {
    if (options.fullOut) writeFileSync(options.fullOut, `${JSON.stringify(full, null, 1)}\n`);
    if (options.writeGolden) {
      const sorted = Object.fromEntries(
        Object.keys(written)
          .sort()
          .map(name => [name, written[name]]),
      );
      writeFileSync(options.goldenPath, `${JSON.stringify(sorted, null, 1)}\n`);
      return;
    }
    assert.deepStrictEqual(Object.keys(golden).sort(), options.cases.map(item => item.name).sort());
  });
}
