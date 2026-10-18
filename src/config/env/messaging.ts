// Env: RabbitMQ and Redis (part of `env`, see ../env.ts).

import './load.js';
import { optionalBoundedInt, optionalInt, optionalNonNegativeInt, optionalString, required } from './helpers.js';

export const messagingEnv = {
  // RabbitMQ (mandatory — crash if missing)
  RABBITMQ_URL: required('RABBITMQ_URL'),
  RABBITMQ_QUEUE_PREFIX: optionalString('RABBITMQ_QUEUE_PREFIX', ''),
  // A failed message of a consumer with retry backoff waits about this long
  // before its next attempt, doubling per attempt (3 retries), capped at the
  // max. Also the wait before a message is requeued when its retry could not
  // be published. 0 = no wait (the former behavior).
  RABBITMQ_RETRY_BASE_DELAY_MS: optionalBoundedInt('RABBITMQ_RETRY_BASE_DELAY_MS', 2_000, 0, 60_000),
  RABBITMQ_RETRY_MAX_DELAY_MS: optionalBoundedInt('RABBITMQ_RETRY_MAX_DELAY_MS', 15_000, 0, 120_000),

  // Redis (optional; DB fallback is used if unavailable)
  REDIS_URL: process.env.REDIS_URL?.trim() || '',
  REDIS_DATABASE: optionalNonNegativeInt('REDIS_DATABASE', 0),
  REDIS_CONNECT_TIMEOUT_MS: optionalInt('REDIS_CONNECT_TIMEOUT_MS', 2_000),
} as const;
