// A durable job that works in bounded slices (batches) and gives its turn
// back after a fixed number of slices per run, so one large job cannot hold a
// worker: claim -> slice ... -> complete, or yield (back to the queue, picked
// up again on its next wake-up). The job's own SQL stays in its module; this
// only fixes the order of the steps.
//
// An error thrown by any step leaves the job as it is and goes to the caller
// (a wake-up consumer marks the job retryable and RabbitMQ retries it).

/** 'more': the slice was full, work may be left. 'done': nothing is left. */
export type SliceOutcome = 'more' | 'done';

export type SlicedJobOutcome = 'not_claimed' | 'completed' | 'yielded';

export interface SlicedJob<TJob> {
  /** Takes the job for this run; null when it is not runnable (taken, finished, missing). */
  claim(): Promise<TJob | null>;
  /** One bounded slice of work. */
  runSlice(job: TJob): Promise<SliceOutcome>;
  /** Nothing is left: mark the job finished (or queued again when a rerun was requested meanwhile). */
  complete(job: TJob): Promise<void>;
  /** The slice budget is used up and work may be left: put the job back in the queue. */
  yieldTurn(job: TJob): Promise<void>;
}

/** Runs one turn of a sliced job: at most `maxSlices` slices (none when `maxSlices` ≤ 0, then it yields). */
export async function runSlicedJob<TJob>(steps: SlicedJob<TJob>, maxSlices: number): Promise<SlicedJobOutcome> {
  const job = await steps.claim();
  if (!job) return 'not_claimed';

  for (let slice = 0; slice < maxSlices; slice += 1) {
    if ((await steps.runSlice(job)) === 'done') {
      await steps.complete(job);
      return 'completed';
    }
  }

  await steps.yieldTurn(job);
  return 'yielded';
}
