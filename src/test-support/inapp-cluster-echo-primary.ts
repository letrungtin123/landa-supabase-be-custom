// Test only (src/config/inapp-cluster-primary.test.ts): the real in-app
// cluster primary, run in a child process with tiny HTTP workers
// (inapp-cluster-echo-worker.mjs) instead of the app. Its parent plays PM2:
// it waits for "ready" and sends "shutdown".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInAppClusterPrimary } from '../config/inapp-cluster-primary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const deadline = process.env.ECHO_SHUTDOWN_DEADLINE_MS;

runInAppClusterPrimary({
  workers: Number(process.env.ECHO_WORKERS),
  exec: path.join(here, 'inapp-cluster-echo-worker.mjs'),
  primaryInstance: process.env.NODE_APP_INSTANCE ?? '',
  signalReady: () => {
    process.send?.('ready');
  },
  ...(deadline ? { shutdownDeadlineMs: Number(deadline) } : {}),
});
