// ═══════════════════════════════════════════════════════════════
// Text length as Postgres counts it
//
// VARCHAR(n) limits characters (code points). JavaScript's `length` counts
// UTF-16 units, so an emoji counts twice there and once in Postgres. Input
// limits that mirror a column's VARCHAR(n) use this count, so a value the
// column stores is never refused.
// ═══════════════════════════════════════════════════════════════

/** The number of characters (code points) of `value`. */
export function charCount(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/** True when `value` has at most `max` characters (code points). */
export function fitsChars(value: string, max: number): boolean {
  return value.length <= max || charCount(value) <= max;
}
