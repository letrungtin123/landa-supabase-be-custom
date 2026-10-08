// Embeds the locally installed Noto Sans weights (full Vietnamese coverage) as
// data URIs. The renderer blocks all network access, so the document can never
// fetch a font (or anything else) from outside. Chromium subsets the glyphs that
// are actually used into the PDF, so the output stays small.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const REPORT_PDF_FONT_FAMILY = 'Report Sans';
const WEIGHTS: ReadonlyArray<readonly [number, string]> = [
  [400, 'NotoSans-Regular.ttf'],
  [500, 'NotoSans-Medium.ttf'],
  [600, 'NotoSans-SemiBold.ttf'],
  [700, 'NotoSans-Bold.ttf'],
  [800, 'NotoSans-ExtraBold.ttf'],
];

let cachedFontCss: string | null = null;

export function resolveReportPdfFontDirectory(): string {
  const require = createRequire(import.meta.url);
  // The package entry lives in dist/; the TTF files ship next to it in fonts/.
  return path.resolve(path.dirname(require.resolve('@embedpdf/fonts-latin')), '..', 'fonts');
}

/** @font-face rules with embedded fonts; read once per process (immutable files). */
export function getReportPdfFontCss(): string {
  if (cachedFontCss) return cachedFontCss;
  const directory = resolveReportPdfFontDirectory();
  cachedFontCss = WEIGHTS.map(([weight, file]) => {
    const data = readFileSync(path.join(directory, file)).toString('base64');
    return `@font-face{font-family:'${REPORT_PDF_FONT_FAMILY}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/ttf;base64,${data}) format('truetype');}`;
  }).join('\n');
  return cachedFontCss;
}
