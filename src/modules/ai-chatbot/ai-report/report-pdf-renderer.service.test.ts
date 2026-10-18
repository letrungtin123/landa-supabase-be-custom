// Renderer resilience with a fake browser (no real browser is started): a
// page that never opens, a context or browser close that hangs, and repeated
// failures must neither wedge the renderer nor leak a render slot.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserType } from 'playwright-core';
import { createReportPdfRenderer, type ReportPdfRendererConfig } from './report-pdf-renderer.service.js';

interface Behaviour {
  hangNewPage?: boolean;
  newPageDelayMs?: number;
  hangSetContent?: boolean;
  failSetContent?: boolean;
  hangContextClose?: boolean;
  hangBrowserClose?: boolean;
}

const never = () => new Promise<never>(() => undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBrowsers(behaviour: () => Behaviour) {
  const state = { launches: 0, browserCloses: 0, contexts: 0, contextCloses: 0 };
  const launcher = {
    launch: async () => {
      state.launches += 1;
      const pid = 4_000 + state.launches;
      const browser = {
        on: () => browser,
        newBrowserCDPSession: async () => ({
          send: async () => ({ processInfo: [{ type: 'GPU', id: 1, cpuTime: 0 }, { type: 'browser', id: pid, cpuTime: 0 }] }),
          detach: async () => undefined,
        }),
        close: async () => { state.browserCloses += 1; if (behaviour().hangBrowserClose) await never(); },
        newContext: async () => {
          state.contexts += 1;
          const page = {
            on: () => page,
            emulateMedia: async () => undefined,
            setContent: async () => {
              if (behaviour().hangSetContent) await never();
              if (behaviour().failSetContent) throw new Error('Target crashed');
            },
            evaluate: async (script: string) => (script.includes('pageCount') ? { pageCount: 1, overflow: [] } : script.includes('fonts.ready') ? true : {}),
            pdf: async () => Buffer.from('%PDF-1.7 fake'),
            goto: async () => null,
            $$: async () => [],
          };
          return {
            route: async () => undefined,
            newPage: async () => {
              if (behaviour().hangNewPage) await never();
              if (behaviour().newPageDelayMs) await sleep(behaviour().newPageDelayMs!);
              return page;
            },
            close: async () => { state.contextCloses += 1; if (behaviour().hangContextClose) await never(); },
          };
        },
      };
      return browser;
    },
  };
  return { launcher: launcher as unknown as Pick<BrowserType, 'launch'>, state };
}

function setup(behaviour: Behaviour, overrides: Partial<ReportPdfRendererConfig> = {}) {
  const current = { value: behaviour };
  const fake = fakeBrowsers(() => current.value);
  const killed: number[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const config: ReportPdfRendererConfig = {
    executablePath: null, channel: 'msedge', concurrency: 1, queueLimit: 0, timeoutMs: 100, idleCloseMs: 0,
    maxRendersPerPage: 50, closeTimeoutMs: 50, maxConsecutiveFailures: 3, ...overrides,
  };
  const renderer = createReportPdfRenderer(config, fake.launcher, { killProcess: (pid) => killed.push(pid), log: (event) => logs.push(event) });
  return { renderer, state: fake.state, killed, logs, set: (next: Behaviour) => { current.value = next; } };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('a page that never opens times out within the render deadline and frees the slot', async () => {
  const h = setup({ hangNewPage: true });
  const started = Date.now();
  await assert.rejects(h.renderer.render('<p>x</p>'), code('REPORT_PDF_RENDER_TIMEOUT'));
  assert.ok(Date.now() - started < 1_000, 'browser launch and newPage are inside the render timeout');
  assert.equal(h.renderer.stats().active, 0);
  // The wedged browser was recycled: the next render (concurrency 1, no queue) launches a fresh one.
  h.set({});
  assert.equal((await h.renderer.render('<p>x</p>')).pdf.toString(), '%PDF-1.7 fake');
  assert.equal(h.state.launches, 2);
  assert.ok(h.logs.some((event) => event.event === 'report_pdf_browser_recycled' && event.reason === 'render_timeout'));
  await h.renderer.shutdown();
});

test('a page that arrives after the deadline is closed instead of leaked', async () => {
  const h = setup({ newPageDelayMs: 150 });
  await assert.rejects(h.renderer.measure('<p>x</p>'), code('REPORT_PDF_RENDER_TIMEOUT'));
  await until(() => h.state.contextCloses === 1, 'the late context to be closed');
  assert.equal(h.renderer.stats().active, 0);
  await h.renderer.shutdown();
});

test('a render that hangs inside the page times out, frees the slot and kills a browser whose close hangs', async () => {
  const h = setup({ hangSetContent: true, hangBrowserClose: true });
  await assert.rejects(h.renderer.render('<p>x</p>'), code('REPORT_PDF_RENDER_TIMEOUT'));
  assert.equal(h.renderer.stats().active, 0);
  await until(() => h.killed.length === 1, 'the hung browser to be killed');
  assert.deepEqual(h.killed, [4_001], 'the browser process found through CDP is killed');
  assert.ok(h.logs.some((event) => event.event === 'report_pdf_browser_kill' && event.pid === 4_001));
  h.set({});
  assert.equal((await h.renderer.render('<p>x</p>')).pageCount, 1);
  await h.renderer.shutdown();
});

test('a context close that hangs never holds the slot and recycles the browser', async () => {
  const h = setup({ hangContextClose: true }, { maxRendersPerPage: 1 });
  // The render succeeds; returning its page closes the context, which hangs (bounded to 50 ms).
  assert.equal((await h.renderer.render('<p>x</p>')).pdf.toString(), '%PDF-1.7 fake');
  assert.equal(h.renderer.stats().active, 0);
  await until(() => h.state.browserCloses === 1, 'the browser to be recycled');
  assert.ok(h.logs.some((event) => event.event === 'report_pdf_browser_recycled' && event.reason === 'page_close_hung'));
  h.set({});
  await h.renderer.render('<p>x</p>');
  assert.equal(h.state.launches, 2);
  await h.renderer.shutdown();
});

test('repeated failures recycle the browser and every failure frees its slot', async () => {
  const h = setup({ failSetContent: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(h.renderer.render('<p>x</p>'), code('REPORT_PDF_RENDER_FAILED'));
    assert.equal(h.renderer.stats().active, 0);
  }
  await until(() => h.state.browserCloses === 1, 'the browser to be recycled after 3 failures');
  h.set({});
  await h.renderer.render('<p>x</p>');
  assert.equal(h.state.launches, 2);
  await h.renderer.shutdown();
});

test('shutdown kills a browser whose close hangs', async () => {
  const h = setup({ hangBrowserClose: true });
  await h.renderer.render('<p>x</p>');
  await h.renderer.shutdown();
  assert.deepEqual(h.killed, [4_001]);
  await assert.rejects(h.renderer.render('<p>x</p>'), code('REPORT_PDF_RENDERER_UNAVAILABLE'));
});
