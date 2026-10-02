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
