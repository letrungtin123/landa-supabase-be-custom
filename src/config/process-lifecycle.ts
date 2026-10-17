// ═══════════════════════════════════════════════════════════════
// Process lifecycle — what has to stop when the process shuts down
//
// Pollers and sweepers register their interval so no new background work
// starts during the drain; long-lived streams register a callback so they
// end politely (the browser reconnects to the next process); work that must
// settle before the database pool closes (e.g. metering a stopped AI answer)
// is tracked. config/graceful-shutdown.ts drives the sequence.
// ═══════════════════════════════════════════════════════════════

export interface ProcessLifecycle {
  isShuttingDown(): boolean;
  /** A poller/sweeper interval, cleared when shutdown starts. Returns the timer. */
  stopOnShutdown<T extends NodeJS.Timeout>(timer: T): T;
  /** Runs `listener` once when shutdown starts. Returns the unsubscribe. */
  onShutdownStart(listener: () => void): () => void;
  /** Work the shutdown waits for (bounded) before closing shared resources. */
  trackShutdownWork<T>(work: Promise<T>): Promise<T>;
  /** Starts shutdown: clears the registered timers and notifies the listeners. */
  begin(): void;
  /** Waits until the tracked work settled or `timeoutMs` passed; true when none is left. */
  settleWork(timeoutMs: number): Promise<boolean>;
}

export function createProcessLifecycle(): ProcessLifecycle {
  let shuttingDown = false;
  const timers = new Set<NodeJS.Timeout>();
  const listeners = new Set<() => void>();
  const work = new Set<Promise<unknown>>();

  const notify = (listener: () => void) => {
    try { listener(); } catch (error) {
      console.warn('[Shutdown] A shutdown listener failed:', error instanceof Error ? error.message : String(error));
    }
  };

  return {
    isShuttingDown: () => shuttingDown,
    stopOnShutdown(timer) {
      if (shuttingDown) clearInterval(timer);
      else timers.add(timer);
      return timer;
    },
    onShutdownStart(listener) {
      if (shuttingDown) {
        queueMicrotask(() => notify(listener));
        return () => {};
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    trackShutdownWork(promise) {
      work.add(promise);
      promise.then(() => work.delete(promise), () => work.delete(promise));
      return promise;
    },
    begin() {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      const current = [...listeners];
      listeners.clear();
      for (const listener of current) notify(listener);
    },
    async settleWork(timeoutMs) {
      if (work.size === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
      await Promise.race([Promise.allSettled([...work]), timeout]);
      clearTimeout(timer);
      return work.size === 0;
    },
  };
}

/** The API process's lifecycle. */
export const processLifecycle = createProcessLifecycle();
export const isShuttingDown = (): boolean => processLifecycle.isShuttingDown();
export const stopOnShutdown = <T extends NodeJS.Timeout>(timer: T): T => processLifecycle.stopOnShutdown(timer);
export const onShutdownStart = (listener: () => void): (() => void) => processLifecycle.onShutdownStart(listener);
export const trackShutdownWork = <T>(work: Promise<T>): Promise<T> => processLifecycle.trackShutdownWork(work);
