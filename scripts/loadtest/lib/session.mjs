// One signed-in browser tab of the learner app or the dashboard: same headers, token rotation and 429 retry rule.
import { performance } from 'node:perf_hooks';
import { LOADTEST_TENANT } from './config.mjs';

/** Endpoints the apps never answer a 401 on with a refresh (fe-5173 src/api/client.ts). */
const NO_REFRESH_ON_401 = /^\/api\/(auth\/(login|refresh|logout)|sso\/|branding\/|demo-login\/)/;

export class StopError extends Error {}

/** Abortable sleep: resolves early (false) when the signal fires. */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Deterministic PRNG (mulberry32) so two runs with the same --seed make the same choices. */
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
  };
}

export class ApiSession {
  constructor({ transport, recorder, options, username, password, clientApp, origin, rng, signal, forwardedFor, label }) {
    Object.assign(this, { transport, recorder, options, username, password, clientApp, origin, rng, signal, forwardedFor });
    this.label = label;
    this.accessToken = null;
    this.refreshToken = null;
    this.tenantId = null;
    this.expiresInS = null;
    this.tenantModules = [];
    this.refreshing = null;
    this.loggedOut = false;
    this.lastRefreshAt = 0;
    this.inFlight = 0;
    this.waiting = [];
  }

  /** The app's apiClient keeps at most 6 requests in flight per tab and queues the rest (fe-5173 src/api/client.ts). */
  async acquire() {
    if (this.inFlight < 6) { this.inFlight += 1; return; }
    await new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next(); else this.inFlight -= 1;
  }

  headers({ auth, json, sendOrigin }) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': `landa-loadtest/1 (${this.label})`,
      'X-UI-Locale': 'vi',
    };
    if (json) headers['Content-Type'] = 'application/json';
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (sendOrigin) headers.Origin = this.origin;
    if (this.forwardedFor) headers['X-Forwarded-For'] = this.forwardedFor;
    return headers;
  }

  /**
   * One app request with the app's retry rules: a 429 is retried at most twice (Retry-After honoured when
   * <= 10 s, else full-jitter backoff), a 401 triggers one refresh and one replay, and `queryRetries` (React Query
   * queries of the app) retries a network error / timeout / 408 / 5xx after 1 s, 2 s. Every attempt is recorded.
   */
  async request(name, method, path, { body, auth = true, timeout, raw = false, queryRetries = 0, apiClient = true } = {}) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let refreshed = false;
    let queryRetry = 0;
    for (let attempt = 1; ; attempt += 1) {
      if (apiClient) await this.acquire();
      const started = performance.now();
      const res = await this.transport.request({
        method,
        path,
        headers: { ...this.headers({ auth, json: payload !== undefined, sendOrigin: method !== 'GET' }), ...(payload ? { 'Content-Length': String(payload.length) } : {}) },
        body: payload,
        timeout: timeout ?? this.options.timeoutMs,
      });
      this.recorder.record(name, res.status, performance.now() - started, res.errorCode);
      if (apiClient) this.release();
      let json = null;
      if (!raw && res.body?.length) {
        try { json = JSON.parse(res.body.toString('utf8')); } catch { json = null; }
      }
      if (res.status === 429 && attempt < 3) {
        this.recorder.count('retries_429');
        const retryAfter = Number(res.headers?.['retry-after']);
        let waitMs;
        if (Number.isFinite(retryAfter) && retryAfter >= 0) {
          if (retryAfter > 10) return { status: res.status, json, headers: res.headers, body: res.body };
          waitMs = retryAfter * 1000 + this.rng.between(0, 1000);
        } else {
          waitMs = this.rng.next() * Math.min(10_000, 1000 * 2 ** (attempt - 1));
        }
        if (!(await sleep(waitMs, this.signal))) return { status: res.status, json, headers: res.headers, body: res.body };
        continue;
      }
      if ((res.status === 0 || res.status === 408 || res.status >= 500) && queryRetry < queryRetries) {
        this.recorder.count('retries_query');
        const waitMs = Math.min(30_000, 1000 * 2 ** queryRetry) * this.options.appDelayScale;
        queryRetry += 1;
        if (!(await sleep(waitMs, this.signal))) return { status: res.status, json, headers: res.headers, body: res.body };
        continue;
      }
      if (res.status === 401 && auth && !refreshed && !NO_REFRESH_ON_401.test(path) && json?.error !== 'account_disabled') {
        refreshed = true;
        this.recorder.count('refresh_on_401');
        if (await this.refresh('401')) continue;
      }
      return { status: res.status, json, headers: res.headers, body: res.body };
    }
  }

  async login() {
    const res = await this.request(`POST /api/auth/login (${this.clientApp})`, 'POST', '/api/auth/login', {
      auth: false,
      body: { username: this.username, password: this.password, client_app: this.clientApp, origin: this.origin },
    });
    const data = res.json?.data;
    if (res.status !== 200 || !data?.access_token) {
      this.recorder.count(`login_failed_${res.status}`);
      return { ok: false, status: res.status, code: res.json?.code };
    }
    if (data.user?.tenant_id !== LOADTEST_TENANT.id) {
      throw new StopError(`SAFETY STOP: ${this.username} signed in to tenant ${data.user?.tenant_id}, not the load-test tenant ${LOADTEST_TENANT.id}`);
    }
    this.adopt(data);
    this.recorder.count(`logins_${this.clientApp}`);
    return { ok: true, data };
  }

  adopt(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.tenantId = data.user?.tenant_id ?? this.tenantId;
    this.expiresInS = Number(data.expires_in) || this.expiresInS || 900;
    if (Array.isArray(data.tenant_modules)) this.tenantModules = data.tenant_modules.map((m) => (typeof m === 'string' ? m : m?.code)).filter(Boolean);
    this.lastRefreshAt = Date.now();
  }

  /** Delay until the app's scheduled refresh: expires_in - 300 s (min 5 s, the app's cooldown), or --refresh-interval-s. */
  nextRefreshDelayMs() {
    if (this.options.refreshIntervalS > 0) return this.options.refreshIntervalS * 1000;
    return Math.max(5000, this.expiresInS * 1000 - 300_000);
  }

  /** Rotating refresh, one at a time per tab (the server treats a reused refresh token as theft). */
  refresh(reason) {
    if (this.loggedOut || !this.refreshToken) return Promise.resolve(false);
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const delays = [1000, 3000];
      for (let attempt = 0; ; attempt += 1) {
        const res = await this.request('POST /api/auth/refresh', 'POST', '/api/auth/refresh', {
          auth: false,
          apiClient: false,
          body: this.tenantId ? { refresh_token: this.refreshToken, tenant_id: this.tenantId } : { refresh_token: this.refreshToken },
        });
        if (res.status === 200 && res.json?.data?.access_token) {
          this.adopt(res.json.data);
          this.recorder.count(`refreshes_${reason}`);
          return true;
        }
        const transient = res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500;
        if (!transient) {
          this.recorder.count(`refresh_refused_${res.status}`);
          this.loggedOut = true;
          return false;
        }
        const wait = attempt < delays.length ? delays[attempt] : 30_000;
        if (!(await sleep(wait, this.signal))) return false;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async logout() {
    if (this.loggedOut || !this.refreshToken) return;
    await this.request('POST /api/auth/logout', 'POST', '/api/auth/logout', { body: { refresh_token: this.refreshToken } });
    this.loggedOut = true;
    this.recorder.count(`logouts_${this.clientApp}`);
  }
}
