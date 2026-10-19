// Job runner: the shared steps of the background jobs that live in database
// tables (claim -> lease -> heartbeat -> backoff -> complete / fail). Each
// job keeps its own SQL (claim query, lease length, backoff columns, status
// names) in its module; these helpers only fix how the steps are driven, so
// moving a job onto them changes no statement.
//
// - runSlicedJob: a job that works in bounded batches and yields its turn.
// - consumeJobWakeUps: the RabbitMQ `{ jobId }` wake-up consumer.
// - startJobPoller: the interval that recovers lost wake-ups / stale jobs.
// - startLeaseHeartbeat, leaseRenewIntervalMs, cappedExponentialBackoffSeconds: leased jobs.
// - createSingleFlight, runWithConcurrency: the claim-and-drain loop of polled jobs.
export { runSlicedJob, type SliceOutcome, type SlicedJob, type SlicedJobOutcome } from './sliced-job.js';
export { consumeJobWakeUps, readJobId, type JobWakeUpConsumerOptions } from './wake-up-consumer.js';
export { startJobPoller, type JobPollerOptions } from './poller.js';
export {
  cappedExponentialBackoffSeconds,
  leaseRenewIntervalMs,
  startLeaseHeartbeat,
  type LeaseHeartbeat,
} from './lease.js';
export { createSingleFlight, runWithConcurrency } from './drain.js';
