// One tenant admin (lt-admin-NN, role superuser) keeping the dashboard report page open
// (landa-dashboard src/pages/report-summary.tsx + components/reports/*: same endpoints and query parameters).
import { LOADTEST_TENANT, adminUsername } from './config.mjs';
import { ApiSession, StopError, createRng, sleep } from './session.mjs';
import { vnDate } from './learner.mjs';

const DAY_MS = 86_400_000;

function reportRanges(days) {
  const now = Date.now();
  const to = vnDate(new Date(now));
  const from = vnDate(new Date(now - (days - 1) * DAY_MS));
  const prevTo = vnDate(new Date(now - days * DAY_MS));
  const prevFrom = vnDate(new Date(now - (2 * days - 1) * DAY_MS));
  return { from, to, prevFrom, prevTo };
}

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();

export async function runAdmin({ index, options, transport, recorder, password, stop }) {
  const rng = createRng((options.seed * 7_919 + 50_000 + index) >>> 0);
  const username = adminUsername(index);
  const session = new ApiSession({
    transport, recorder, options, username, password, rng, signal: stop,
    clientApp: 'admin', origin: LOADTEST_TENANT.adminOrigin, label: `admin ${username}`,
  });
  const get = (name, path, opts) => session.request(name, 'GET', path, opts);
  const sessionEnd = new AbortController();
  let refresher;

  recorder.vuStarted();
  try {
    const login = await session.login();
    if (!login.ok) return;
    await get('GET /api/auth/me (admin)', '/api/auth/me');
    refresher = (async () => {
      while (await sleep(session.nextRefreshDelayMs(), sessionEnd.signal)) {
        if (!(await session.refresh('scheduled_admin'))) break;
      }
    })();

    for (let cycle = 1; !stop.aborted && !session.loggedOut && (!options.adminMaxCycles || cycle <= options.adminMaxCycles); cycle += 1) {
      const r = reportRanges(options.reportDays);
      await Promise.all([
        get('GET /api/reports/groups', '/api/reports/groups'),
        get('GET /api/reports/summary', `/api/reports/summary?${qs({ date_from: r.from, date_to: r.to })}`),
        get('GET /api/reports/summary (previous period)', `/api/reports/summary?${qs({ date_from: r.prevFrom, date_to: r.prevTo })}`),
        get('GET /api/reports/chart', `/api/reports/chart?${qs({
          date_from: r.from, date_to: r.to, metric: 'total_enrollments', group_by_org: 'true', granularity: 'auto',
          mode: 'window', direction: 'initial', limit_buckets: 72, series_limit: 8,
        })}`),
        get('GET /api/reports/course-completion-ranking', `/api/reports/course-completion-ranking?${qs({ date_from: r.from, date_to: r.to, page: 1, page_size: 5 })}`),
        get('GET /api/reports/learners', `/api/reports/learners?${qs({ date_from: r.from, date_to: r.to, page: 1, page_size: 5, search: '', status: 'all' })}`),
      ]);
      recorder.count('admin_report_loads');
      if (options.adminExportEvery > 0 && cycle % options.adminExportEvery === 0) {
        const res = await get('GET /api/reports/export.xlsx', `/api/reports/export.xlsx?${qs({ date_from: r.from, date_to: r.to, locale: 'vi' })}`, { raw: true, timeout: 120_000 });
        if (res.status === 200) recorder.count('admin_exports', 1);
      }
      if (!(await sleep(options.adminIntervalS * 1000 * (0.8 + 0.4 * rng.next()), stop))) break;
    }
  } catch (err) {
    if (err instanceof StopError) throw err;
    recorder.count('admin_crashed');
    if (!options.quiet) console.error(`[${username}] ${err?.stack || err}`);
  } finally {
    sessionEnd.abort();
    await refresher;
    if (session.accessToken && options.logout) await session.logout();
    recorder.vuEnded();
    recorder.count('admins_finished');
  }
}
