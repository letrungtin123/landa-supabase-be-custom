// ═══════════════════════════════════════════════════════════════
// Notifications Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

// ── Query strings ──
// The query string of GET /api/notifications, read the way the service
// always read it. It never rejects and never coerces: every request accepted
// before is accepted with the same values (a repeated parameter stays a
// list). Only the keys the service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/notifications */
export const notificationListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  course_id: rawQueryValue,
});
