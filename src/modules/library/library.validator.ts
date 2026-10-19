// ═══════════════════════════════════════════════════════════════
// Library query schemas: the query string of the library list routes, read
// the way the service always read it. They never reject and never coerce:
// every request accepted before is accepted with the same values (a repeated
// parameter stays a list, a page that is not a number is read by the service
// as before). Only the keys a service reads are kept. Request bodies are
// still read by the controller as before.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/library/categories */
export const libraryCategoriesQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  assigned_team_id: rawQueryValue,
});

/** GET /api/library/documents */
export const libraryDocumentsQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  category_id: rawQueryValue,
  extension: rawQueryValue,
});

/** GET /api/library/categories/:id/public-impact: `?limit=5` -> 5; absent or empty -> undefined; not a number -> NaN (as before). */
export const libraryPublicImpactQuerySchema = z.object({
  limit: z.unknown().transform(value => (value ? Number(value) : undefined)),
});
