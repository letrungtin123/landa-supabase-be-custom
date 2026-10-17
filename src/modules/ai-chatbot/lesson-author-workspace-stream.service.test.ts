import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createWorkspaceCommitHub } from './lesson-author-workspace-stream.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';

class FakeListenClient extends EventEmitter {
  queries: string[] = [];
  released = false;
  async query(sql: string) { this.queries.push(sql); return { rows: [], rowCount: 0 }; }
  release() { this.released = true; }
}

test('one process-wide LISTEN hub fans out only safe workspace/sequence metadata', async () => {
  const client = new FakeListenClient();
  const hub = createWorkspaceCommitHub({ getClient: async () => client as never });
  const observed: Array<{ workspaceId: string; sequence: number } | null> = [];
  const unsubscribe = await hub.subscribe(workspaceId, hint => observed.push(hint));
  assert.deepEqual(client.queries, ['LISTEN lesson_author_workspace_event']);

  client.emit('notification', { channel: 'lesson_author_workspace_event', payload: JSON.stringify({ workspace_id: workspaceId, sequence: 7 }) });
  client.emit('notification', { channel: 'lesson_author_workspace_event', payload: JSON.stringify({ workspace_id: workspaceId, sequence: 'unsafe' }) });
  client.emit('notification', { channel: 'other_channel', payload: JSON.stringify({ workspace_id: workspaceId, sequence: 8 }) });
  assert.deepEqual(observed, [{ workspaceId, sequence: 7 }]);

  unsubscribe(); await hub.stop();
  assert.equal(client.released, true);
  assert.ok(client.queries.includes('UNLISTEN lesson_author_workspace_event'));
});

test('listener failure is a transport signal, never a guessed generation result', async () => {
  const client = new FakeListenClient();
  const hub = createWorkspaceCommitHub({ getClient: async () => client as never });
  const observed: Array<{ workspaceId: string; sequence: number } | null> = [];
  await hub.subscribe(workspaceId, hint => observed.push(hint));
  client.emit('error', new Error('synthetic database connection failure'));
  assert.deepEqual(observed, [null]);
  await hub.stop();
});

class RecordingListenClient extends EventEmitter {
  queries: string[] = [];
  releases: Array<Error | undefined> = [];
  failListen = false;
  async query(sql: string) {
    this.queries.push(sql);
    if (this.failListen && sql.startsWith('LISTEN')) throw new Error('synthetic LISTEN failure');
    return { rows: [], rowCount: 0 };
  }
  release(error?: Error) { this.releases.push(error); }
}

test('a broken LISTEN connection goes back to the pool with its error and is replaced after a backoff', async () => {
  let now = 1_000;
  const clients: RecordingListenClient[] = [];
  const hub = createWorkspaceCommitHub({
    getClient: async () => { const next = new RecordingListenClient(); clients.push(next); return next as never; },
    now: () => now,
  });
  const observed: unknown[] = [];
  await hub.subscribe(workspaceId, hint => observed.push(hint));
  const failure = new Error('synthetic connection reset');
  clients[0].emit('error', failure);
  assert.deepEqual(observed, [null]);
  assert.deepEqual(clients[0].releases, [failure], 'released once, with the error, so the pool discards it');

  // A reconnect right away is refused (the stream answers 503, the browser retries).
  await assert.rejects(hub.subscribe(workspaceId, () => {}), /WORKSPACE_STREAM_LISTEN_RETRY_PENDING/);
  assert.equal(clients.length, 1);
  now += 1_001;
  await hub.subscribe(workspaceId, () => {});
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].queries, ['LISTEN lesson_author_workspace_event']);
  await hub.stop();
  assert.deepEqual(clients[1].releases, [undefined]);
});

test('a refused LISTEN releases its connection with the error', async () => {
  const client = new RecordingListenClient();
  client.failListen = true;
  const hub = createWorkspaceCommitHub({ getClient: async () => client as never, now: () => 0 });
  await assert.rejects(hub.subscribe(workspaceId, () => {}), /synthetic LISTEN failure/);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
});
