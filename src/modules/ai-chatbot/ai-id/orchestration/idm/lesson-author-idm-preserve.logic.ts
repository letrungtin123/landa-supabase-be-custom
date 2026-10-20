/**
 * QLT-6 "keep the document as it is" (`preserve_source`): the exact-text rule of a kept unit.
 *
 * Every learner-visible word of a kept unit is the document's own text, in order. Node checks
 * it on the html it stores (after the course html sanitizer), Python on the html it renders
 * (`landa-ai-rag/app/idm/preserve_lines.py` + `preserve_render.py`); both read the same words:
 *
 * - a source line's visible text is the line itself, except a table row of the source
 *   snapshot (`Row N: a | b | c`), whose visible text is its cells (the `Row N:` label and the
 *   ` | ` separators are parser markup, not words of the document; a broken bar in a cell is a
 *   literal pipe);
 * - html: tags are separators and the entities the renderer and the sanitizers emit are
 *   decoded once;
 * - words are the parts between ECMAScript white-space runs (the same set in both languages).
 *
 * The cross-language test (`lesson-author-idm-preserve.cross-language.test.ts`) pins the parity.
 */

/** ECMAScript WhiteSpace + LineTerminator, as code points (what `\s` and `trim()` use). */
const WS_CODES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff] as const;
const WS = String.fromCodePoint(...WS_CODES);
const WS_RUN = new RegExp(`[${WS}]+`, 'u');
const TABLE_ROW = new RegExp(`^Row[${WS}]+([0-9]+)[${WS}]*:[${WS}]*([\\s\\S]+)$`, 'iu');
const CELL_SPLIT = new RegExp(`[${WS}]+\\|[${WS}]+`, 'u');
const ESCAPED_PIPE = String.fromCodePoint(0xa6);
const TAG = /<[^>]+>/g;
const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"',
  apos: "'", nbsp: String.fromCodePoint(0xa0) });
const MAX_CODE_POINT = 0x10ffff;

export const IDM_PRESERVE_DESIGN_MODE = 'preserve_source' as const;
export const PRESERVE_TEXT_ADDED = 'PRESERVE_TEXT_ADDED';
export const PRESERVE_TEXT_MISSING = 'PRESERVE_TEXT_MISSING';
export const PRESERVE_TEXT_CHANGED = 'PRESERVE_TEXT_CHANGED';
/** A kept unit is exactly one html slot that owns every line of the unit. */
export const PRESERVE_UNIT_SHAPE = 'PRESERVE_UNIT_SHAPE';
export type IdmPreserveTextCode = typeof PRESERVE_TEXT_ADDED | typeof PRESERVE_TEXT_MISSING
  | typeof PRESERVE_TEXT_CHANGED;

/** True for a unit brief (or design context) of a document kept as it is. */
export function isIdmPreserveSource(value: { design_mode?: string | null } | null | undefined): boolean {
  return value?.design_mode === IDM_PRESERVE_DESIGN_MODE;
}

export function idmPreserveTokens(text: string): string[] {
  return text.split(WS_RUN).filter(part => part.length > 0);
}

/** The cells of a source table-row line, or null for any other line. */
export function idmPreserveTableCells(text: string): string[] | null {
  const match = TABLE_ROW.exec(text);
  if (!match) return null;
  return match[2]!.split(CELL_SPLIT).map(cell => cell.trim().split(ESCAPED_PIPE).join('|'))
    .filter(cell => cell.length > 0);
}

export function idmPreserveVisibleText(text: string): string {
  const cells = idmPreserveTableCells(text);
  return cells === null ? text : cells.join(' ');
}

export function idmPreserveExpectedTokens(factTexts: readonly string[]): string[] {
  return factTexts.flatMap(text => idmPreserveTokens(idmPreserveVisibleText(text)));
}

function decodeEntity(match: string, decimal?: string, hexadecimal?: string, name?: string): string {
  if (name !== undefined) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name]! : match;
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hexadecimal!, 16);
  if (code > MAX_CODE_POINT || (code >= 0xd800 && code <= 0xdfff)) return match;
  return String.fromCodePoint(code);
}

export function idmPreserveHtmlTokens(html: string): string[] {
  return idmPreserveTokens(html.replace(TAG, ' ').replace(ENTITY, decodeEntity));
}

/** Null when the html shows exactly the lines' words in order; else what differs. */
export function idmPreserveTextFinding(factTexts: readonly string[], html: string): IdmPreserveTextCode | null {
  const expected = idmPreserveExpectedTokens(factTexts);
  const actual = idmPreserveHtmlTokens(html);
  if (actual.length === expected.length && actual.every((token, index) => token === expected[index])) return null;
  if (actual.length > expected.length) return PRESERVE_TEXT_ADDED;
  if (actual.length < expected.length) return PRESERVE_TEXT_MISSING;
  return PRESERVE_TEXT_CHANGED;
}

/**
 * The exact-text check of a kept unit on its stored component payloads: one html slot
 * (`index` null for a unit-level problem) whose stored html shows exactly the unit's lines.
 */
export function idmPreserveUnitFinding(
  planTypes: readonly string[],
  factTexts: readonly string[],
  storedData: readonly unknown[],
): { code: string; index: number | null } | null {
  if (planTypes.length !== 1 || planTypes[0] !== 'html' || storedData.length !== 1
    || typeof storedData[0] !== 'string') return { code: PRESERVE_UNIT_SHAPE, index: null };
  const code = idmPreserveTextFinding(factTexts, storedData[0]);
  return code === null ? null : { code, index: 0 };
}
