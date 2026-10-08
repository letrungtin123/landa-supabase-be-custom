// ═══════════════════════════════════════════════════════════════
// Report PDF renderer: one lazily started, shared system browser (Edge/Chrome
// through playwright-core, no browser download), a small pool of sandboxed
// pages, bounded concurrency + queue, per-render timeout, crash recovery,
// idle shutdown and a graceful shutdown hook.
// Sandbox per page: JavaScript disabled, offline, every request except data:
// aborted, service workers blocked, CSP meta in the document itself.
// ═══════════════════════════════════════════════════════════════
import { chromium, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright-core';
import { env } from '../../config/env.js';

export type ReportPdfRendererErrorCode = 'REPORT_PDF_RENDERER_UNAVAILABLE' | 'REPORT_PDF_RENDER_TIMEOUT' | 'REPORT_PDF_RENDER_BUSY' | 'REPORT_PDF_RENDER_FAILED';

export class ReportPdfRendererError extends Error {
  constructor(readonly code: ReportPdfRendererErrorCode, message: string) {
    super(message);
    this.name = 'ReportPdfRendererError';
  }
}

export interface ReportPdfRendererConfig {
  executablePath: string | null;
  channel: string | null;
  concurrency: number;
  queueLimit: number;
  timeoutMs: number;
  idleCloseMs: number;
  maxRendersPerPage: number;
}

export interface ReportPdfRenderResult {
  pdf: Buffer;
  pageCount: number;
  /** `page-3` = page body overflow, `page-3:fit` = a fixed-size block overflowed. Must be empty. */
  overflow: string[];
  durationMs: number;
}

export interface ReportPdfRenderer {
  render(html: string, options?: { timeoutMs?: number }): Promise<ReportPdfRenderResult>;
  /** Heights in CSS px of every [data-measure] element (pagination pass). */
  measure(html: string, options?: { timeoutMs?: number }): Promise<Record<string, number>>;
  /** Screenshots every `.page` element (used for visual review samples). */
  screenshotPages(html: string, options?: { scale?: number }): Promise<Buffer[]>;
  shutdown(): Promise<void>;
  stats(): { active: number; queued: number; idlePages: number; browserRunning: boolean };
}

interface PooledPage { context: BrowserContext; page: Page; renders: number; broken: boolean }

const LAUNCH_ARGS = [
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-update',
  '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--mute-audio', '--disable-dev-shm-usage',
];

// Runs inside the page (JavaScript is disabled for page scripts, evaluate still works).
// Kept as a string so transpiler helpers can never leak into the page.
const MEASURE_LAYOUT_SCRIPT = `(() => {
  const pages = Array.from(document.querySelectorAll('.page'));
  const overflow = [];
  pages.forEach((page, index) => {
    const body = page.querySelector('.page-body');
    if (body && body.scrollHeight - body.clientHeight > 1) overflow.push('page-' + (index + 1));
    page.querySelectorAll('[data-fit]').forEach((block) => {
      if (block.scrollHeight - block.clientHeight > 1 || block.scrollWidth - block.clientWidth > 1) overflow.push('page-' + (index + 1) + ':fit');
    });
  });
  return { pageCount: pages.length, overflow: Array.from(new Set(overflow)) };
})()`;
const FONTS_READY_SCRIPT = 'document.fonts.ready.then(() => true)';
const MEASURE_ELEMENTS_SCRIPT = `(() => {
  const result = {};
  document.querySelectorAll('[data-measure]').forEach((element) => {
    result[element.getAttribute('data-measure')] = element.getBoundingClientRect().height;
  });
  return result;
})()`;

const shuttingDown = () => new ReportPdfRendererError('REPORT_PDF_RENDERER_UNAVAILABLE', 'Report PDF renderer is shutting down.');
const firstLine = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error));

