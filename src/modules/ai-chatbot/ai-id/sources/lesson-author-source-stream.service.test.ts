import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSourceDocumentHub } from './lesson-author-source-stream.service.js';

const documentId = '00000000-0000-4000-8000-000000000001';
const tenantId = '00000000-0000-4000-8000-000000000002';
const kbId = '00000000-0000-4000-8000-000000000003';

class FakeListenClient extends EventEmitter {
  queries: string[] = [];
  released = false;
  async query(sql: string) { this.queries.push(sql); return { rows: [], rowCount: 0 }; }
  release() { this.released = true; }
}

test('one process LISTEN connection fans out exact safe document transitions', async () => {
  const client = new FakeListenClient();
  const hub = createSourceDocumentHub({ getClient: async () => client as never });
  const observed: unknown[] = [];
  const unsubscribe = await hub.subscribe(documentId, value => observed.push(value));
  assert.deepEqual(client.queries, ['LISTEN lesson_author_source_document_event']);
  client.emit('notification', { channel: 'lesson_author_source_document_event', payload: JSON.stringify({
    document_id: documentId, tenant_id: tenantId, kb_id: kbId, status: 'learned', updated_at: '2026-09-30T00:00:00.000Z',
  }) });
  client.emit('notification', { channel: 'lesson_author_source_document_event', payload: JSON.stringify({
    document_id: documentId, tenant_id: tenantId, kb_id: kbId, status: 'unsafe', updated_at: '2026-09-30T00:00:00.000Z',
  }) });
  assert.deepEqual(observed, [{ documentId, tenantId, kbId, status: 'learned', updatedAt: '2026-09-30T00:00:00.000Z' }]);
  unsubscribe(); await hub.stop();
  assert.equal(client.released, true);
});

test('LISTEN failure is a transport signal, never a guessed document result', async () => {
  const client = new FakeListenClient();
  const hub = createSourceDocumentHub({ getClient: async () => client as never });
  const observed: unknown[] = [];
  await hub.subscribe(documentId, value => observed.push(value));
  client.emit('error', new Error('synthetic'));
  assert.deepEqual(observed, [null]);
  await hub.stop();
});

class RecordingListenClient extends EventEmitter {
  queries: string[] = [];
  releases: Array<Error | undefined> = [];
  async query(sql: string) { this.queries.push(sql); return { rows: [], rowCount: 0 }; }
  release(error?: Error) { this.releases.push(error); }
}

test('a broken LISTEN connection is discarded and a new one is taken after the backoff', async () => {
  let now = 5_000;
  const clients: RecordingListenClient[] = [];
  const hub = createSourceDocumentHub({
    getClient: async () => { const next = new RecordingListenClient(); clients.push(next); return next as never; },
    now: () => now,
  });
  const observed: unknown[] = [];
  await hub.subscribe(documentId, value => observed.push(value));
  const failure = new Error('synthetic connection reset');
  clients[0].emit('error', failure);
  assert.deepEqual(observed, [null]);
  assert.deepEqual(clients[0].releases, [failure]);
  await assert.rejects(hub.subscribe(documentId, () => {}), /SOURCE_STREAM_LISTEN_RETRY_PENDING/);
  now += 1_001;
  await hub.subscribe(documentId, () => {});
  assert.equal(clients.length, 2);
  await hub.stop();
});
