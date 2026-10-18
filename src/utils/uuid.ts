// ═══════════════════════════════════════════════════════════════
// UUID checks — the one definition for the whole backend
// ═══════════════════════════════════════════════════════════════
//
// UUID_PATTERN is the check the modules used before this file existed:
// 8-4-4-4-12 hex digits, either case; version and variant bits are not
// checked. isUuid() also requires a string. Code that tested a value without
// a type check keeps `UUID_PATTERN.test(value)`: RegExp.test converts a
// non-string first (a one-element array of a UUID passes), isUuid refuses it.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string in UUID_PATTERN form. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Stricter form, kept for the callers that already used it: tenant fences,
// data-quota tenant ids, audit-log ids, lesson-author command ids and upload
// attempt ids. It accepts versions 1-5 with the RFC 4122 variant (8, 9, a, b)
// only, so these callers keep refusing the nil UUID and v6-v8 ids.

export const RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A string in RFC_UUID_PATTERN form. */
export function isRfcUuid(value: unknown): value is string {
  return typeof value === 'string' && RFC_UUID_PATTERN.test(value);
}
