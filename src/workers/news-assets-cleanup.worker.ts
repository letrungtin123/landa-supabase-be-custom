import { pool } from '../config/database.js';
import { deleteFile } from '../config/storage.js';
import {
  claimNewsAssetCleanupBatch,
  completeClaimedNewsAsset,
  releaseClaimedNewsAsset,
} from '../modules/news/news.service.js';

const POLL_INTERVAL_MS = 60_000;
const FAILURE_RETRY_MS = 15_000;
const BATCH_SIZE = 50;
let stopping = false;
let wake: (() => void) | null = null;
let schemaMissingLogged = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (wake === finish) wake = null;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wake = finish;
  });
}

async function runCycle(): Promise<number> {
  const assets = await claimNewsAssetCleanupBatch(BATCH_SIZE);
  for (const asset of assets) {
    if (stopping) {
      await releaseClaimedNewsAsset(asset.id);
      continue;
    }
    try {
      await deleteFile(asset.storage_path);
      await completeClaimedNewsAsset(asset.id);
    } catch (error) {
      await releaseClaimedNewsAsset(asset.id).catch(() => undefined);
      console.warn(`[NewsAssetCleanup] Deferred ${asset.storage_path}:`, error instanceof Error ? error.message : String(error));
    }
  }
  return assets.length;
}

async function bootstrap(): Promise<void> {
  while (!stopping) {
    try {
      const claimed = await runCycle();
      schemaMissingLogged = false;
      await sleep(claimed > 0 ? 1_000 : POLL_INTERVAL_MS);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === '42P01') {
        if (!schemaMissingLogged) {
          console.warn('[NewsAssetCleanup] Waiting for the approved News manual SQL file.');
          schemaMissingLogged = true;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      console.error('[NewsAssetCleanup] Cycle failed:', error);
      await sleep(FAILURE_RETRY_MS);
    }
  }
}

function requestStop(signal: string): void {
  if (stopping) return;
  stopping = true;
  wake?.();
  console.log(`[NewsAssetCleanup] ${signal}; stopping.`);
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

void bootstrap()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('[NewsAssetCleanup] Fatal error:', error);
    requestStop('fatal');
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
