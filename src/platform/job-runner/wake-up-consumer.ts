// RabbitMQ wake-ups for durable jobs. The message only carries `{ jobId }`;
// the job row in the database is the source of truth, so a lost message is
// recovered by the job's poller (startJobPoller) and a duplicate one finds
// the job already claimed.
//
// A run that throws is recorded on the job row (onRunFailed) and the error
// goes back to the RabbitMQ consumer, which publishes the message again
// (config/rabbitmq/consumer.ts: up to 3 retries, waiting between them when
// retryBackoff is on). After the last retry onRetriesExhausted runs.
import { consume } from '../../config/rabbitmq/consumer.js';

export interface JobWakeUpConsumerOptions {
  queue: string;
  /** Prefix of the log lines, e.g. '[course-progress-recalculation]'. */
  logPrefix: string;
  prefetch: number;
  /** Wait between RabbitMQ retries; for jobs whose row has no retry backoff of its own. */
  retryBackoff: boolean;
  run(jobId: string): Promise<void>;
  /** The run threw: record it on the job row before RabbitMQ retries the message. */
  onRunFailed(jobId: string, error: unknown): Promise<void>;
  /** RabbitMQ gave up on the message after its last retry. */
  onRetriesExhausted(jobId: string): Promise<void>;
  /**
   * Unset: a message without a jobId is logged ("<logPrefix> Ignoring message
   * without jobId") and acknowledged, and an error of onRetriesExhausted goes
   * back to the RabbitMQ consumer, which logs it.
   *
   * Set: a message without a jobId fails with Error(missingJobIdMessage) like
   * a failed run (onRunFailed is not called), so RabbitMQ retries it; after
   * the last retry that error, or an error of onRetriesExhausted, goes to
   * onRetriesExhaustedError.
   */
  requiredJobId?: {
    missingJobIdMessage: string;
    onRetriesExhaustedError(error: unknown): void;
  };
}

/** The trimmed `jobId` of a wake-up message; null when it is missing or blank. */
export function readJobId(message: { [key: string]: unknown; jobId?: unknown }): string | null {
  return typeof message.jobId === 'string' && message.jobId.trim() ? message.jobId.trim() : null;
}

function readJobIdFromRawMessage(rawMessage: string): string | null {
  try {
    return readJobId(JSON.parse(rawMessage));
  } catch {
    return null;
  }
}

export async function consumeJobWakeUps(options: JobWakeUpConsumerOptions): Promise<void> {
  const required = options.requiredJobId;
  await consume(
    options.queue,
    async (message: { [key: string]: unknown; jobId?: unknown }) => {
      const jobId = readJobId(message);
      if (!jobId) {
        if (required) throw new Error(required.missingJobIdMessage);
        console.warn(`${options.logPrefix} Ignoring message without jobId`);
        return;
      }

      try {
        await options.run(jobId);
      } catch (error) {
        await options.onRunFailed(jobId, error);
        throw error;
      }
    },
    async (_queue: string, rawMessage: string) => {
      if (required) {
        try {
          const jobId = readJobId(JSON.parse(rawMessage));
          if (!jobId) throw new Error(required.missingJobIdMessage);
          await options.onRetriesExhausted(jobId);
        } catch (error) {
          required.onRetriesExhaustedError(error);
        }
        return;
      }

      const jobId = readJobIdFromRawMessage(rawMessage);
      if (!jobId) return;
      await options.onRetriesExhausted(jobId);
    },
    {
      prefetch: options.prefetch,
      retryBackoff: options.retryBackoff,
    },
  );
}
