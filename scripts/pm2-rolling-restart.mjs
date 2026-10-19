// Zero-downtime deploy of the API when PM2 runs it as the in-app cluster
// primary (ecosystem.config.cjs: exec_mode fork, LANDA_INAPP_CLUSTER_WORKERS;
// src/config/inapp-cluster-primary.ts):
//
//   npm run build
//   node scripts/pm2-rolling-restart.mjs landa-refactor-backend
//
// The script sends the primary a message through PM2 (sendDataToProcessId:
// IPC, so it works on Windows, which has no SIGUSR2). The primary replaces
// its workers one slot after the other: a new worker (it loads dist/ from
// disk) must be ready before the old one of its slot stops. The script
// prints the answers the primary sends back on PM2's bus and exits with
//   0  every worker replaced;
//   1  rejected, failed, no answer, or the app exited during the roll (slots
//      not replaced keep their old worker serving);
//   2  usage error, or PM2 or the app is not in a state to try.
// The primary itself (src/index.ts, src/config/inapp-cluster-*.ts) and its
// env are not reloaded: a change there needs `pm2 restart <app>`.
//
// PM2 is loaded from the global npm root (`npm root -g`), the installation
// the pm2 command uses. LANDA_PM2_MODULE overrides that path (tests).
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The same values as src/config/inapp-cluster.logic.ts (scripts/pm2-rolling-restart.test.mjs checks it). */
export const ROLLING_RESTART_TOPIC = 'landa:rolling-restart';
export const ROLLING_RESTART_REPLY_TOPIC = 'landa:rolling-restart:reply';
/** The primary answers "accepted" or "rejected" at once; no answer by then means it does not know the request. */
export const ACK_TIMEOUT_MS = 10_000;
/** Added to the longest roll the primary announces ("accepted"), for its last answer to arrive. */
export const RESULT_MARGIN_MS = 10_000;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_UNUSABLE = 2;

const USAGE = 'Usage: node scripts/pm2-rolling-restart.mjs <pm2 app name>   (run npm run build first)';

/** { appName } from the command line, or null on a usage error. */
export function parseArgs(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) return null;
  return { appName: argv[0] };
}

/** The pm2 module of the global npm root (or LANDA_PM2_MODULE). */
export function loadPm2(env = process.env) {
  const override = env.LANDA_PM2_MODULE?.trim();
  const modulePath =
    override ||
    path.join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 'pm2');
  return createRequire(import.meta.url)(modulePath);
}

/** A callback-style PM2 call as a promise. */
function call(start) {
  return new Promise((resolve, reject) => start((error, value) => (error ? reject(error) : resolve(value))));
}

/** False when no PM2 daemon answers (pm2.connect would start a new, empty one). */
function daemonAlive(pm2) {
  const client = pm2.Client;
  if (typeof client?.pingDaemon !== 'function') return Promise.resolve(true);
  return new Promise(resolve => client.pingDaemon(alive => resolve(alive === true)));
}

/** { pmId } of the one online fork-mode process of `appName` in `pm2.list()`, or { error }. */
export function findTarget(list, appName) {
  const processes = list.filter(entry => entry.name === appName);
  if (processes.length === 0) return { error: `PM2 runs no app named "${appName}".` };
  if (processes.some(entry => entry.pm2_env?.exec_mode === 'cluster_mode')) {
    return {
      error: `"${appName}" runs in PM2 cluster mode (${processes.length} processes): use \`pm2 reload ${appName}\`. This script is for the in-app cluster primary (exec_mode fork).`,
    };
  }
  if (processes.length > 1) {
    return {
      error: `"${appName}" has ${processes.length} PM2 processes; the rolling restart expects one fork-mode process.`,
    };
  }
  const [target] = processes;
  const status = target.pm2_env?.status;
  if (status !== 'online') {
    return { error: `"${appName}" is ${status ?? 'in an unknown state'}, not online: use \`pm2 restart ${appName}\`.` };
  }
  return { pmId: target.pm_id };
}

