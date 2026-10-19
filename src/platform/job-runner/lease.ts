// Leased jobs: a claim sets `lease_token` and `lease_expires_at = now() +
// lease`; the worker renews the lease while it works (heartbeat) and every
// later write checks the token, so a job whose lease expired is claimed again
// by another worker and the old one can no longer complete it. A failed
// attempt is queued again after a capped exponential backoff.

/** How often a lease of `leaseSeconds` is renewed: a third of it, at least every second. */
export function leaseRenewIntervalMs(leaseSeconds: number): number {
  return Math.max(1_000, Math.floor((leaseSeconds * 1000) / 3));
}

export interface LeaseHeartbeat {
  /** True once a renewal matched no row (the lease was taken over or expired) or failed. */
  readonly lost: boolean;
  stop(): void;
}

/**
 * Renews the lease every leaseRenewIntervalMs(leaseSeconds) until stop().
 * `renew` returns false when the lease is no longer this worker's. The
 * timer does not keep the process alive. Call stop() in a finally block.
 */
export function startLeaseHeartbeat(options: { leaseSeconds: number; renew(): Promise<boolean> }): LeaseHeartbeat {
  let lost = false;
  const timer = setInterval(() => {
    options
      .renew()
      .then(renewed => {
        if (!renewed) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, leaseRenewIntervalMs(options.leaseSeconds));
  timer.unref();
  return {
    get lost() {
      return lost;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Seconds before the next try after attempt `attempt` (1-based) failed:
 * `baseSeconds` doubling per attempt (the exponent stops at `maxExponent`),
 * capped at `maxSeconds`. No jitter.
 */
export function cappedExponentialBackoffSeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
  maxExponent = 10,
): number {
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.min(Math.max(attempt - 1, 0), maxExponent));
}
