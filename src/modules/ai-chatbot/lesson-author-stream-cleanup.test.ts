import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceStreamHandler } from './lesson-author-workspace-stream.controller.js';
import { createSourceDocumentStreamHandler } from './lesson-author-source-stream.controller.js';

// S2 T10: the workspace and source SSE handlers release their hub listener on
// every failure path (repository/read failure, hub failure, client gone while
// the stream is still being set up), so repeated failing calls cannot pile up
// listeners, buffers or timers.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user: AuthUser = { id: uuid(3), tenantId: uuid(4), role: 'staff', username: 'synthetic', sessionMode: 'normal' };
const workspaceId = uuid(1), conversationId = uuid(2), courseId = 'course-v1:TEST+STREAM+2026', documentId = uuid(9);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeHttp(params: Record<string, string>, query: Record<string, string>) {
  const state = { status: 0, json: null as unknown, writes: [] as string[], ended: false, headersSent: false, onClose: undefined as (() => void) | undefined };
  const req = { user: { ...user }, params, query, on(event: string, listener: () => void) { if (event === 'close') state.onClose = listener; return req; } } as unknown as Request;
  const res = {
    get writableEnded() { return state.ended; },
    get headersSent() { return state.headersSent; },
    status(value: number) { state.status = value; return res; },
    json(value: unknown) { state.json = value; state.headersSent = true; state.ended = true; return res; },
    setHeader() {}, flushHeaders() { state.headersSent = true; },
    write(value: string) { state.writes.push(value); return true; },
    end() { state.ended = true; },
  } as unknown as Response;
  return { req, res, state };
}

function workspaceHandler(db: GenerationJobSql, hub: { subscribe: (listener: (hint: null) => void) => Promise<() => void> }) {
  return createWorkspaceStreamHandler({ enabled: () => true, db, canRead: async () => true,
    subscribe: (_id, listener) => hub.subscribe(listener as (hint: null) => void), report: () => {} });
}

test('workspace stream: a failing status read releases the listener and answers 404', async () => {
  let active = 0;
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>() { return { rows: [] as T[], rowCount: 0 }; } };
  const handler = workspaceHandler(db, { subscribe: async () => { active++; return () => { active--; }; } });
  for (let i = 0; i < 3; i++) {
    const { req, res, state } = fakeHttp({ workspaceId, conversationId, courseId }, { ui_locale: 'en' });
    await handler(req, res);
    assert.equal(state.status, 404);
    assert.equal((state.json as { code: string }).code, 'WORKSPACE_NOT_FOUND');
  }
  assert.equal(active, 0);
});

test('workspace stream: a client leaving during setup releases the listener and opens nothing', async () => {
  let active = 0;
  const read = deferred<void>();
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>() {
    await read.promise;
    return { rows: [{ id: workspaceId, correlation_id: uuid(5), contract_version: 1, content_locale: 'vi', status: 'designing',
      event_head: '0', updated_at: new Date('2026-10-09T00:00:00Z'), node_count: '0', unit_count: '0', ready_unit_count: '0' }] as unknown as T[], rowCount: 1 };
  } };
  const handler = workspaceHandler(db, { subscribe: async () => { active++; return () => { active--; }; } });
  const { req, res, state } = fakeHttp({ workspaceId, conversationId, courseId }, {});
  const running = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  state.onClose?.();
  read.resolve();
  await running;
  assert.equal(active, 0);
  assert.equal(state.writes.some((value) => value.includes('stream_ready')), false);
});

test('workspace stream: a subscription that resolves after the client left is released at once', async () => {
  let active = 0;
  const subscribed = deferred<() => void>();
  const db: GenerationJobSql = { async query() { throw new Error('must not read'); } };
  const handler = workspaceHandler(db, { subscribe: () => subscribed.promise });
  const { req, res, state } = fakeHttp({ workspaceId, conversationId, courseId }, {});
  const running = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  state.onClose?.();
  active++;
  subscribed.resolve(() => { active--; });
  await running;
  assert.equal(active, 0);
});

test('workspace stream: a hub failure during setup releases the listener once', async () => {
  let unsubscribed = 0;
  const read = deferred<void>();
  let fail: ((hint: null) => void) | undefined;
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>() { await read.promise; return { rows: [] as T[], rowCount: 0 }; } };
  const handler = workspaceHandler(db, { subscribe: async (listener) => { fail = listener; return () => { unsubscribed++; }; } });
  const { req, res } = fakeHttp({ workspaceId, conversationId, courseId }, {});
  const running = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  fail?.(null);
  read.resolve();
  await running;
  assert.equal(unsubscribed, 1);
});

test('source stream: a failing initial read releases the listener and answers 503', async () => {
  let active = 0;
  const handler = createSourceDocumentStreamHandler({
    db: { async query() { throw new Error('database unavailable'); } }, canRead: async () => true,
    subscribe: async () => { active++; return () => { active--; }; }, report: () => {},
  });
  for (let i = 0; i < 3; i++) {
    const { req, res, state } = fakeHttp({ documentId }, {});
    await handler(req, res);
    assert.equal(state.status, 503);
  }
  assert.equal(active, 0);
});

test('source stream: a client leaving during the initial read releases the listener', async () => {
  let active = 0;
  const read = deferred<void>();
  const handler = createSourceDocumentStreamHandler({
    db: { async query<T extends Record<string, unknown>>() {
      await read.promise;
      return { rows: [{ document_id: documentId, kb_id: uuid(8), name: 'Source.pdf', type: 'file', status: 'learning',
        source_info: null, updated_at: '2026-10-09T00:00:00Z' }] as unknown as T[], rowCount: 1 };
    } },
    canRead: async () => true,
    subscribe: async () => { active++; return () => { active--; }; }, report: () => {},
  });
  const { req, res, state } = fakeHttp({ documentId }, {});
  const running = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  state.onClose?.();
  read.resolve();
  await running;
  assert.equal(active, 0);
  assert.equal(state.writes.length, 0);
});
