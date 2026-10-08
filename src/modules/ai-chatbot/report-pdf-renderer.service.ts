// ═══════════════════════════════════════════════════════════════
// Report PDF renderer: one lazily started, shared system browser (Edge/Chrome
// through playwright-core, no browser download), a small pool of sandboxed
// pages, bounded concurrency + queue, per-render timeout, crash recovery,
// idle shutdown and a graceful shutdown hook.
// Nothing may wedge it: launching the browser and opening the page count
// against the render deadline, every close is bounded, and after a render
// timeout or repeated failures the browser is recycled (a browser whose close
// hangs is killed by PID). The render slot is released on every path.
// Sandbox per page: JavaScript disabled, offline, every request except data:
// aborted, service workers blocked, CSP meta in the document itself.
// ═══════════════════════════════════════════════════════════════
import { chromium, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright-core';
import { env } from '../../config/env.js';
import { ReportDeadlineError, withReportDeadline } from './report-deadline.logic.js';

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
  /** Bound on closing a page context or the browser (default 5 s); a hung browser close ends in a kill. */
  closeTimeoutMs?: number;
  /** Failed renders in a row that recycle the browser (default 3). */
  maxConsecutiveFailures?: number;
}

export interface ReportPdfRendererHooks {
  /** Hard-kills a browser process whose close() hung. */
  killProcess?: (pid: number) => void;
  log?: (event: Record<string, unknown>) => void;
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

interface PooledPage { context: BrowserContext; page: Page; renders: number; broken: boolean; generation: number }
interface LaunchedBrowser { browser: Browser; pid: number | null }

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

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

/** True when `work` settles (either way) within `timeoutMs`, false when it hangs. */
async function settlesWithin(work: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await withReportDeadline('report_pdf_close', timeoutMs, work);
    return true;
  } catch (error) {
    return !(error instanceof ReportDeadlineError);
  }
}

/** PID of the browser process (CDP), so a browser whose close() hangs can still be killed. Best effort. */
async function readBrowserPid(browser: Browser, timeoutMs: number): Promise<number | null> {
  try {
    return await withReportDeadline('report_pdf_browser_pid', timeoutMs, async () => {
      const session = await browser.newBrowserCDPSession();
      const info = await session.send('SystemInfo.getProcessInfo');
      void session.detach().catch(() => undefined);
      return info.processInfo.find((process) => process.type === 'browser')?.id ?? null;
    });
  } catch {
    return null;
  }
}

/** Rejects with REPORT_PDF_RENDER_TIMEOUT at the deadline; cancel() once the render settled. */
function renderDeadline(deadline: number, timeoutMs: number): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReportPdfRendererError('REPORT_PDF_RENDER_TIMEOUT', `Report PDF rendering exceeded ${timeoutMs} ms.`)), Math.max(0, deadline - Date.now()));
  });
  promise.catch(() => undefined);
  return { promise, cancel: () => clearTimeout(timer) };
}

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
  private browserPromise: Promise<LaunchedBrowser> | null = null;
  private readonly idle: PooledPage[] = [];
  /** Bumped whenever the browser is forgotten: pages of an older browser are never pooled again. */
  private generation = 0;
  closing = false;

  constructor(
    private readonly config: ReportPdfRendererConfig,
    private readonly launcher: Pick<BrowserType, 'launch'>,
    private readonly hooks: Required<ReportPdfRendererHooks>,
  ) {}

  get running(): boolean { return this.browserPromise !== null; }
  get idleCount(): number { return this.idle.length; }
  private get closeTimeoutMs(): number { return this.config.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS; }

  private reset(): void {
    this.browserPromise = null;
    this.idle.length = 0;
    this.generation += 1;
  }

  private launch(): Promise<LaunchedBrowser> {
    if (this.closing) return Promise.reject(shuttingDown());
    if (!this.browserPromise) {
      const promise: Promise<LaunchedBrowser> = this.launcher.launch({
        headless: true,
        ...(this.config.executablePath ? { executablePath: this.config.executablePath } : { channel: this.config.channel ?? 'msedge' }),
        args: LAUNCH_ARGS,
        timeout: 20_000,
      }).then(async (browser) => {
        // Crash recovery: a disconnected browser is forgotten and relaunched on the next render.
        browser.on('disconnected', () => { if (this.browserPromise === promise) this.reset(); });
        const launched = { browser, pid: await readBrowserPid(browser, this.closeTimeoutMs) };
        if (this.browserPromise !== promise) {
          // Recycled or shut down while starting: never keep an orphan browser.
          await this.terminate(launched, 'stale_launch');
          throw new ReportPdfRendererError('REPORT_PDF_RENDERER_UNAVAILABLE', 'Report PDF browser was recycled while starting.');
        }
        return launched;
      }).catch((error: unknown) => {
        if (this.browserPromise === promise) this.browserPromise = null;
        if (error instanceof ReportPdfRendererError) throw error;
        throw new ReportPdfRendererError('REPORT_PDF_RENDERER_UNAVAILABLE', `Report PDF browser could not be started: ${firstLine(error)}`);
      });
      this.browserPromise = promise;
    }
    return this.browserPromise;
  }

  private async create(scale: number): Promise<PooledPage> {
    const { browser } = await this.launch();
    const generation = this.generation;
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 794, height: 1123 },
      deviceScaleFactor: scale,
    });
    try {
      await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort('blockedbyclient')));
      const page = await context.newPage();
      const pooled: PooledPage = { context, page, renders: 0, broken: false, generation };
      page.on('crash', () => { pooled.broken = true; });
      return pooled;
    } catch (error) {
      void this.discard({ context });
      throw error;
    }
  }

  async take(scale: number): Promise<PooledPage> {
    return scale === 1 ? this.idle.pop() ?? this.create(1) : this.create(scale);
  }

  /** Pools the page again or closes it; false when closing it hung (the caller recycles the browser). */
  async give(pooled: PooledPage, reusable: boolean): Promise<boolean> {
    if (reusable && !this.closing && pooled.generation === this.generation) {
      try {
        await withReportDeadline('report_pdf_page_reset', this.closeTimeoutMs, () => pooled.page.goto('about:blank', { timeout: this.closeTimeoutMs }));
        this.idle.push(pooled);
        return true;
      } catch {
        // fall through: discard the page
      }
    }
    return this.discard(pooled);
  }

  /** Closes the page's context within the bound; false when the close hung. */
  discard(pooled: Pick<PooledPage, 'context'>): Promise<boolean> {
    return settlesWithin(() => pooled.context.close(), this.closeTimeoutMs);
  }

  /** Closes a browser within the bound; when close() hangs the process is killed. */
  private async terminate(launched: LaunchedBrowser, reason: string): Promise<void> {
    if (await settlesWithin(() => launched.browser.close(), this.closeTimeoutMs)) return;
    this.hooks.log({ event: 'report_pdf_browser_kill', reason, pid: launched.pid });
    if (launched.pid === null) return;
    try {
      this.hooks.killProcess(launched.pid);
    } catch {
      // already gone
    }
  }

  /** Forgets the browser now (the next render launches a fresh one) and closes or kills the old one. */
  private retire(reason: string): Promise<void> {
    const current = this.browserPromise;
    this.reset();
    // A browser still starting is terminated by launch() itself (stale_launch).
    return current ? current.then((launched) => this.terminate(launched, reason), () => undefined) : Promise.resolve();
  }

  recycle(reason: string): Promise<void> {
    this.hooks.log({ event: 'report_pdf_browser_recycled', reason });
    return this.retire(reason);
  }

  close(): Promise<void> {
    return this.retire('close');
  }
}

