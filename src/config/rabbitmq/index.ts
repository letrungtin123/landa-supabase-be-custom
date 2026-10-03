// ═══════════════════════════════════════════════════════════════
// RabbitMQ — Barrel export + queue constants
// ═══════════════════════════════════════════════════════════════

import { env } from '../env.js';

export { connectRabbitMQ, assertQueue, closeRabbitMQ, getChannel, createRabbitChannel } from './connection.js';
export { publish } from './publisher.js';
export { consume } from './consumer.js';

/** Queue name constants */
const queue = (name: string) => `${env.RABBITMQ_QUEUE_PREFIX}${name}`;
export const QUEUES = {
  GEMINI_UPLOAD: process.env.GEMINI_UPLOAD_QUEUE || queue('LANDA_GEMINI_UPLOAD'),
  GEMINI_DELETE: process.env.GEMINI_DELETE_QUEUE || queue('LANDA_GEMINI_DELETE'),
  GEMINI_RESTORE: process.env.GEMINI_RESTORE_QUEUE || queue('LANDA_GEMINI_RESTORE'),
  COURSE_DELETE: process.env.COURSE_DELETE_QUEUE || queue('LANDA_COURSE_DELETE'),
  USER_DELETE: process.env.USER_DELETE_QUEUE || queue('LANDA_USER_DELETE'),
  LESSON_AUTHOR_SESSION_DELETE: process.env.LESSON_AUTHOR_SESSION_DELETE_QUEUE || queue('LANDA_LESSON_AUTHOR_SESSION_DELETE'),
  EMAIL_OUTBOX: process.env.EMAIL_OUTBOX_QUEUE || queue('LANDA_EMAIL_OUTBOX'),
  COURSE_PROGRESS_RECALC: process.env.COURSE_PROGRESS_RECALC_QUEUE || queue('LANDA_COURSE_PROGRESS_RECALC'),
  // No API bootstrap asserts or consumes this queue. Only the default-off V2
  // dedicated entry point may own it after the manual SQL is verified.
  LESSON_AUTHOR_ORCHESTRATION_V2: process.env.LESSON_AUTHOR_ORCHESTRATION_V2_QUEUE
    || queue('LANDA_LESSON_AUTHOR_ORCHESTRATION_V2'),
} as const;
