import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatStreamLifecycle, CHAT_HEARTBEAT_MS } from './chat-stream-lifecycle.logic.js';

function fixture() {
  const wire: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let tick = () => {};
  let stops = 0;
  let now = 0;
  const res = {
    writableEnded: false, destroyed: false, writableNeedDrain: false,
    write: (data: string) => { wire.push(data); return true; },
    end: () => { res.writableEnded = true; return res; },
  };
  const stream = createChatStreamLifecycle(res as never,
    { correlation_id: 'request-1', conversation_id: 'conversation-1' },
    record => logs.push(record), () => now,
    callback => { tick = callback; return () => { stops++; }; });
  return { res, wire, logs, stream, tick: () => { now += CHAT_HEARTBEAT_MS; tick(); }, stops: () => stops };
}

test('slow valid stream stays open through 300s; heartbeat is comment, not progress', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.tick();
  assert.equal(f.wire.length, 20);
  assert.ok(f.wire.every(line => line === ': keepalive\n\n'));
  assert.equal(f.res.writableEnded, false);
  f.stream.writeEvent({ type: 'done' });
  f.stream.finish();
  f.tick();
  assert.equal(f.wire.length, 21);
  assert.equal(f.stops(), 1);
});

test('disconnect cleans timer once, blocks writes and logs safe correlation metadata', () => {
  const f = fixture();
  f.stream.writeEvent({ type: 'chunk', text: 'PRIVATE CONTENT' });
  f.tick();
  f.stream.disconnect();
  f.stream.disconnect();
  f.stream.dispose();
  f.tick();
  assert.equal(f.stops(), 1);
  assert.equal(f.stream.writeEvent({ type: 'done' }), false);
  assert.equal(f.logs.filter(row => row.event === 'client_disconnected').length, 1);
  assert.ok(f.logs.every(row => row.correlation_id === 'request-1'));
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE CONTENT'));
});

test('backpressure skips heartbeat and write failure stops timer', () => {
  const f = fixture();
  f.res.writableNeedDrain = true;
  f.tick();
  assert.equal(f.wire.length, 0);
  f.res.writableNeedDrain = false;
  f.res.write = () => { throw new Error('socket closed'); };
  f.tick();
  assert.equal(f.stops(), 1);
});
