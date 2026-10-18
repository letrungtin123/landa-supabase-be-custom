// Boot harness for src/config/process-role-matrix.test.ts (test only, never
// loaded by the server). Preloaded with `--import` into a child process that
// then runs src/index.ts with a fake environment:
//
// - dotenv reads no file (the environment is exactly what the test passes);
// - pg clients never open a socket: every query answers no rows, `LISTEN x`
//   is recorded;
// - amqplib.connect returns an in-memory connection that records the queues
//   asserted and consumed;
// - setInterval/setTimeout calls made by src/ code are recorded with the
//   file that made them;
// - every TCP connection attempt is recorded (a real one is refused: the
//   test points every service URL at a closed loopback port).
//
// Also preloaded by src/config/import-side-effects.test.ts in observe mode
// (BOOT_HARNESS_MODE=observe: recording only, real pg and amqplib).
//
// What it saw is written as JSON to BOOT_HARNESS_OUT when the process exits.
// Recording stops when the "shutdown" message arrives, so the steps of the
// graceful shutdown are not counted as startup work.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Timers are attributed to files under src/ (BOOT_HARNESS_SRC_ROOT: another
// tree with the same layout, e.g. dist/ after a build).
const srcRoot = process.env.BOOT_HARNESS_SRC_ROOT
  ? path.resolve(process.env.BOOT_HARNESS_SRC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = process.env.BOOT_HARNESS_OUT;

const seen = {
  intervals: [],
  timeoutFiles: new Set(),
  listenChannels: new Set(),
  assertedQueues: [],
  consumedQueues: [],
  connections: [],
  httpListen: 0,
  queries: 0,
};
let recording = true;

/** The src/ file (posix, relative to src/) of the nearest caller outside this harness, or null. */
function callerFile() {
  const lines = (new Error().stack ?? '').split('\n').slice(2);
  for (const line of lines) {
    // file:///D:/a.ts, file:///home/a.ts, D:\a.ts or /home/a.ts, then :line:column.
    const match = /(file:\/\/\/[A-Za-z]:\/[^:)]+|file:\/\/\/[^:)]+|[A-Za-z]:[\\/][^:)]+|\/[^:)]+):\d+:\d+\)?\s*$/.exec(
      line.trim(),
    );
    if (!match) continue;
    let file = match[1];
    try {
      if (file.startsWith('file://')) file = fileURLToPath(file);
    } catch {
      continue;
    }
    if (file === fileURLToPath(import.meta.url)) continue;
    if (file.includes(`${path.sep}node_modules${path.sep}`) || file.includes('/node_modules/')) return null;
    const relative = path.relative(srcRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
  }
  return null;
}

// ── dotenv: no file ──
require('dotenv').config = () => ({ parsed: {} });

// ── timers ──
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
globalThis.setInterval = function recordedSetInterval(callback, ms, ...args) {
  const file = recording ? callerFile() : null;
  if (file) seen.intervals.push(`${file} every ${ms} ms`);
  return realSetInterval.call(this, callback, ms, ...args);
};
globalThis.setTimeout = function recordedSetTimeout(callback, ms, ...args) {
  const file = recording ? callerFile() : null;
  if (file) seen.timeoutFiles.add(file);
  return realSetTimeout.call(this, callback, ms, ...args);
};

// ── sockets ──
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordedConnect(...args) {
  if (recording) {
    const options = args[0];
    const target =
      typeof options === 'object' && options !== null
        ? `${options.host ?? options.path ?? '?'}:${options.port ?? ''}`
        : String(options);
    seen.connections.push(target);
  }
  return realConnect.apply(this, args);
};
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function recordedListen(...args) {
  if (recording) seen.httpListen += 1;
  return realListen.apply(this, args);
};

// BOOT_HARNESS_MODE=observe: no fakes, only the recording (a real pg or
// amqplib connection attempt then shows up in `connections`).
if (process.env.BOOT_HARNESS_MODE !== 'observe') installFakeServices();

