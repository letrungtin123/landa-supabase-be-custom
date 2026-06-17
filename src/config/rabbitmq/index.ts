// ═══════════════════════════════════════════════════════════════
// RabbitMQ — Barrel export + queue constants
// ═══════════════════════════════════════════════════════════════

export { connectRabbitMQ, assertQueue, closeRabbitMQ, getChannel } from './connection.js';
export { publish } from './publisher.js';
export { consume } from './consumer.js';

/** Queue name constants */
export const QUEUES = {
  GEMINI_UPLOAD: process.env.GEMINI_UPLOAD_QUEUE || 'LANDA_GEMINI_UPLOAD',
  GEMINI_DELETE: process.env.GEMINI_DELETE_QUEUE || 'LANDA_GEMINI_DELETE',
  COURSE_DELETE: process.env.COURSE_DELETE_QUEUE || 'LANDA_COURSE_DELETE',
} as const;
