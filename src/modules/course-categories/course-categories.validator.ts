// ═══════════════════════════════════════════════════════════════
// Course Categories Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

// ── Query strings ──
// The query strings of the course category list and public impact routes,
// read the way the controller and service always read them. They never
// reject and never coerce: every request accepted before is accepted with
// the same values (a repeated parameter stays a list, an absent key stays
// absent). Only the keys they read are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/course-categories */
export const courseCategoryListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  assigned_team_id: rawQueryValue,
});

/** GET /api/course-categories/:id/public-impact */
export const publicImpactQuerySchema = z.object({
  limit: rawQueryValue,
});
