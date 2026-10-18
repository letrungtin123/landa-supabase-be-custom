// XSS-safe HTML building for the report PDF template. Every interpolated value
// is escaped unless it is a SafeHtml produced by this module (nested templates
// or server-generated SVG). Tenant data (course, unit, tenant names) is always
// escaped; the page also runs with JavaScript disabled and no network.

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string { return this.value; }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (char) => ESCAPES[char]);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}

/** Tagged template: `html\`<p>${userText}</p>\`` escapes userText. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let output = strings[0];
  values.forEach((value, index) => {
    output += renderValue(value) + strings[index + 1];
  });
  return new SafeHtml(output);
}

/** Marks trusted, server-generated markup (only use for constant or generated SVG). */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Formats a number for SVG/CSS attributes; never emits NaN/Infinity. */
export function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Renders narrative text with entity tokens ({{C1}}, {{U2}}) replaced by the
 * escaped entity names. The text itself is escaped first, so a token can only
 * ever expand to escaped, known names.
 */
export function renderNarrativeText(text: string, entities: Record<string, string>): SafeHtml {
  const escaped = escapeHtml(text);
  return new SafeHtml(escaped.replace(/\{\{([CU]\d{1,3})\}\}/g, (_match, token: string) => {
    const name = entities[token];
    return name ? `<span class="entity">${escapeHtml(name)}</span>` : '';
  }));
}
