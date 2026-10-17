import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

// M3/H12: pool guardrails. No connection is opened here.
const { env } = await import('./env.js');
const { pool, attachClientErrorLogger } = await import('./database.js');

test('every pool connection ends idle transactions and keeps the configured size; lock_timeout is opt-in', () => {
  const options = pool.options as unknown as Record<string, unknown>;
  assert.equal(options.max, env.DB_POOL_MAX);
  assert.equal(options.statement_timeout, 30_000);
  if (env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > 0) {
    assert.equal(options.idle_in_transaction_session_timeout, env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  } else {
    assert.equal(options.idle_in_transaction_session_timeout, undefined);
  }
  if (env.DB_LOCK_TIMEOUT_MS === 0) assert.equal(options.lock_timeout, undefined);
  else assert.equal(options.lock_timeout, env.DB_LOCK_TIMEOUT_MS);
});

test('a session ended by the server while a client is checked out is logged, never an unhandled error', (t) => {
  t.mock.method(console, 'error', () => {});
  const client = new EventEmitter();
  // The pool installs the logger on every new connection.
  pool.emit('connect', client);
  assert.equal(client.listenerCount('error'), 1);
  assert.doesNotThrow(() => client.emit('error', new Error('terminating connection due to idle-in-transaction timeout')));

  const other = new EventEmitter();
  attachClientErrorLogger(other);
  assert.doesNotThrow(() => other.emit('error', new Error('server closed the connection unexpectedly')));
});
