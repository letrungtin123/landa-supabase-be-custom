import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConsumeMessage } from 'amqplib';

// A failed message is not retried in a hot loop: consumers that opt in wait
// (capped, jittered backoff) before each republish; a republish the broker
// does not confirm is requeued after a short wait. DB-backed consumers keep
// the immediate republish. Fake channel and wait; no broker.

const { createMessageHandler, rabbitRetryDelayMs } = await import('./consumer.js');

function message(body: unknown, retries?: number): ConsumeMessage {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: {} as ConsumeMessage['fields'],
    properties: { headers: retries === undefined ? {} : { 'x-retries': retries } } as unknown as ConsumeMessage['properties'],
  };
}

function fakeChannel(options: { confirm?: boolean } = {}) {
  const log: string[] = [];
  const channel = {
    ack: () => { log.push('ack'); },
    nack: (_msg: unknown, _allUpTo?: boolean, requeue?: boolean) => { log.push(`nack:requeue=${requeue}`); },
    sendToQueue: (_queue: string, _content: Buffer, publishOptions: { headers?: Record<string, unknown> }, callback?: (error: Error | null) => void) => {
      log.push(`republish:x-retries=${publishOptions.headers?.['x-retries']}`);
      callback?.(options.confirm === false ? new Error('nack from broker') : null);
      return true;
    },
  };
  return { log, channel };
}

const quiet = () => {
  const original = console.error;
  console.error = () => undefined;
  return () => { console.error = original; };
};

test('a successful message is acknowledged without waiting', async () => {
  const { log, channel } = fakeChannel();
  const handler = createMessageHandler({ channel: channel as never, queue: 'q', callback: async () => { log.push('work'); },
    retryBackoff: true, wait: async (ms) => { log.push(`wait:${ms}`); } });
  await handler(message({ jobId: 'a' }));
  assert.deepEqual(log, ['work', 'ack']);
});

test('with retry backoff a failed message waits longer before each republish, then the old one is acknowledged', async () => {
  const restore = quiet();
  try {
    const { log, channel } = fakeChannel();
    const handler = createMessageHandler({
      channel: channel as never, queue: 'q', callback: async () => { throw new Error('provider down'); },
      retryBackoff: true, wait: async (ms) => { log.push(`wait:${ms}`); }, retryDelayMs: (attempt) => attempt * 1000,
    });
    await handler(message({ jobId: 'a' }));
    await handler(message({ jobId: 'a' }, 1));
    await handler(message({ jobId: 'a' }, 2));
    assert.deepEqual(log, [
      'wait:1000', 'republish:x-retries=1', 'ack',
      'wait:2000', 'republish:x-retries=2', 'ack',
      'wait:3000', 'republish:x-retries=3', 'ack',
    ]);
  } finally { restore(); }
});

test('without retry backoff (DB job rows own the backoff) the republish is immediate, as before', async () => {
  const restore = quiet();
  try {
    const { log, channel } = fakeChannel();
    const handler = createMessageHandler({ channel: channel as never, queue: 'q', callback: async () => { throw new Error('x'); },
      wait: async (ms) => { log.push(`wait:${ms}`); } });
    await handler(message({ jobId: 'a' }));
    assert.deepEqual(log, ['republish:x-retries=1', 'ack']);
  } finally { restore(); }
});

test('after the last retry the failure handler runs and the message is dropped, without waiting', async () => {
  const restore = quiet();
  try {
    const { log, channel } = fakeChannel();
    const handler = createMessageHandler({
      channel: channel as never, queue: 'q', callback: async () => { throw new Error('x'); },
      onFail: async (_queue, raw) => { log.push(`onFail:${raw}`); },
      retryBackoff: true, wait: async (ms) => { log.push(`wait:${ms}`); },
    });
    await handler(message({ jobId: 'a' }, 3));
    assert.deepEqual(log, ['onFail:{"jobId":"a"}', 'ack']);
  } finally { restore(); }
});

test('a republish the broker does not confirm is requeued after a wait, not at once', async () => {
  const restore = quiet();
  try {
    for (const retryBackoff of [true, false]) {
      const { log, channel } = fakeChannel({ confirm: false });
      const handler = createMessageHandler({
        channel: channel as never, queue: 'q', callback: async () => { throw new Error('x'); },
        retryBackoff, wait: async (ms) => { log.push(`wait:${ms}`); }, retryDelayMs: (attempt) => attempt * 500,
      });
      await handler(message({ jobId: 'a' }, 1));
      assert.deepEqual(log, [
        ...(retryBackoff ? ['wait:1000'] : []),
        'republish:x-retries=2', 'wait:500', 'nack:requeue=true',
      ]);
    }
  } finally { restore(); }
});

test('invalid JSON is dropped', async () => {
  const restore = quiet();
  try {
    const { log, channel } = fakeChannel();
    const handler = createMessageHandler({ channel: channel as never, queue: 'q', callback: async () => { log.push('work'); } });
    await handler(message('{not json'));
    assert.deepEqual(log, ['ack']);
  } finally { restore(); }
});

test('the retry delay doubles per attempt, is jittered by ±25 % and capped', () => {
  const middle = () => 0.5;
  assert.deepEqual([1, 2, 3, 4].map((attempt) => rabbitRetryDelayMs(attempt, 2_000, 15_000, middle)), [2_000, 4_000, 8_000, 15_000]);
  assert.equal(rabbitRetryDelayMs(1, 2_000, 15_000, () => 0), 1_500);
  assert.equal(rabbitRetryDelayMs(1, 2_000, 15_000, () => 0.999999), 2_500);
  assert.equal(rabbitRetryDelayMs(3, 2_000, 15_000, () => 0.999999), 10_000);
  assert.equal(rabbitRetryDelayMs(10, 2_000, 15_000, () => 0.999999), 15_000, 'never above the cap');
  assert.equal(rabbitRetryDelayMs(2, 0, 15_000), 0, '0 turns the wait off');
});

// Last: it starts the (process-wide) shutdown of this test process.
test('a pending retry wait ends at once when the process starts shutting down', async () => {
  const restore = quiet();
  try {
    const { processLifecycle } = await import('../process-lifecycle.js');
    const { log, channel } = fakeChannel();
    const handler = createMessageHandler({ channel: channel as never, queue: 'q', callback: async () => { throw new Error('x'); },
      retryBackoff: true, retryDelayMs: () => 60_000 });
    const startedAt = Date.now();
    const handled = handler(message({ jobId: 'a' }));
    setTimeout(() => processLifecycle.begin(), 20);
    await handled;
    assert.ok(Date.now() - startedAt < 5_000, 'did not wait the full minute');
    assert.deepEqual(log, ['republish:x-retries=1', 'ack'], 'the message is still republished before the channel closes');
  } finally { restore(); }
});
