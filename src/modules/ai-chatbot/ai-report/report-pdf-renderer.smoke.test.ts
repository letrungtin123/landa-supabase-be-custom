// Renders real PDFs with the configured system browser (Edge/Chrome through
// playwright-core). Skips cleanly when no browser can be started on this host.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createReportPdfRenderer, getReportPdfRendererConfigFromEnv, ReportPdfRendererError, type ReportPdfRenderer } from './report-pdf-renderer.service.js';
import { longNamesReportFixture, vietnameseReportFixture, englishExtendedReportFixture } from './report-pdf.fixture.js';
import { renderReportPdf } from './report-pdf.service.js';

let renderer: ReportPdfRenderer | null = null;
let unavailable: string | null = null;

test.before(async () => {
  renderer = createReportPdfRenderer({ ...getReportPdfRendererConfigFromEnv(), idleCloseMs: 0, timeoutMs: 60_000 });
  try {
    await renderer.measure('<!doctype html><div data-measure="probe" style="height:10px"></div>');
  } catch (error) {
    if (error instanceof ReportPdfRendererError && error.code === 'REPORT_PDF_RENDERER_UNAVAILABLE') unavailable = error.message;
    else throw error;
  }
});

test.after(async () => {
  await renderer?.shutdown();
});

const pdfPageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

function fixtureInput(fixture: ReturnType<typeof vietnameseReportFixture>) {
  return {
    snapshot: fixture.snapshot,
    snapshotHash: fixture.snapshotHash,
    locale: fixture.locale,
    tenant: { name: fixture.tenantName, logoDataUri: null },
    storedNarrative: fixture.storedNarrative,
    storedNarrativeLocale: fixture.locale,
  };
}

test('renders the Vietnamese sample to a tagged A4 PDF with embedded Noto Sans and no overflow', async (t) => {
  if (unavailable) { t.skip(`no browser: ${unavailable}`); return; }
  const result = await renderReportPdf(fixtureInput(vietnameseReportFixture()), renderer!);
  const raw = result.pdf.toString('latin1');
  assert.ok(raw.startsWith('%PDF-'));
  assert.deepEqual(result.overflow, []);
  assert.equal(pdfPageCount(result.pdf), result.pageCount);
  assert.ok(result.pageCount >= 7);
  assert.ok(/\/FontFile2/.test(raw), 'fonts are embedded');
  assert.ok(/\/FontName\s*\/[A-Z]{6}\+NotoSans/.test(raw), 'Noto Sans subset embedded');
  assert.ok(/\/StructTreeRoot/.test(raw), 'tagged PDF for accessibility');
  assert.ok(/\/MediaBox\s*\[\s*0\s+0\s+59[45](?:\.\d+)?\s+84[12](?:\.\d+)?\s*\]/.test(raw), 'A4 pages');
});

test('splits a 20-course portfolio with very long names without overflow', async (t) => {
  if (unavailable) { t.skip(`no browser: ${unavailable}`); return; }
  for (const fixture of [longNamesReportFixture('vi'), englishExtendedReportFixture()]) {
    const result = await renderReportPdf(fixtureInput(fixture), renderer!);
    assert.deepEqual(result.overflow, [], fixture.name);
    assert.equal(pdfPageCount(result.pdf), result.pageCount, fixture.name);
  }
});

test('the page sandbox runs no scripts and makes no network requests', async (t) => {
  if (unavailable) { t.skip(`no browser: ${unavailable}`); return; }
  let hits = 0;
  const server = createServer((_request, response) => { hits += 1; response.end('x'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const probe = `<!doctype html><html><body>
      <div data-measure="box" style="height:10px"></div>
      <img src="http://127.0.0.1:${port}/pixel.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/x.css">
      <script>document.querySelector('[data-measure]').style.height = '200px';</script>
      </body></html>`;
    const sizes = await renderer!.measure(probe);
    assert.equal(Math.round(sizes.box), 10, 'inline script did not run');
    const result = await renderer!.render(probe);
    assert.ok(result.pdf.byteLength > 0);
    assert.equal(hits, 0, 'no request reached the network');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