/** Bounded concurrency with a bounded, deadline-aware wait queue. */
class RenderSlots {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void; reject: (error: Error) => void }> = [];

  constructor(private readonly concurrency: number, private readonly queueLimit: number) {}

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.waiters.length; }

  acquire(deadline: number): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.queueLimit) return Promise.reject(new ReportPdfRendererError('REPORT_PDF_RENDER_BUSY', 'Report PDF renderer queue is full.'));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => { clearTimeout(timer); this.active += 1; resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new ReportPdfRendererError('REPORT_PDF_RENDER_BUSY', 'Timed out waiting for a free report PDF renderer.'));
      }, Math.max(0, deadline - Date.now()));
      this.waiters.push(waiter);
    });
  }

  /** Returns true when the renderer became fully idle. */
  release(): boolean {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next.grant();
    return !next && this.active === 0;
  }

  rejectAll(error: Error): void {
    this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
  }
}

/** One lazily launched browser; sandboxed contexts/pages are pooled and recycled. */
class BrowserPagePool {
  private browserPromise: Promise<Browser> | null = null;
  private readonly idle: PooledPage[] = [];
  closing = false;

  constructor(private readonly config: ReportPdfRendererConfig, private readonly launcher: Pick<BrowserType, 'launch'>) {}

  get running(): boolean { return this.browserPromise !== null; }
  get idleCount(): number { return this.idle.length; }

  private reset(): void {
    this.browserPromise = null;
    this.idle.length = 0;
  }

  private launch(): Promise<Browser> {
    if (this.closing) return Promise.reject(shuttingDown());
    if (!this.browserPromise) {
      const promise = this.launcher.launch({
        headless: true,
        ...(this.config.executablePath ? { executablePath: this.config.executablePath } : { channel: this.config.channel ?? 'msedge' }),
        args: LAUNCH_ARGS,
        timeout: 20_000,
      }).then((browser) => {
        // Crash recovery: a disconnected browser is forgotten and relaunched on the next render.
        browser.on('disconnected', () => { if (this.browserPromise === promise) this.reset(); });
        return browser;
      }).catch((error: unknown) => {
        if (this.browserPromise === promise) this.browserPromise = null;
        throw new ReportPdfRendererError('REPORT_PDF_RENDERER_UNAVAILABLE', `Report PDF browser could not be started: ${firstLine(error)}`);
      });
      this.browserPromise = promise;
    }
    return this.browserPromise;
  }

  private async create(scale: number): Promise<PooledPage> {
    const browser = await this.launch();
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 794, height: 1123 },
      deviceScaleFactor: scale,
    });
    await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort('blockedbyclient')));
    const page = await context.newPage();
    const pooled: PooledPage = { context, page, renders: 0, broken: false };
    page.on('crash', () => { pooled.broken = true; });
    return pooled;
  }

  async take(scale: number): Promise<PooledPage> {
    return scale === 1 ? this.idle.pop() ?? this.create(1) : this.create(scale);
  }

  async give(pooled: PooledPage, reusable: boolean): Promise<void> {
    if (reusable && !this.closing) {
      try {
        await pooled.page.goto('about:blank', { timeout: 5_000 });
        this.idle.push(pooled);
        return;
      } catch {
        // fall through: discard the page
      }
    }
    await pooled.context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const current = this.browserPromise;
    this.reset();
    if (current) await current.then((browser) => browser.close()).catch(() => undefined);
  }
}

