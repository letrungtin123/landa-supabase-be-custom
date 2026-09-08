// Post-deploy liveness gate for the dedicated tenant quota worker.
//
// This is deliberately read-only. It proves that the process reloaded by PM2
// has emitted a new database heartbeat before a release is declared healthy.

import { pool, query } from '../config/database.js';

const WORKER_NAME = 'landa-tenant-data-quota-worker';
const POLL_INTERVAL_MS = 2_000;
// Must cover PM2's 660-second graceful kill timeout plus the next worker boot.
const DEFAULT_TIMEOUT_SECONDS = 720;
const MIN_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 900;

type HeartbeatRow = {
  instance_id: string;
  state: string;
  last_heartbeat_at: Date;
};

function parseTimeoutSeconds(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--timeout-seconds='))?.slice('--timeout-seconds='.length);
  if (!raw) return DEFAULT_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(raw)) throw new Error('--timeout-seconds phải là số nguyên.');
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`--timeout-seconds phải nằm trong khoảng ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS}.`);
  }
  return seconds;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds();
  // Use the database clock rather than the deploy host clock so a small clock
  // skew cannot make a valid new heartbeat appear stale.
  const startedResult = await query<{ started_at: Date }>('SELECT clock_timestamp() AS started_at');
  const startedAt = startedResult.rows[0]?.started_at;
  if (!startedAt) throw new Error('Không lấy được thời điểm bắt đầu từ database.');

  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() <= deadline) {
    const result = await query<HeartbeatRow>(
      `SELECT instance_id, state, last_heartbeat_at
       FROM public.tenant_data_quota_worker_heartbeats
       WHERE worker_name = $1
         AND state IN ('starting', 'idle', 'reconciling')
         AND last_heartbeat_at >= $2::timestamptz
       ORDER BY last_heartbeat_at DESC
       LIMIT 1`,
      [WORKER_NAME, startedAt],
    );
    const heartbeat = result.rows[0];
    if (heartbeat) {
      console.log(`[tenant-data-quota] Worker heartbeat mới đã nhận. instance=${heartbeat.instance_id}, state=${heartbeat.state}.`);
      return;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`Worker quota chưa gửi heartbeat mới trong ${timeoutSeconds} giây sau deploy. Không được coi release là thành công.`);
}

main()
  .catch((error) => {
    console.error('[tenant-data-quota] Chờ worker heartbeat thất bại:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
