#!/usr/bin/env node
// Load test "deadline morning" for the local tenant "Thử tải" (see scripts/loadtest/README.md). LOCAL ONLY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KIT_DIR, LOADTEST_TENANT, USAGE, assertSafeTarget, learnerUsername, loadPassword, parseArgs, publicOptions, scaledRange, validateOptions,
  withDefaults,
} from './lib/config.mjs';
import { createHttpTransport, createInProcessTransport } from './lib/http.mjs';
import { Recorder, round } from './lib/stats.mjs';
import { ApiSession, StopError, createRng, sleep } from './lib/session.mjs';
import { runLearner } from './lib/learner.mjs';
import { runAdmin } from './lib/admin.mjs';
import { MetricsSampler, PgSampler, healthLoop } from './lib/samplers.mjs';
import { createStub } from './lib/stub.mjs';

/** Checks that the target is the local API with the seeded tenant, before any load. Throws on any mismatch. */
async function preflight({ transport, options, password }) {
  const recorder = new Recorder();
  const checks = [];
  const health = await transport.request({ method: 'GET', path: '/api/health', headers: { Accept: 'application/json' }, timeout: 5000 });
  checks.push({ check: 'GET /api/health', status: health.status });
  if (health.status !== 200) throw new Error(`Preflight: GET /api/health answered ${health.status || health.errorCode}; is the API running at the target?`);

  const branding = await transport.request({ method: 'GET', path: `/api/branding/by-domain/${LOADTEST_TENANT.hostname}`, headers: { Accept: 'application/json' }, timeout: 10_000 });
  let brandingTenant = null;
  try { brandingTenant = JSON.parse(branding.body.toString('utf8'))?.data?.tenant_id ?? null; } catch { brandingTenant = null; }
  checks.push({ check: `GET /api/branding/by-domain/${LOADTEST_TENANT.hostname}`, status: branding.status, tenant_id: brandingTenant });
  if (brandingTenant !== LOADTEST_TENANT.id) {
    throw new Error(`Preflight: ${LOADTEST_TENANT.hostname} resolves to tenant ${brandingTenant} instead of ${LOADTEST_TENANT.id}. `
      + 'Apply the seed (20261018_1200_loadtest_seed_tenant.sql) first, or wait up to 5 min for the branding cache.');
  }

  const stop = new AbortController();
  const session = new ApiSession({
    transport, recorder, options, username: learnerUsername(options.startIndex), password, clientApp: 'learner',
    origin: LOADTEST_TENANT.learnerOrigin, rng: createRng(1), signal: stop.signal, label: 'preflight',
  });
  const login = await session.login();
  checks.push({ check: `POST /api/auth/login ${session.username}`, status: login.ok ? 200 : login.status, code: login.code });
  if (!login.ok) {
    throw new Error(`Preflight: sign-in of ${session.username} failed (${login.status} ${login.code || ''}). Check the credentials file matches the seeded hash.`);
  }
  const me = await session.request('GET /api/auth/me', 'GET', '/api/auth/me');
  checks.push({ check: 'GET /api/auth/me', status: me.status });
  if (me.status !== 200) {
    throw new Error(`Preflight: GET /api/auth/me answered ${me.status} (${me.json?.message || ''}). A 403 here usually means RUNTIME_TENANT_ALLOWLIST/DENYLIST excludes the load-test tenant.`);
  }
  await session.logout();
  return { checks, requests: recorder.live().requests + 2, tenant_id: LOADTEST_TENANT.id, modules: session.tenantModules };
}

function defaultOut(options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(KIT_DIR, 'results', `deadline-morning-${options.learners}l-${options.admins}a-${stamp}.json`);
}

