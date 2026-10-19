import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cappedExponentialBackoffSeconds,
  createSingleFlight,
  leaseRenewIntervalMs,
  readJobId,
  runSlicedJob,
  runWithConcurrency,
  startJobPoller,
  startLeaseHeartbeat,
  type SliceOutcome,
} from './index.js';

// The job runner helpers on their own: no database, no broker. The RabbitMQ
// side of consumeJobWakeUps is pinned through its first user, the course
// progress recalculation worker (progress-recalculation-job.characterization.test.ts).

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function slicedJob(slices: SliceOutcome[], claimed: { id: string } | null = { id: 'job-1' }) {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    steps: {
      claim: async () => {
        calls.push('claim');
        return claimed;
      },
      runSlice: async (job: { id: string }) => {
        const outcome = slices[index] ?? 'more';
        index += 1;
        calls.push(`slice ${index} ${job.id} ${outcome}`);
        return outcome;
      },
      complete: async (job: { id: string }) => {
        calls.push(`complete ${job.id}`);
      },
      yieldTurn: async (job: { id: string }) => {
        calls.push(`yield ${job.id}`);
      },
    },
  };
}

test('runSlicedJob: a job that is not claimed runs no step', async () => {
  const { calls, steps } = slicedJob([], null);
  assert.equal(await runSlicedJob(steps, 3), 'not_claimed');
  assert.deepEqual(calls, ['claim']);
});

test('runSlicedJob: completes on the first slice that is done', async () => {
  const { calls, steps } = slicedJob(['more', 'done']);
  assert.equal(await runSlicedJob(steps, 3), 'completed');
  assert.deepEqual(calls, ['claim', 'slice 1 job-1 more', 'slice 2 job-1 done', 'complete job-1']);
});

test('runSlicedJob: a done last slice of the budget completes instead of yielding', async () => {
  const { calls, steps } = slicedJob(['more', 'more', 'done']);
  assert.equal(await runSlicedJob(steps, 3), 'completed');
  assert.deepEqual(calls.slice(-2), ['slice 3 job-1 done', 'complete job-1']);
});

test('runSlicedJob: yields after the slice budget', async () => {
  const { calls, steps } = slicedJob(['more', 'more', 'more', 'done']);
  assert.equal(await runSlicedJob(steps, 3), 'yielded');
  assert.deepEqual(calls, ['claim', 'slice 1 job-1 more', 'slice 2 job-1 more', 'slice 3 job-1 more', 'yield job-1']);
});

test('runSlicedJob: no slice budget yields at once', async () => {
  const { calls, steps } = slicedJob(['done']);
  assert.equal(await runSlicedJob(steps, 0), 'yielded');
  assert.deepEqual(calls, ['claim', 'yield job-1']);
});

test('runSlicedJob: a failing slice goes to the caller; the job is neither completed nor yielded', async () => {
  const { calls, steps } = slicedJob([]);
  steps.runSlice = async () => {
    calls.push('slice fails');
    throw new Error('statement timeout');
  };
  await assert.rejects(runSlicedJob(steps, 3), /statement timeout/);
  assert.deepEqual(calls, ['claim', 'slice fails']);
});

test('readJobId: a trimmed non-blank string, else null', () => {
  assert.equal(readJobId({ jobId: '  job-1 ' }), 'job-1');
  assert.equal(readJobId({ jobId: '   ' }), null);
  assert.equal(readJobId({ jobId: 42 }), null);
  assert.equal(readJobId({ other: 'job-1' }), null);
});

test('startJobPoller: ticks every interval, not at once; a failed tick is reported and the next runs', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const seen: string[] = [];
  let fail = true;
  startJobPoller({
    intervalMs: 1_000,
    tick: async () => {
      seen.push('tick');
      if (fail) throw new Error('pool exhausted');
    },
    onError: error => seen.push(`error ${(error as Error).message}`),
  });
  await settle();
  t.mock.timers.tick(999);
  await settle();
  assert.deepEqual(seen, []);
  t.mock.timers.tick(1);
  await settle();
  fail = false;
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(seen, ['tick', 'error pool exhausted', 'tick']);
});

