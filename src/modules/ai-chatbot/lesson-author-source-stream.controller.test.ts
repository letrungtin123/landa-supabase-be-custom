import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createSourceDocumentStreamHandler, type SourceStreamDiagnostic } from './lesson-author-source-stream.controller.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const documentId = uuid(1), tenantId = uuid(2), kbId = uuid(3);
const user: AuthUser = { id: uuid(4), tenantId, role: 'staff', username: 'synthetic', sessionMode: 'normal' };

test('source stream subscribes before exact owner read and returns the authoritative terminal snapshot', async () => {
  const order: string[] = [], writes: string[] = [], diagnostics: SourceStreamDiagnostic[] = [];
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>() {
    order.push('read');
    return { rows: [{ document_id: documentId, kb_id: kbId, name: 'Source.pdf', type: 'file', status: 'learned',
      source_info: { extension: 'pdf' }, updated_at: new Date('2026-09-30T00:00:00Z') }] as unknown as T[], rowCount: 1 };
  } };
  const handler = createSourceDocumentStreamHandler({ db, canRead: async () => true,
    subscribe: async (id, _listener) => { assert.equal(id, documentId); order.push('subscribe'); return () => { order.push('unsubscribe'); }; },
    report: value => diagnostics.push(value),
  });
  const request = { user: { ...user }, params: { documentId }, query: { ui_locale: 'vi' }, on() { return request; } } as unknown as Request;
  let status = 0, ended = false;
  const response = { get writableEnded() { return ended; }, status(value: number) { status = value; return response; }, setHeader() {}, flushHeaders() {},
    write(value: string) { writes.push(value); return true; }, end() { ended = true; }, json() { return response; } } as unknown as Response;
  await handler(request, response);
  assert.deepEqual(order, ['subscribe', 'read', 'unsubscribe']);
  assert.equal(status, 200); assert.equal(ended, true);
  assert.match(writes.join(''), /event: source_status/); assert.match(writes.join(''), /"status":"learned"/);
  assert.equal(diagnostics.at(-1)?.event, 'source_stream_closed');
});

test('source stream rejects cross-permission access before opening a listener', async () => {
  let subscribed = false, status = 0;
  const bodies: Record<string, unknown>[] = [];
  const handler = createSourceDocumentStreamHandler({ db: { async query() { throw new Error('must not read'); } }, canRead: async () => false,
    subscribe: async () => { subscribed = true; return () => undefined; }, report() {},
  });
  const request = { user: { ...user }, params: { documentId }, query: { ui_locale: 'en' } } as unknown as Request;
  const response = { writableEnded: false, status(value: number) { status = value; return response; }, json(value: Record<string, unknown>) { bodies.push(value); return response; } } as unknown as Response;
  await handler(request, response);
  assert.equal(status, 403); assert.equal(subscribed, false);
  assert.equal(bodies[0]?.message, 'The source status stream is unavailable.');
});