function formatTable(endpoints) {
  const rows = Object.entries(endpoints).map(([name, e]) => [name, e.count, e.rps, e.p50, e.p95, e.p99, e.max,
    `${round(e.error_rate * 100, 2)}%`, e.statuses['429'] || 0, Object.entries(e.statuses).filter(([s]) => Number(s) >= 500).reduce((a, [, n]) => a + n, 0),
    e.statuses['0'] || 0]);
  const header = ['endpoint', 'count', 'rps', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'errors', '429', '5xx', 'net'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '-').length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? String(c ?? '-').padEnd(widths[i]) : String(c ?? '-').padStart(widths[i]))).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function printSummary(result, out = console.log) {
  out(`\n== ${result.scenario}: ${result.options.learners} learners + ${result.options.admins} admins, ${result.duration_s} s, label "${result.label || ''}"`);
  out(formatTable(result.endpoints));
  const t = result.totals;
  out(`\nTOTAL ${t.requests} requests, ${t.rps} req/s, p50 ${t.p50} ms, p95 ${t.p95} ms, p99 ${t.p99} ms, errors ${round(t.error_rate * 100, 2)}% `
    + `(${Object.entries(t.by_class).map(([k, v]) => `${k}=${v}`).join(' ')}), peak VUs ${t.peak_vus}`);
  out(`flow: ${Object.entries(result.flow).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const pg = result.pg;
  if (pg?.summary) {
    out(`postgres (every ${pg.interval_s} s, ${pg.samples_taken} samples): connections max ${pg.summary.connections_max}/${pg.summary.max_connections_setting}, `
      + `active max ${pg.summary.active_max} avg ${pg.summary.active_avg}, lock waits max ${pg.summary.lock_waits_max} (advisory ${pg.summary.advisory_waits_max}, `
      + `row ${pg.summary.row_lock_waits_max}) in ${pg.summary.samples_with_lock_waits} samples, longest lock wait ${pg.summary.longest_lock_wait_s} s`);
    if (pg.db_delta) out(`postgres deltas: commits ${pg.db_delta.xact_commit}, rollbacks ${pg.db_delta.xact_rollback}, deadlocks ${pg.db_delta.deadlocks}, temp bytes ${pg.db_delta.temp_bytes}`);
    for (const w of pg.top_lock_waits.slice(0, 3)) out(`  lock wait seen ${w.seen}x: ${w.wait}`);
  } else {
    out(`postgres sampling: ${pg?.error || 'not available'}`);
  }
  out(`metrics endpoint ${result.metrics.path}: ${result.metrics.status}${result.metrics.probe_status !== null ? ` (probe ${result.metrics.probe_status})` : ''}`);
  const h = result.probes['probe GET /api/health'];
  if (h) out(`health probe: ${h.count} probes, p50 ${h.p50} ms, p95 ${h.p95} ms, max ${h.max} ms, errors ${round(h.error_rate * 100, 2)}%`);
  out(`load generator event-loop delay p99 ${result.load_generator.event_loop_delay_ms.p99} ms (max ${result.load_generator.event_loop_delay_ms.max} ms)`);
  if (result.safety_stop) out(`SAFETY STOP: ${result.safety_stop}`);
  if (result.out) out(`result: ${result.out}`);
}

/**
 * Runs the scenario. `hooks` (tests / dry-run): transport, password, pgContainer, write=false, log.
 */
export async function runDeadlineMorning(rawOptions, hooks = {}) {
  const options = validateOptions(withDefaults(rawOptions));
  const log = hooks.log ?? ((line) => { if (!options.quiet) console.log(line); });
  const target = hooks.transport ? { origin: hooks.transport.origin, port: null, live: false } : assertSafeTarget(options.target, options.confirmLocalApi);
  const password = hooks.password ?? loadPassword(options.credentialsFile);
  const transport = hooks.transport ?? createHttpTransport({ origin: target.origin, maxSockets: options.maxSockets, timeoutMs: options.timeoutMs });
  const stop = new AbortController();
  const onSignal = () => { log('stop requested: learners finish their current request and sign out'); stop.abort(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    log(`preflight against ${target.origin} ...`);
    const pre = await preflight({ transport, options, password });
    hooks.onPhase?.('preflight done');
    log(`preflight ok: ${pre.checks.map((c) => `${c.check} ${c.status}`).join(', ')}`);

    const recorder = new Recorder();
    const probes = new Recorder();
    const t0 = recorder.startedAt;
    const samplersStop = new AbortController();
    const pg = new PgSampler({ container: hooks.pgContainer ?? options.pgContainer, intervalS: options.pgIntervalS, quiet: options.quiet });
    await pg.start();
    log(`postgres sampler: ${pg.available ? `on (${pg.container}, every ${options.pgIntervalS} s, read-only)` : pg.error}`);
    const metrics = new MetricsSampler({ transport, path: options.metricsPath, intervalS: options.metricsIntervalS });
    await metrics.start(t0);
    log(`metrics endpoint ${options.metricsPath}: ${metrics.status}`);
    const loops = [pg.loop(samplersStop.signal, t0), metrics.loop(samplersStop.signal, t0),
      healthLoop({ transport, intervalS: options.healthIntervalS, signal: samplersStop.signal, recorder: probes })];

    const hardStop = setTimeout(() => { log(`duration ${options.durationS} s reached: stopping`); stop.abort(); }, options.durationS * 1000);
    const progress = setInterval(() => {
      const s = recorder.live();
      const last = pg.samples[pg.samples.length - 1];
      log(`t=${Math.round((Date.now() - t0) / 1000)}s vus=${recorder.activeVus} req=${s.requests} (${s.window_rps}/s, p95 ${s.window_p95_ms} ms in the last 10 s) `
        + `errors=${round(s.error_rate * 100, 2)}% ${JSON.stringify(s.classes)}${last ? ` pg active=${last.active} lock_waits=${last.lock_waits}` : ''}`);
    }, 10_000);

    let safetyStop = null;
    const guard = (promise) => promise.catch((err) => {
      if (err instanceof StopError) { safetyStop = err.message; log(err.message); stop.abort(); return; }
      throw err;
    });
    const tasks = [];
    const rampMs = options.rampS * 1000;
    for (let i = 0; i < options.learners; i += 1) {
      const index = options.startIndex + i;
      const startAt = options.learners > 1 ? (i / (options.learners - 1)) * rampMs : 0;
      tasks.push(guard((async () => {
        if (!(await sleep(startAt, stop.signal))) return;
        await runLearner({ index, options, transport, recorder, password, stop: stop.signal });
      })()));
    }
    for (let a = 1; a <= options.admins; a += 1) {
      tasks.push(guard((async () => {
        if (!(await sleep((a - 1) * 2000, stop.signal))) return;
        await runAdmin({ index: a, options, transport, recorder, password, stop: stop.signal });
      })()));
    }
    // Admins run until the learners are done (or the hard stop / --admin-max-cycles); admins alone run until then.
    if (options.learners > 0) {
      await Promise.all(tasks.slice(0, options.learners));
      if (options.admins && !stop.aborted) stop.abort();
    }
    await Promise.all(tasks);
    clearTimeout(hardStop);
    clearInterval(progress);
    samplersStop.abort();
    await Promise.all(loops);
    await pg.stop();

    const summary = recorder.summary();
    const result = {
      kit: 'landa-backend/scripts/loadtest',
      scenario: 'deadline-morning',
      label: options.label,
      host: os.hostname(),
      node: process.version,
      target: target.origin,
      tenant: { id: LOADTEST_TENANT.id, slug: LOADTEST_TENANT.slug, course_id: LOADTEST_TENANT.courseId },
      options: publicOptions(options),
      think_ms_scaled: Object.fromEntries(Object.keys(options.think).map((k) => [k, scaledRange(options, k).map((v) => Math.round(v))])),
      preflight: pre,
      ...summary,
      probes: probes.summary().endpoints,
      pg: pg.result(),
      metrics: metrics.result(),
      safety_stop: safetyStop,
    };
    if (hooks.write !== false) {
      const out = options.out || defaultOut(options);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(result, null, 2));
      result.out = out;
    }
    return result;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!hooks.transport) transport.close();
  }
}

/** --dry-run: no network. Shows the plan and replays learner lt-<start> (and one admin) against the in-process stub. */
export async function dryRun(rawOptions, out = console.log) {
  const options = validateOptions(withDefaults(rawOptions));
  let targetNote;
  try { const t = assertSafeTarget(options.target, options.confirmLocalApi); targetNote = `${t.origin} (loopback ok${t.live ? ', live local app port, --confirm-local-api given' : ''})`; } catch (err) { targetNote = `REFUSED: ${err.message}`; }
  let credentialsNote;
  try { loadPassword(options.credentialsFile); credentialsNote = `present (${path.basename(options.credentialsFile)})`; } catch (err) { credentialsNote = `MISSING: ${err.message}`; }
  out('== dry run (no request leaves this process)');
  out(`target:        ${targetNote}`);
  out(`credentials:   ${credentialsNote}`);
  out(`tenant:        ${LOADTEST_TENANT.slug} ${LOADTEST_TENANT.id}, learner origin ${LOADTEST_TENANT.learnerOrigin}, admin origin ${LOADTEST_TENANT.adminOrigin}`);
  out(`learners:      ${options.learners} (${learnerUsername(options.startIndex)} .. ${learnerUsername(options.startIndex + Math.max(0, options.learners - 1))}), `
    + `ramp ${options.rampS} s (${options.rampS ? round(options.learners / options.rampS, 2) : options.learners} sign-ins/s), hard stop ${options.durationS} s`);
  out(`admins:        ${options.admins} on the report page every ~${options.adminIntervalS} s, export every ${options.adminExportEvery || 'never'}`);
  out(`think (ms):    ${Object.keys(options.think).map((k) => `${k} ${scaledRange(options, k).map((v) => Math.round(v)).join('-')}`).join(', ')}`);
  out(`background:    unread-count every ${options.notificationPollS} s, study sync every ${options.studySyncS} s, token refresh ${options.refreshIntervalS ? `every ${options.refreshIntervalS} s` : 'at expires_in - 300 s'}`);
  out(`samplers:      pg_stat_activity ${options.pgContainer === 'none' ? 'off' : `${options.pgContainer} every ${options.pgIntervalS} s (read-only)`}, metrics ${options.metricsPath}, health every ${options.healthIntervalS} s`);

  const stub = createStub({ password: 'dry-run', accessTtlS: 900 });
  const trace = [];
  const transport = createInProcessTransport(stub, { onRequest: (r) => trace.push(`${r.method} ${r.path}`) });
  const onPhase = (phase) => trace.push(`--- ${phase} ---`);
  const replay = { ...options, learners: 1, admins: options.admins ? 1 : 0, rampS: 0, durationS: 120, thinkScale: 0, appDelayScale: 0,
    adminIntervalS: 0, adminMaxCycles: 1, adminExportEvery: options.adminExportEvery ? 1 : 0, notificationPollS: 0, studySyncS: 0,
    healthIntervalS: 0, pgContainer: 'none', metricsPath: 'none', quiet: true };
  const result = await runDeadlineMorning(replay, { transport, password: 'dry-run', pgContainer: 'none', write: false, log: () => {}, onPhase });

  // Rough steady-state rate: foreground requests of one learner spread over its mean session, plus background timers.
  const perLearner = Object.entries(result.endpoints).filter(([n]) => !/reports|\(admin\)/.test(n)).reduce((a, [, e]) => a + e.count, 0);
  const mean = (k) => scaledRange(options, k).reduce((a, b) => a + b, 0) / 2;
  const sessionS = (mean('loginPage') + mean('dashboard') + 2 * mean('modal') + mean('linger')
    + options.unitsPerSession * (mean('unitRead') + mean('quizAnswer') + mean('betweenUnits') + 0.4 * mean('quizRetry'))) / 1000;
  const backgroundRps = (options.notificationPollS ? 1 / options.notificationPollS : 0) + (options.studySyncS ? 1 / options.studySyncS : 0);
  out(`estimate:      ~${perLearner} requests per learner over ~${Math.round(sessionS)} s of think time (+ background ${round(backgroundRps * 60, 2)}/min) `
    + `=> ~${round(options.learners * (perLearner / Math.max(1, sessionS) + backgroundRps), 1)} req/s while all ${options.learners} learners are active`);
  out(`\nreplay of ${learnerUsername(options.startIndex)}${replay.admins ? ' + lt-admin-01' : ''} (think times 0, no background timers): `
    + `${result.totals.requests} requests after a ${trace.indexOf('--- preflight done ---')}-request preflight`);
  const shown = 70;
  for (const line of trace.slice(0, shown)) out(`  ${line}`);
  if (trace.length > shown) out(`  ... ${trace.length - shown} more`);
  out(`\nper endpoint in the replay: ${Object.entries(result.endpoints).map(([n, e]) => `${n} x${e.count}`).join('; ')}`);
  out(`flow: ${Object.entries(result.flow).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
  out('\nNothing was sent. Real run: see scripts/loadtest/README.md (needs --confirm-local-api for ports 3101/5273/5274).');
  return { trace, result };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`${err.message}\n\n${USAGE}`); process.exit(2); }
  if (options.help) { console.log(USAGE); return; }
  try {
    if (options.dryRun) { await dryRun(options); return; }
    const result = await runDeadlineMorning(options);
    printSummary(result);
    if (result.safety_stop) process.exitCode = 3;
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