test('startJobPoller: no timer when the interval is 0 or less', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ticks = 0;
  for (const intervalMs of [0, -1]) {
    startJobPoller({ intervalMs, tick: async () => void (ticks += 1), onError: () => undefined });
  }
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(ticks, 0);
});

test('leaseRenewIntervalMs: a third of the lease, at least one second', () => {
  assert.equal(leaseRenewIntervalMs(60), 20_000);
  assert.equal(leaseRenewIntervalMs(10), 3_333);
  assert.equal(leaseRenewIntervalMs(2), 1_000);
  assert.equal(leaseRenewIntervalMs(0), 1_000);
});

test('startLeaseHeartbeat: renews every interval until stopped; a refused or failed renewal marks the lease lost', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const answers: Array<boolean | Error> = [true, false];
  let renewals = 0;
  const heartbeat = startLeaseHeartbeat({
    leaseSeconds: 30,
    renew: async () => {
      renewals += 1;
      const answer = answers.shift() ?? true;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  t.mock.timers.tick(9_999);
  await settle();
  assert.equal(renewals, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(heartbeat.lost, false);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(heartbeat.lost, true);
  heartbeat.stop();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(renewals, 2);

  const failing = startLeaseHeartbeat({
    leaseSeconds: 3,
    renew: async () => {
      throw new Error('connection reset');
    },
  });
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(failing.lost, true);
  failing.stop();
});

test('cappedExponentialBackoffSeconds: the KB operation / AI engine transition formula', () => {
  const inline = (attempt: number, base: number, max: number) =>
    Math.min(max, base * 2 ** Math.min(Math.max(attempt - 1, 0), 10));
  for (const [base, max] of [
    [30, 3_600],
    [5, 900],
    [1, 1_000_000],
  ]) {
    for (let attempt = -1; attempt <= 15; attempt += 1) {
      assert.equal(cappedExponentialBackoffSeconds(attempt, base, max), inline(attempt, base, max), `${attempt}`);
    }
  }
  assert.equal(cappedExponentialBackoffSeconds(1, 30, 3_600), 30);
  assert.equal(cappedExponentialBackoffSeconds(3, 30, 3_600), 120);
  assert.equal(cappedExponentialBackoffSeconds(20, 1, 1_000_000), 1_024);
  assert.equal(cappedExponentialBackoffSeconds(20, 1, 1_000_000, 16), 65_536);
});

test('createSingleFlight: a call during a running one returns at once; an error resets it', async () => {
  let runs = 0;
  let release: () => void = () => undefined;
  const drain = createSingleFlight(async () => {
    runs += 1;
    if (runs === 3) throw new Error('claim failed');
    await new Promise<void>(resolve => {
      release = resolve;
    });
  });
  const first = drain();
  await drain();
  assert.equal(runs, 1);
  release();
  await first;
  const second = drain();
  release();
  await second;
  assert.equal(runs, 2);
  await assert.rejects(drain(), /claim failed/);
  const fourth = drain();
  release();
  await fourth;
  assert.equal(runs, 4);
});

test('runWithConcurrency: every item, at most `limit` at a time, started in order', async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  await runWithConcurrency([1, 2, 3, 4, 5], 2, async item => {
    started.push(item);
    running += 1;
    peak = Math.max(peak, running);
    await settle();
    running -= 1;
  });
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);

  let calls = 0;
  await runWithConcurrency([], 4, async () => void (calls += 1));
  await runWithConcurrency(['a'], 8, async () => void (calls += 1));
  assert.equal(calls, 1);
  await assert.rejects(
    runWithConcurrency([1, 2], 2, async item => {
      if (item === 2) throw new Error('job 2 failed');
    }),
    /job 2 failed/,
  );
});