class PooledReportPdfRenderer implements ReportPdfRenderer {
  private readonly slots: RenderSlots;
  private readonly pool: BrowserPagePool;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ReportPdfRendererConfig, launcher: Pick<BrowserType, 'launch'>) {
    this.slots = new RenderSlots(config.concurrency, config.queueLimit);
    this.pool = new BrowserPagePool(config, launcher);
  }

  private scheduleIdleClose(): void {
    if (this.config.idleCloseMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.slots.activeCount === 0) void this.pool.close();
    }, this.config.idleCloseMs);
    this.idleTimer.unref();
  }

  private async withPage<T>(timeoutMs: number, scale: number, work: (page: Page, remainingMs: number) => Promise<T>): Promise<T> {
    if (this.pool.closing) throw shuttingDown();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const deadline = Date.now() + timeoutMs;
    await this.slots.acquire(deadline);
    let pooled: PooledPage | null = null;
    let reusable = false;
    let timer: NodeJS.Timeout | null = null;
    try {
      pooled = await this.pool.take(scale);
      const target = pooled;
      const remaining = Math.max(1_000, deadline - Date.now());
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReportPdfRendererError('REPORT_PDF_RENDER_TIMEOUT', `Report PDF rendering exceeded ${timeoutMs} ms.`)), remaining);
      });
      const result = await Promise.race([work(target.page, remaining), timeout]);
      target.renders += 1;
      reusable = scale === 1 && !target.broken && target.renders < this.config.maxRendersPerPage;
      return result;
    } catch (error) {
      if (error instanceof ReportPdfRendererError) throw error;
      throw new ReportPdfRendererError('REPORT_PDF_RENDER_FAILED', `Report PDF rendering failed: ${firstLine(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (pooled) await this.pool.give(pooled, reusable);
      if (this.slots.release()) this.scheduleIdleClose();
    }
  }

  private async load(page: Page, html: string, remainingMs: number): Promise<void> {
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load', timeout: remainingMs });
    await page.evaluate(FONTS_READY_SCRIPT);
  }

  render(html: string, options: { timeoutMs?: number } = {}): Promise<ReportPdfRenderResult> {
    const started = Date.now();
    return this.withPage(options.timeoutMs ?? this.config.timeoutMs, 1, async (page, remainingMs) => {
      await this.load(page, html, remainingMs);
      const layout = await page.evaluate<{ pageCount: number; overflow: string[] }>(MEASURE_LAYOUT_SCRIPT);
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, tagged: true, outline: false });
      return { pdf, pageCount: layout.pageCount, overflow: layout.overflow, durationMs: Date.now() - started };
    });
  }

  measure(html: string, options: { timeoutMs?: number } = {}): Promise<Record<string, number>> {
    return this.withPage(options.timeoutMs ?? this.config.timeoutMs, 1, async (page, remainingMs) => {
      await this.load(page, html, remainingMs);
      return page.evaluate<Record<string, number>>(MEASURE_ELEMENTS_SCRIPT);
    });
  }

  screenshotPages(html: string, options: { scale?: number } = {}): Promise<Buffer[]> {
    return this.withPage(this.config.timeoutMs * 2, options.scale ?? 2, async (page, remainingMs) => {
      await this.load(page, html, remainingMs);
      const shots: Buffer[] = [];
      for (const element of await page.$$('.page')) shots.push(await element.screenshot({ type: 'png' }));
      return shots;
    });
  }

  async shutdown(): Promise<void> {
    this.pool.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.slots.rejectAll(shuttingDown());
    await this.pool.close();
  }

  stats(): ReturnType<ReportPdfRenderer['stats']> {
    return { active: this.slots.activeCount, queued: this.slots.queuedCount, idlePages: this.pool.idleCount, browserRunning: this.pool.running };
  }
}

export function createReportPdfRenderer(config: ReportPdfRendererConfig, launcher: Pick<BrowserType, 'launch'> = chromium): ReportPdfRenderer {
  return new PooledReportPdfRenderer(config, launcher);
}

export function getReportPdfRendererConfigFromEnv(): ReportPdfRendererConfig {
  return {
    executablePath: env.REPORT_PDF_BROWSER_PATH || null,
    channel: env.REPORT_PDF_BROWSER_CHANNEL,
    concurrency: env.REPORT_PDF_RENDER_CONCURRENCY,
    queueLimit: env.REPORT_PDF_RENDER_QUEUE_LIMIT,
    timeoutMs: env.REPORT_PDF_RENDER_TIMEOUT_MS,
    idleCloseMs: env.REPORT_PDF_BROWSER_IDLE_CLOSE_MS,
    maxRendersPerPage: 50,
  };
}

let sharedRenderer: ReportPdfRenderer | null = null;

/** Process-wide renderer, created lazily on the first export. */
export function getReportPdfRenderer(): ReportPdfRenderer {
  sharedRenderer ??= createReportPdfRenderer(getReportPdfRendererConfigFromEnv());
  return sharedRenderer;
}

/** Graceful shutdown hook (index.ts). Safe to call when nothing was started. */
export async function shutdownReportPdfRenderer(): Promise<void> {
  const renderer = sharedRenderer;
  sharedRenderer = null;
  if (renderer) await renderer.shutdown();
}
