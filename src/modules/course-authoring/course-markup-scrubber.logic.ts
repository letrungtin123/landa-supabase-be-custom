// ═══════════════════════════════════════════════════════════════
// Active-markup scrubber for component payloads that are not plain course
// rich text: problem OLX, and markup strings inside component JSON
// (studio_submit, FAQ/sortable/crossword/PDF data, metadata).
//
// These payloads use their own vocabularies (OLX tags such as <problem>,
// <choicegroup>), so an HTML allowlist would destroy them. Instead:
//   1. a value without active markup is returned byte-for-byte unchanged;
//   2. a value with active markup is re-serialized by sanitize-html with all
//      tags/attributes allowed EXCEPT executable elements (script, iframe,
//      object, embed, ...), event-handler attributes (quoted or unquoted)
//      and javascript:/vbscript:/data: URLs. Problem OLX is parsed as XML.
// Renderers still sanitize on display (DOMPurify); this is the stored-data
// boundary.
// ═══════════════════════════════════════════════════════════════

import sanitizeHtml from 'sanitize-html';

const EXECUTABLE_ELEMENTS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'base', 'meta', 'link',
]);
/** edX server-side grading scripts: never executed by a browser (non-JS type). */
const INERT_SCRIPT_TYPES = new Set(['loncapa/python', 'text/python', 'python']);
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'background', 'poster', 'codebase', 'cite', 'srcset', 'dynsrc', 'lowsrc',
]);
const SCRIPT_SCHEME = /^(?:javascript|vbscript):/i;
const INLINE_RASTER_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|bmp);/i;

const ACTIVE_ELEMENT = /<\s*\/?\s*(?:iframe|frame|frameset|object|embed|applet|noscript|template|base|meta|link)\b/i;
const SCRIPT_OPEN_TAG = /<\s*script\b([^>]*)>/gi;
const SCRIPT_TYPE_ATTRIBUTE = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Any <script> whose type is not one of the inert edX grading types. */
function containsExecutableScript(view: string): boolean {
  for (const match of view.matchAll(SCRIPT_OPEN_TAG)) {
    const type = SCRIPT_TYPE_ATTRIBUTE.exec(match[1]);
    const value = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase();
    if (!INERT_SCRIPT_TYPES.has(value)) return true;
  }
  return false;
}
const EVENT_HANDLER = /[\s"'/`]on[a-z0-9_-]+\s*=/i;
const SCRIPT_URL = /(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

const NAMED_SCAN_ENTITIES: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')' };

/** Entity-decoded, tab/newline-free view used only for detection. */
function scanView(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_SCAN_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[\t\n\r]/g, '');
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** True when the string contains markup a browser could execute. */
export function containsActiveMarkup(value: string): boolean {
  if (!value.includes('<')) return false;
  const view = scanView(value);
  return ACTIVE_ELEMENT.test(view) || containsExecutableScript(view) || EVENT_HANDLER.test(view) || SCRIPT_URL.test(view);
}

function isDangerousUrl(attribute: string, value: string): boolean {
  // Browsers ignore control characters and whitespace inside a URL scheme.
  const url = scanView(String(value)).replace(/[\u0000- \u007f]+/g, '');
  if (SCRIPT_SCHEME.test(url)) return true;
  // data: URLs only as inline raster images; never as links, frames or objects.
  return /^data:/i.test(url) && !(attribute === 'src' && INLINE_RASTER_IMAGE.test(url));
}

function scrubOptions(xml: boolean): sanitizeHtml.IOptions {
  return {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    parser: xml ? { xmlMode: true, decodeEntities: false } : {},
    exclusiveFilter: (frame) => {
      const tag = frame.tag.toLowerCase();
      if (!EXECUTABLE_ELEMENTS.has(tag)) return false;
      return !(tag === 'script' && INERT_SCRIPT_TYPES.has(String(frame.attribs.type ?? '').trim().toLowerCase()));
    },
    transformTags: {
      '*': (tagName, attribs) => {
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          const lower = name.toLowerCase();
          if (lower.startsWith('on') || lower === 'srcdoc') continue;
          if (URL_ATTRIBUTES.has(lower) && isDangerousUrl(lower, value)) continue;
          if (lower === 'style' && /expression\s*\(|javascript\s*:/i.test(scanView(value))) continue;
          kept[name] = value;
        }
        return { tagName, attribs: kept };
      },
    },
  };
}

/** Scrubs one markup string; unchanged (same string) when nothing is active. */
export function scrubActiveMarkup(value: string, options: { xml?: boolean } = {}): string {
  if (!containsActiveMarkup(value)) return value;
  return sanitizeHtml(value, scrubOptions(options.xml === true));
}

const MAX_SCRUB_DEPTH = 40;

/**
 * Scrubs every string inside a component payload (objects, arrays, and JSON
 * documents stored as strings). Values without active markup keep their
 * exact form, so valid data is never rewritten.
 */
export function scrubMarkupDeep<T>(value: T, options: { xml?: boolean } = {}, depth = 0): T {
  if (depth > MAX_SCRUB_DEPTH) return value;
  if (typeof value === 'string') return scrubString(value, options, depth) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const scrubbed = scrubMarkupDeep(item, options, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const scrubbed = scrubMarkupDeep(item, options, depth + 1);
      if (scrubbed !== item) changed = true;
      next[key] = scrubbed;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

function scrubString(value: string, options: { xml?: boolean }, depth: number): string {
  if (!value.includes('<')) return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const scrubbed = scrubMarkupDeep(parsed, options, depth + 1);
      return scrubbed === parsed ? value : JSON.stringify(scrubbed);
    } catch {
      // Not JSON: treat as markup below.
    }
  }
  return scrubActiveMarkup(value, options);
}
