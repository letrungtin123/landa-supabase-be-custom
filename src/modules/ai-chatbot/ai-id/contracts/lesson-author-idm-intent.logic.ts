/**
 * Author intent for the IDM pipeline (QLT-5 A): the CMS course name and
 * description, read live when the course-skeleton task runs, cleaned to plain
 * single-line text and bounded before they reach the AI service. They are the
 * author's statement of what the course is for; Python puts them in a labelled
 * data block (`AUTHOR_COURSE_INTENT`), never in an instruction.
 */

/** `courses.display_name` bound (the CMS column), below Python's 500. */
export const IDM_AUTHOR_TITLE_MAX_CHARS = 255;
/** Python `IdmProjectContextV1.course_description` max_length. */
export const IDM_AUTHOR_DESCRIPTION_MAX_CHARS = 2_000;

/** Content of these elements is never author text (editor artefacts, embedded code). */
const HIDDEN_ELEMENT = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/g;
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,15});/g;
/** Common named entities of rich-text editors, Vietnamese vowels included. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', egrave: 'è', eacute: 'é', ecirc: 'ê', igrave: 'ì',
  iacute: 'í', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ugrave: 'ù', uacute: 'ú', yacute: 'ý',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Igrave: 'Ì',
  Iacute: 'Í', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ugrave: 'Ù', Uacute: 'Ú', Yacute: 'Ý',
});
/** C0/C1 controls, DEL and lone surrogates become spaces (U+0085 is one: pydantic strips it, JS `\s` does not). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** JS whitespace plus every Unicode White_Space pydantic strips, so Python receives text it will not change. */
const WHITESPACE = /[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

function decodeEntity(match: string, body: string): string {
  if (body.startsWith('#')) {
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code) : ' ';
  }
  return NAMED_ENTITIES[body] ?? match;
}

/**
 * Plain, single-line author text bounded to `maxChars` code points (Python `len`), or null when nothing is
 * left: HTML elements, comments and tags removed, common entities decoded, `<`/`>` kept as the single angle
 * quotation marks the workspace uses (R10), control characters and whitespace runs collapsed, trimmed.
 */
export function sanitizeIdmAuthorText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxChars) || maxChars < 1) return null;
  const text = value.replace(HIDDEN_ELEMENT, ' ').replace(HTML_COMMENT, ' ').replace(HTML_TAG, ' ')
    .replace(ENTITY, decodeEntity).replace(/</g, '‹').replace(/>/g, '›')
    .replace(CONTROL, ' ').replace(WHITESPACE, ' ').trim();
  const bounded = Array.from(text).slice(0, maxChars).join('').replace(WHITESPACE, ' ').trim();
  return bounded || null;
}

/** The author intent sent in `project_context` (`course_title_hint` keeps its contract-1 name). */
export function idmAuthorIntent(input: { course_title: unknown; course_description: unknown }): {
  course_title_hint: string | null;
  course_description: string | null;
} {
  return {
    course_title_hint: sanitizeIdmAuthorText(input.course_title, IDM_AUTHOR_TITLE_MAX_CHARS),
    course_description: sanitizeIdmAuthorText(input.course_description, IDM_AUTHOR_DESCRIPTION_MAX_CHARS),
  };
}
