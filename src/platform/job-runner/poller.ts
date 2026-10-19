import { stopOnShutdown } from '../../config/process-lifecycle.js';

export interface JobPollerOptions {
  /** ≤ 0: no poller. */
  intervalMs: number;
  tick(): Promise<void>;
  /** A tick that failed; the next tick runs as planned. */
  onError(error: unknown): void;
}

/**
 * Runs `tick` every `intervalMs` (the first time after one interval, not at
 * once). The timer does not keep the process alive and stops when shutdown
 * starts. Ticks are not serialized: wrap `tick` in createSingleFlight when a
 * slow tick must not overlap the next one.
 */
export function startJobPoller(options: JobPollerOptions): void {
  if (options.intervalMs <= 0) return;
  stopOnShutdown(
    setInterval(() => {
      options.tick().catch(options.onError);
    }, options.intervalMs).unref(),
  );
}
