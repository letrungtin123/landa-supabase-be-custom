// Shared by the two process-wide LISTEN hubs (workspace events, source
// document events): after a broken or refused LISTEN connection, the next
// attempt waits this long so a database outage does not turn every browser
// reconnect into a new pool connection attempt.

export const LISTEN_RETRY_BASE_MS = 1_000;
export const LISTEN_RETRY_MAX_MS = 30_000;

/** Delay after `failures` consecutive failures (>= 1): exponential, capped, half fixed and half random. */
export function listenRetryDelayMs(failures: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(1, failures) - 1, 10);
  const ceiling = Math.min(LISTEN_RETRY_MAX_MS, LISTEN_RETRY_BASE_MS * 2 ** exponent);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
