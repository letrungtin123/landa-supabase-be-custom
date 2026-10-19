/**
 * `work` wrapped so that a call made while the previous one still runs
 * returns at once without running it (a poll tick that finds the last drain
 * still busy skips its turn). An error of `work` goes to that call's caller.
 */
export function createSingleFlight(work: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await work();
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Runs `run` for every item, at most `limit` at a time, in item order. The
 * first error rejects the returned promise; items already started still run.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const workers = Math.min(limit, items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await run(item);
      }
    }),
  );
}