/** One line for an answer of the primary (RollingRestartReply in src/config/inapp-cluster.logic.ts). */
export function describeReply(reply) {
  switch (reply.status) {
    case 'accepted':
      return `accepted: ${reply.workers} workers, one after the other (at most ${Math.round(reply.timeout_ms / 1000)} s)`;
    case 'slot_replaced':
      return (
        `slot ${reply.slot} (instance ${reply.instance}): pid ${reply.old_pid} -> ${reply.new_pid}, ` +
        `ready in ${reply.ready_ms} ms, old worker stopped in ${reply.stop_ms} ms` +
        (reply.forced_stop ? ' (killed at the shutdown deadline)' : '')
      );
    case 'succeeded':
      return `done: ${reply.workers} workers replaced in ${(reply.duration_ms / 1000).toFixed(1)} s`;
    case 'rejected':
      return `rejected (${reply.reason}): ${reply.message}`;
    case 'failed':
      return `failed at slot ${reply.slot} (${reply.reason}), ${reply.replaced} slot(s) replaced before: ${reply.message}`;
    default:
      return `unexpected answer: ${JSON.stringify(reply)}`;
  }
}

/**
 * Asks the primary of `appName` for a rolling restart and waits for the
 * result. Resolves with { exitCode, message }; progress lines go to `log`.
 */
export async function rollingRestart({
  pm2,
  appName,
  requestId = randomUUID(),
  ackTimeoutMs = ACK_TIMEOUT_MS,
  resultMarginMs = RESULT_MARGIN_MS,
  log = console.log,
}) {
  if (!(await daemonAlive(pm2))) {
    return { exitCode: EXIT_UNUSABLE, message: 'PM2 is not running (no daemon answered); nothing was restarted.' };
  }
  await call(done => pm2.connect(done));
  try {
    const target = findTarget(await call(done => pm2.list(done)), appName);
    if (target.error) return { exitCode: EXIT_UNUSABLE, message: target.error };
    const bus = await call(done => pm2.launchBus(done));
    return await new Promise(resolve => {
      let finished = false;
      let timer;
      const finish = (exitCode, message) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ exitCode, message });
      };
      const failAfter = (ms, message) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(EXIT_FAILED, message), ms);
      };
      bus.on('process:msg', packet => {
        const reply = packet?.data;
        if (finished || packet?.process?.pm_id !== target.pmId) return;
        if (reply?.topic !== ROLLING_RESTART_REPLY_TOPIC || reply.request_id !== requestId) return;
        const line = describeReply(reply);
        if (reply.status === 'succeeded') return finish(EXIT_OK, line);
        if (reply.status === 'rejected' || reply.status === 'failed') return finish(EXIT_FAILED, line);
        log(`[rolling-restart] ${line}`);
        if (reply.status === 'accepted') {
          const waitMs = reply.timeout_ms + resultMarginMs;
          failAfter(
            waitMs,
            `no result within ${Math.round(waitMs / 1000)} s of "accepted": see the PM2 log of ${appName} (rolling_restart_* events).`,
          );
        }
      });
      bus.on('process:event', packet => {
        if (finished || packet?.process?.pm_id !== target.pmId || packet.event !== 'exit') return;
        finish(
          EXIT_FAILED,
          `${appName} exited during the rolling restart (pm2 restart or stop, or the primary crashed); PM2 handles its restart as usual.`,
        );
      });
      failAfter(
        ackTimeoutMs,
        `${appName} did not answer within ${Math.round(ackTimeoutMs / 1000)} s, so nothing was restarted: it does not run ` +
          `the in-app cluster primary (LANDA_INAPP_CLUSTER_WORKERS=0), or its primary predates the rolling restart. ` +
          `Use \`pm2 restart ${appName}\` (all workers at once).`,
      );
      log(`[rolling-restart] ${appName} (pm2 id ${target.pmId}): request ${requestId}`);
      const packet = {
        id: target.pmId,
        type: 'process:msg',
        topic: ROLLING_RESTART_TOPIC,
        data: { request_id: requestId },
      };
      pm2.sendDataToProcessId(packet, error => {
        if (error) finish(EXIT_UNUSABLE, `PM2 could not deliver the request: ${error.message ?? String(error)}`);
      });
    });
  } finally {
    await call(done => pm2.disconnect(done)).catch(error =>
      log(`[rolling-restart] warning: PM2 disconnect: ${error.message}`),
    );
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return EXIT_UNUSABLE;
  }
  try {
    const result = await rollingRestart({ pm2: loadPm2(), appName: args.appName });
    (result.exitCode === EXIT_OK ? console.log : console.error)(`[rolling-restart] ${result.message}`);
    return result.exitCode;
  } catch (error) {
    console.error(`[rolling-restart] PM2 error, nothing was restarted: ${error?.stack ?? String(error)}`);
    return EXIT_UNUSABLE;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // PM2's client keeps sockets and timers; the result is known, so exit.
  process.exit(await main(process.argv.slice(2)));
}
