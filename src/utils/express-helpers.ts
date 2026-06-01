// ═══════════════════════════════════════════════════════════════
// Express 5 Param Helpers
// Express 5 ParamsDictionary allows `string | string[]` for params.
// These helpers safely extract single string values.
// ═══════════════════════════════════════════════════════════════

/**
 * Safely extract a string from Express 5 `req.params.*`.
 * Express 5 wildcard routes (`*name`) return `string[]`, normal routes return `string`.
 */
export function p(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val[0] || '';
  return val || '';
}

/**
 * Safely extract a string from Express 5 `req.query.*`.
 * Handles `ParsedQs` nested types safely.
 */
export function q(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  return '';
}
