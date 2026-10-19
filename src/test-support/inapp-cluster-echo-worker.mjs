// Test only (src/config/inapp-cluster-primary.test.ts): a tiny HTTP worker of
// the in-app cluster primary, in place of the app.
//
// - Every request answers {instance, slot, pid} and closes the connection;
//   GET /crash answers, then the worker exits with code 3.
// - ECHO_LISTEN_DELAY_INSTANCE + ECHO_LISTEN_DELAY_MS: that instance listens
//   (and so signals "ready") late.
// - ECHO_IGNORE_SHUTDOWN_INSTANCE: that instance ignores the "shutdown" message.
import http from 'node:http';

const instance = process.env.NODE_APP_INSTANCE ?? '';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('connection', 'close');
  const body = JSON.stringify({ instance, slot: process.env.LANDA_INAPP_CLUSTER_SLOT ?? '', pid: process.pid });
  if (req.url === '/crash') res.end(body, () => process.exit(3));
  else res.end(body);
});

const listenDelayMs =
  process.env.ECHO_LISTEN_DELAY_INSTANCE === instance ? Number(process.env.ECHO_LISTEN_DELAY_MS || 0) : 0;
setTimeout(() => {
  server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.('ready'));
}, listenDelayMs);

process.on('message', message => {
  if (message !== 'shutdown' || process.env.ECHO_IGNORE_SHUTDOWN_INSTANCE === instance) return;
  server.close(() => process.exit(0));
});