function installFakeServices() {
  // ── pg: no socket; no rows, except that schema checks pass ──
  const pg = require('pg');
  const SCHEMA_CHECK =
    /to_regclass|pg_indexes|information_schema|pg_catalog|pg_class|pg_proc|pg_trigger|pg_constraint/i;
  /** A startup schema check (catalog query) answers one row with every `AS name` column true. */
  function fakeResult(text) {
    if (!SCHEMA_CHECK.test(text)) return { command: 'SELECT', rowCount: 0, rows: [], fields: [] };
    const row = Object.fromEntries([...text.matchAll(/\bAS\s+"?(\w+)"?/gi)].map(match => [match[1], true]));
    return { command: 'SELECT', rowCount: 1, rows: [row], fields: [] };
  }
  pg.Client.prototype.connect = function fakeConnect(callback) {
    this._connected = true;
    this._queryable = true;
    this._ending = false;
    if (callback) {
      process.nextTick(() => callback(null, this));
      return undefined;
    }
    return Promise.resolve();
  };
  pg.Client.prototype.isConnected = function fakeIsConnected() {
    return this._connected === true && !this._ending;
  };
  pg.Client.prototype.query = function fakeQuery(config, values, callback) {
    const text = typeof config === 'string' ? config : (config?.text ?? '');
    const done = typeof values === 'function' ? values : (callback ?? config?.callback);
    if (recording) {
      seen.queries += 1;
      const listen = /^\s*LISTEN\s+("?[\w.-]+"?)/i.exec(text);
      if (listen) seen.listenChannels.add(listen[1].replaceAll('"', ''));
    }
    const result = fakeResult(text);
    if (typeof done === 'function') {
      process.nextTick(() => done(null, result));
      return undefined;
    }
    return Promise.resolve(result);
  };
  pg.Client.prototype.end = function fakeEnd(callback) {
    this._ending = true;
    this._queryable = false;
    process.nextTick(() => this.emit('end'));
    if (callback) {
      process.nextTick(callback);
      return undefined;
    }
    return Promise.resolve();
  };

  // ── amqplib: an in-memory broker ──
  const { EventEmitter } = require('node:events');
  const amqp = require('amqplib');
  let consumerCount = 0;
  function fakeChannel() {
    const channel = new EventEmitter();
    Object.assign(channel, {
      assertQueue: async queue => {
        if (recording) seen.assertedQueues.push(queue);
        return { queue, messageCount: 0, consumerCount: 0 };
      },
      checkQueue: async queue => ({ queue, messageCount: 0, consumerCount: 0 }),
      prefetch: async () => undefined,
      consume: async queue => {
        if (recording) seen.consumedQueues.push(queue);
        consumerCount += 1;
        return { consumerTag: `harness-${consumerCount}` };
      },
      cancel: async () => undefined,
      ack: () => undefined,
      nack: () => undefined,
      reject: () => undefined,
      sendToQueue: (_queue, _content, _options, callback) => {
        if (typeof callback === 'function') process.nextTick(() => callback(null));
        return true;
      },
      publish: (_exchange, _key, _content, _options, callback) => {
        if (typeof callback === 'function') process.nextTick(() => callback(null));
        return true;
      },
      waitForConfirms: async () => undefined,
      close: async () => undefined,
    });
    return channel;
  }
  amqp.connect = async function fakeAmqpConnect() {
    const connection = new EventEmitter();
    Object.assign(connection, {
      createChannel: async () => fakeChannel(),
      createConfirmChannel: async () => fakeChannel(),
      close: async () => undefined,
    });
    return connection;
  };
}

// ── stop recording at shutdown; write what was seen at exit ──
process.on('message', message => {
  if (message === 'shutdown') recording = false;
});
// For an entry point that never signals ready (a worker): end it after this
// long; `forcedExit` then says it was still running.
let forcedExit = false;
const exitAfterMs = Number(process.env.BOOT_HARNESS_EXIT_AFTER_MS || 0);
if (exitAfterMs > 0) {
  realSetTimeout(() => {
    forcedExit = true;
    process.exit(0);
  }, exitAfterMs).unref();
}
process.on('exit', code => {
  if (!outFile) return;
  const sorted = values => [...values].sort();
  writeFileSync(
    outFile,
    JSON.stringify({
      exitCode: code,
      forcedExit,
      intervals: sorted(seen.intervals),
      timeoutFiles: sorted(seen.timeoutFiles),
      listenChannels: sorted(seen.listenChannels),
      assertedQueues: seen.assertedQueues,
      consumedQueues: seen.consumedQueues,
      connections: sorted(new Set(seen.connections)),
      httpListen: seen.httpListen,
      queries: seen.queries,
    }),
  );
});
