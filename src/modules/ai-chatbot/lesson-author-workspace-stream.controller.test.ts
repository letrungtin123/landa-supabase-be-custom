import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceStreamHandler, type WorkspaceStreamDiagnostic } from './lesson-author-workspace-stream.controller.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(1), conversationId = uuid(2), courseId = 'course-v1:TEST+WORKSPACE+2026';
const user: AuthUser = { id: uuid(3), tenantId: uuid(4), role: 'staff', username: 'synthetic', sessionMode: 'normal' };

test('a normal authenticated UUID principal opens the metadata-only SSE stream', async () => {
  let requestClosed: (() => void) | undefined, unsubscribeCalls = 0;
  const diagnostics: WorkspaceStreamDiagnostic[] = [], writes: string[] = [];
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>() {
    return { rows: [{ id: workspaceId, correlation_id: uuid(5), contract_version: 1, content_locale: 'vi', status: 'designing',
      event_head: '0', updated_at: new Date('2026-09-30T00:00:00Z'), node_count: '0', unit_count: '0', ready_unit_count: '0' }] as unknown as T[], rowCount: 1 };
  } };
  const handler = createWorkspaceStreamHandler({ enabled: () => true, db, canRead: async actor => actor.id === user.id,
    subscribe: async (id, _listener) => { assert.equal(id, workspaceId); return () => { unsubscribeCalls++; }; },
    report: entry => { diagnostics.push(entry); },
  });
  const request = { user: { ...user }, params: { workspaceId, conversationId, courseId }, query: { ui_locale: 'vi', after_sequence: '0' },
    on: (event: string, listener: () => void) => { if (event === 'close') requestClosed = listener; return request; },
  } as unknown as Request;
  let ended = false, status = 0;
  const response = { get writableEnded() { return ended; }, setHeader() {}, status(value: number) { status = value; return response; },
    json() { return response; }, flushHeaders() {}, write(value: string) { writes.push(value); return true; }, end() { ended = true; },
  } as unknown as Response;

  await handler(request, response);
  assert.equal(status, 200);
  assert.match(writes.join(''), /event: stream_ready/);
  assert.equal(diagnostics.at(-1)?.event, 'workspace_stream_opened');
  requestClosed?.();
  assert.equal(unsubscribeCalls, 1);
});
