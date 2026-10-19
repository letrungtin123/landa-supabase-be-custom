// Test only (src/config/inapp-cluster-primary.test.ts): a tiny HTTP worker of
// the in-app cluster primary, in place of the app.
//
// - Every request answers {instance, slot, pid, build} and closes the
//   connection; GET /crash answers, then the worker exits with code 3.
// - ECHO_LISTEN_DELAY_INSTANCE + ECHO_LISTEN_DELAY_MS: that instance listens
//   (and so signals "ready") late.
// - ECHO_IGNORE_SHUTDOWN_INSTANCE: that instance ignores the "shutdown" message
//   and stays alive (as the app does with its pools open) until it is killed.
// - ECHO_BUILD_FILE: read once at start, like a new process reads dist/ from
//   disk. Its text is the `build` of every answer; "crash" exits with code 4
//   before listening, "hang" never listens (never "ready").
// - ECHO_RESPONSE_DELAY_MS: every answer waits that long (requests in flight
//   while a worker drains).
import { readFileSync } from 'node:fs';
import http from 'node:http';

const instance = process.env.NODE_APP_INSTANCE ?? '';
const build = process.env.ECHO_BUILD_FILE ? readFileSync(process.env.ECHO_BUILD_FILE, 'utf8').trim() : '';
if (build === 'crash') process.exit(4);
const responseDelayMs = Number(process.env.ECHO_RESPONSE_DELAY_MS || 0);

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('connection', 'close');
  const body = JSON.stringify({ instance, slot: process.env.LANDA_INAPP_CLUSTER_SLOT ?? '', pid: process.pid, build });
  setTimeout(() => {
    if (req.url === '/crash') res.end(body, () => process.exit(3));
    else res.end(body);
  }, responseDelayMs);
});

const listenDelayMs =
  process.env.ECHO_LISTEN_DELAY_INSTANCE === instance ? Number(process.env.ECHO_LISTEN_DELAY_MS || 0) : 0;
if (build !== 'hang') {
  setTimeout(() => {
    server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.('ready'));
  }, listenDelayMs);
}

// The primary also disconnects a worker it tells to stop (Node closes its
// server and IPC channel); without this timer nothing else would keep the
// ignoring instance alive.
if (process.env.ECHO_IGNORE_SHUTDOWN_INSTANCE === instance) setInterval(() => undefined, 60_000);

process.on('message', message => {
  if (message !== 'shutdown' || process.env.ECHO_IGNORE_SHUTDOWN_INSTANCE === instance) return;
  if (!server.listening) process.exit(0);
  server.close(() => process.exit(0));
});