class PooledReportPdfRenderer implements ReportPdfRenderer {
  private readonly slots: RenderSlots;
  private readonly pool: BrowserPagePool;
  private idleTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly config: ReportPdfRendererConfig, launcher: Pick<BrowserType, 'launch'>, hooks: Required<ReportPdfRendererHooks>) {
    this.slots = new RenderSlots(config.concurrency, config.queueLimit);
    this.pool = new BrowserPagePool(config, launcher, hooks);
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
    let recycle: string | null = null;
    // A render that waited for its slot until the deadline still gets a short chance.
    const expiry = renderDeadline(Math.max(deadline, Date.now() + Math.min(1_000, timeoutMs)), timeoutMs);
    try {
      // Launching the browser and opening the context/page count against the deadline too.
      const taking = this.pool.take(scale);
      try {
        pooled = await Promise.race([taking, expiry.promise]);
      } catch (error) {
        // A page that arrives after the deadline is closed, never leaked.
        void taking.then((late) => this.pool.discard(late), () => undefined);
        throw error;
      }
      const target = pooled;
      const result = await Promise.race([work(target.page, Math.max(1_000, deadline - Date.now())), expiry.promise]);
      target.renders += 1;
      reusable = scale === 1 && !target.broken && target.renders < this.config.maxRendersPerPage;
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      const failure = error instanceof ReportPdfRendererError
        ? error
        : new ReportPdfRendererError('REPORT_PDF_RENDER_FAILED', `Report PDF rendering failed: ${firstLine(error)}`);
      if (failure.code === 'REPORT_PDF_RENDER_TIMEOUT') {
        recycle = 'render_timeout';
      } else if ((this.consecutiveFailures += 1) >= (this.config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES)) {
        recycle = 'consecutive_failures';
      }
      throw failure;
    } finally {
      expiry.cancel();
      try {
        if (recycle) {
          // The page dies with the browser; closing it first could hang on a wedged browser.
          this.consecutiveFailures = 0;
          void this.pool.recycle(recycle);
        } else if (pooled && !(await this.pool.give(pooled, reusable))) {
          void this.pool.recycle('page_close_hung');
        }
      } finally {
        if (this.slots.release()) this.scheduleIdleClose();
      }
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

const defaultRendererHooks: Required<ReportPdfRendererHooks> = {
  killProcess: (pid) => { process.kill(pid, 'SIGKILL'); },
  log: (event) => console.warn(`[ReportPdf] ${JSON.stringify(event)}`),
};

export function createReportPdfRenderer(
  config: ReportPdfRendererConfig,
  launcher: Pick<BrowserType, 'launch'> = chromium,
  hooks: ReportPdfRendererHooks = {},
): ReportPdfRenderer {
  return new PooledReportPdfRenderer(config, launcher, { ...defaultRendererHooks, ...hooks });
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
    closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
    maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
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
