// ═══════════════════════════════════════════════════════════════
// Entry point of dist/index.js, every LANDA_PROCESS_ROLE.
//
// It runs process-main.ts (the startup of this process's role), except with
// LANDA_INAPP_CLUSTER_WORKERS=n in an API process started in PM2 fork mode:
// then this process becomes the in-app cluster primary
// (config/inapp-cluster-primary.ts) and forks n workers that run this file
// again and so process-main.ts. Only config is imported before that choice,
// so the primary opens no database, Redis or RabbitMQ connection.
// ═══════════════════════════════════════════════════════════════

import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { planInAppCluster } from './config/inapp-cluster.logic.js';
import { runInAppClusterPrimary } from './config/inapp-cluster-primary.js';
import { signalProcessReady } from './config/process-role.js';

const inAppCluster = planInAppCluster({
  role: env.LANDA_PROCESS_ROLE,
  workers: env.LANDA_INAPP_CLUSTER_WORKERS,
  apiInstances: env.LANDA_API_INSTANCES,
  isPrimary: cluster.isPrimary,
  slot: env.LANDA_INAPP_CLUSTER_SLOT,
});

if (inAppCluster.mode === 'primary') {
  runInAppClusterPrimary({
    workers: inAppCluster.workers,
    exec: fileURLToPath(import.meta.url),
    primaryInstance: env.NODE_APP_INSTANCE,
    signalReady: () => {
      signalProcessReady();
    },
  });
} else {
  if (inAppCluster.mode === 'ignored') {
    console.warn(`[InAppCluster] LANDA_INAPP_CLUSTER_WORKERS is ignored: ${inAppCluster.reason}`);
  }
  await import('./process-main.js');
}
