import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abortableSleep,
  chatAnswerSignal,
  chatRetryDelayMs,
  createChatProviderMeter,
  mayRetryChatAttempt,
  stoppedByDeadline,
} from './chat-provider-turn.logic.js';
import { createConcurrencyGate } from '../ai-platform/ai-chat-admission.logic.js';

// H10: a chat answer that the provider started is always paid for; only a
// call the provider refused, or an answer stopped before any call, is free.

const meter = () => createChatProviderMeter({ inputTokens: () => 1_000, estimateTokens: (text) => Math.ceil(text.length / 3) });
const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, embeddingTokens: 0, totalTokens: inputTokens + outputTokens });

test('an answer stopped by the client after text streamed is billed: its usage report, else prompt + streamed text', () => {
  const reported = meter();
  const call = reported.start();
  call.addOutput('partial answer');
  call.setUsage(usage(1_200, 40));
  call.fail(true);
  assert.equal(reported.anyStopped(), true);
  assert.deepEqual(reported.billedUsage(), usage(1_200, 40));

  const estimated = meter();
  const silent = estimated.start();
  silent.addOutput('x'.repeat(30));
  silent.fail(true);
  assert.deepEqual(estimated.billedUsage(), usage(1_000, 10));
});

test('a call stopped after it was sent but before any text is still billed for its prompt', () => {
  const m = meter();
  m.start().fail(true);
  assert.deepEqual(m.billedUsage(), usage(1_000, 0));
});

test('a call the provider refused (error before any text or usage) is free; nothing started means release', () => {
  const m = meter();
  m.start().fail(false);
  assert.equal(m.billedUsage(), null);
  assert.equal(meter().billedUsage(), null, 'stopped before the first call: the reservation is released');
});

test('every call of a turn is summed: the router call plus a stopped answer stream', () => {
  const m = meter();
  const router = m.start();
  router.setUsage(usage(900, 20));
  const stream = m.start();
  stream.addOutput('abc');
  stream.fail(true);
  const refused = m.start();
  refused.fail(false);
  assert.deepEqual(m.billedUsage(), usage(1_900, 21));
});

test('a finished call without a usage report is billed by estimate; a later report replaces nothing with null', () => {
  const m = meter();
  const call = m.start();
  call.addOutput('y'.repeat(9));
  call.setUsage(null);
  assert.deepEqual(m.billedUsage(), usage(1_000, 3));
  assert.equal(m.anyStopped(), false);
});

test('retries: only provider overload, never after the answer stopped or text reached the client', () => {
  const base = { attempt: 0, maxRetries: 3, stopped: false, textSentToClient: false };
  assert.equal(mayRetryChatAttempt({ ...base, status: 503 }), true);
  assert.equal(mayRetryChatAttempt({ ...base, status: 429 }), true);
  assert.equal(mayRetryChatAttempt({ ...base, status: 400 }), false);
  assert.equal(mayRetryChatAttempt({ ...base, status: 503, textSentToClient: true }), false, 'chunks are never sent twice');
  assert.equal(mayRetryChatAttempt({ ...base, status: 503, stopped: true }), false);
  assert.equal(mayRetryChatAttempt({ ...base, status: 503, attempt: 3 }), false);
});

test('retry waits are jittered and respect the provider hint', () => {
  assert.equal(chatRetryDelayMs(1, null, 5_000, () => 0), 2_500);
  assert.equal(chatRetryDelayMs(2, null, 5_000, () => 0.999_999), 10_000);
  const hinted = [0, 0.5, 0.999].map((r) => chatRetryDelayMs(1, 8_000, 5_000, () => r));
  assert.ok(hinted.every((delay) => delay >= 8_000 && delay <= 9_600));
  assert.notEqual(chatRetryDelayMs(1, null, 5_000, () => 0.1), chatRetryDelayMs(1, null, 5_000, () => 0.9));
});

test('the answer signal stops on client disconnect or deadline, and the retry wait stops with it', async () => {
  const client = new AbortController();
  const signal = chatAnswerSignal(client.signal, 60_000);
  const waiting = abortableSleep(30_000, signal);
  client.abort(new Error('chat_client_disconnected'));
  await assert.rejects(waiting, /chat_client_disconnected/);
  assert.equal(stoppedByDeadline(signal), false);

  const deadline = chatAnswerSignal(undefined, 20);
  await assert.rejects(abortableSleep(5_000, deadline));
  assert.equal(stoppedByDeadline(deadline), true);
  await abortableSleep(1, chatAnswerSignal(undefined, 60_000));
});

test('admission: per-tenant and total limits refuse at once, releases are idempotent', () => {
  const gate = createConcurrencyGate({ perKey: 2, total: 3 });
  const a1 = gate.tryAcquire('tenant-a');
  const a2 = gate.tryAcquire('tenant-a');
  assert.ok(a1 && a2);
  assert.equal(gate.tryAcquire('tenant-a'), null, 'per-tenant limit');
  const b1 = gate.tryAcquire('tenant-b');
  assert.ok(b1);
  assert.equal(gate.tryAcquire('tenant-c'), null, 'total limit');
  a1!();
  a1!();
  assert.equal(gate.active('tenant-a'), 1);
  assert.equal(gate.active(), 2);
  assert.ok(gate.tryAcquire('tenant-c'));
});
