// Renders the synthetic report-PDF fixtures (vi/en + edge cases) to PDF and
// per-page PNG previews with the configured system browser, for visual review.
// Usage: npm run report-pdf:samples -- --out <directory> [--only <fixture-name>]
// Writes only to the given directory. No database, storage or AI calls.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allReportPdfFixtures } from '../modules/ai-chatbot/report-pdf.fixture.js';
import { composeReportPdfDocument, paginateReportPdfDocument } from '../modules/ai-chatbot/report-pdf.service.js';
import { createReportPdfRenderer, getReportPdfRendererConfigFromEnv } from '../modules/ai-chatbot/report-pdf-renderer.service.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const out = argument('--out');
  if (!out) throw new Error('Missing --out <directory>');
  const only = argument('--only');
  const renderer = createReportPdfRenderer({ ...getReportPdfRendererConfigFromEnv(), idleCloseMs: 0 });
  try {
    for (const fixture of allReportPdfFixtures().filter((item) => !only || item.name === only)) {
      const started = Date.now();
      const composed = await composeReportPdfDocument({
        snapshot: fixture.snapshot,
        snapshotHash: fixture.snapshotHash,
        locale: fixture.locale,
        tenant: { name: fixture.tenantName, logoDataUri: null },
        storedNarrative: fixture.storedNarrative,
        storedNarrativeLocale: fixture.locale,
      });
      const composition = await paginateReportPdfDocument(composed, renderer);
      const result = await renderer.render(composition.html);
      const totalMs = Date.now() - started;
      const directory = path.resolve(out, fixture.name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.resolve(out, `report-${fixture.name}.pdf`), result.pdf);
      await writeFile(path.join(directory, 'document.html'), composition.html.replace(/url\(data:font\/ttf;base64,[^)]+\)/g, 'url(font-omitted)'));
      const shots = await renderer.screenshotPages(composition.html, { scale: 1.5 });
      await Promise.all(shots.map((shot, index) => writeFile(path.join(directory, `page-${String(index + 1).padStart(2, '0')}.png`), shot)));
      console.log(JSON.stringify({
        fixture: fixture.name,
        pages: result.pageCount,
        plan: composition.model.pages.map((sections) => sections.map((slice) => (slice.from === undefined ? slice.id : `${slice.id}[${slice.from}-${slice.to}]`)).join('+')),
        overflow: result.overflow,
        narrative: composition.narrative.source,
        bytes: result.pdf.byteLength,
        render_ms: result.durationMs,
        total_ms: totalMs,
      }));
    }
  } finally {
    await renderer.shutdown();
  }
}

// Imported service modules keep shared clients (DB pool, caches) referenced;
// this one-shot CLI exits explicitly once the browser is closed.
main().then(() => process.exit(0), (error) => {
  console.error('[report-pdf-samples] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
