// Self-test of the load-test kit against its local stub (loopback, ephemeral port). Never touches the real API or docker.
//   node --test scripts/loadtest/loadtest.selftest.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LOADTEST_TENANT, assertSafeTarget, loadPassword, parseArgs, withDefaults } from './lib/config.mjs';
import { createStub, startStubServer } from './lib/stub.mjs';
import { createInProcessTransport } from './lib/http.mjs';
import { seededCorrectChoice, unitsFromBlocks } from './lib/learner.mjs';
import { PgSampler, parseActivity, parseDbStats } from './lib/samplers.mjs';
import { dryRun, runDeadlineMorning } from './deadline-morning.mjs';
import { compareResults, renderComparison } from './compare.mjs';

const STUB_PASSWORD = 'stub-password';
const fastThink = { loginPage: [0, 5], dashboard: [0, 5], modal: [0, 5], unitRead: [5, 20], quizAnswer: [0, 5], quizRetry: [0, 5], betweenUnits: [0, 5], linger: [1500, 2000] };

test('target safety: loopback http only, live app ports need --confirm-local-api', () => {
  assert.throws(() => assertSafeTarget('http://10.1.2.3:3101', true), /not loopback/);
  assert.throws(() => assertSafeTarget('https://127.0.0.1:3101', true), /http:\/\//);
  assert.throws(() => assertSafeTarget('http://elearning.l-a.vn', true), /not loopback/);
  assert.throws(() => assertSafeTarget('http://127.0.0.1:3101/api', true), /origin only/);
  for (const port of [3101, 5273, 5274]) assert.throws(() => assertSafeTarget(`http://127.0.0.1:${port}`, false), /--confirm-local-api/);
  assert.equal(assertSafeTarget('http://127.0.0.1:3101', true).live, true);
  assert.equal(assertSafeTarget('http://localhost:3999', false).live, false);
});

test('options: parsing, booleans, validation limits', () => {
  const o = parseArgs(['--learners', '50', '--no-logout', '--think-scale=0.5', '--pg-container', 'none', '--confirm-local-api']);
  assert.equal(o.learners, 50);
  assert.equal(o.logout, false);
  assert.equal(o.thinkScale, 0.5);
  assert.equal(o.pgContainer, 'none');
  assert.equal(o.confirmLocalApi, true);
  assert.throws(() => parseArgs(['--learnrs', '5']), /Unknown option/);
  assert.deepEqual(withDefaults({ think: { linger: [1, 2] } }).think.unitRead, parseArgs([]).think.unitRead);
});

test('password: env var wins, file line parsed, never empty', () => {
  const file = path.join(os.tmpdir(), `lt-cred-${process.pid}.local`);
  fs.writeFileSync(file, '# comment\nLOADTEST_PASSWORD=from-file\n');
  const saved = process.env.LOADTEST_PASSWORD;
  try {
    delete process.env.LOADTEST_PASSWORD;
    assert.equal(loadPassword(file), 'from-file');
    process.env.LOADTEST_PASSWORD = 'from-env';
    assert.equal(loadPassword(file), 'from-env');
    delete process.env.LOADTEST_PASSWORD;
    fs.writeFileSync(file, 'nothing here\n');
    assert.throws(() => loadPassword(file), /no LOADTEST_PASSWORD/);
    assert.throws(() => loadPassword(`${file}.missing`), /missing/);
  } finally {
    if (saved === undefined) delete process.env.LOADTEST_PASSWORD; else process.env.LOADTEST_PASSWORD = saved;
    fs.rmSync(file, { force: true });
  }
});

test('course tree: 36 units in order, seeded answer rule matches the course layout', () => {
  const stub = createStub();
  const units = unitsFromBlocks({ root_id: stub.course.root.id, blocks: stub.course.blocks.map((b) => ({ ...b, completed: false })) });
  assert.equal(units.length, 36);
  assert.equal(new Set(units.map((u) => u.lessonId)).size, 12);
  for (const unit of units) {
    const quiz = unit.leaves.find((l) => l.block_type === 'problem');
    assert.equal(stub.course.correct.get(quiz.id), seededCorrectChoice(unit.position));
    assert.deepEqual(unit.leaves.map((l) => l.block_type), ['html', 'problem']);
  }
});

test('postgres sampler: output parsers and disabled mode', async () => {
  const sample = parseActivity(['A\t1760000000\t25\t7\t15\t1\t3\t2\t1\t0\t0.512\t0.204', 'W\tadvisory\t0.204\tINSERT INTO block_completions ($1, $2)']);
  assert.equal(sample.connections, 25);
  assert.equal(sample.lock_waits, 3);
  assert.equal(sample.advisory_waits, 2);
  assert.equal(sample.waits[0].wait_event, 'advisory');
  const db = parseDbStats(['D\t100\t2\t0\t5\t500\t10\t20\t3\t0\t0\t100\t12345']);
  assert.equal(db.xact_commit, 100);
  assert.equal(db.loadtest_quota_bytes, 12345);
  const pg = new PgSampler({ container: 'none', intervalS: 2 });
  assert.equal(await pg.start(), false);
  assert.match(pg.result().error, /disabled/);
});

test('dry run sends nothing and replays a full learner journey in process', async () => {
  const lines = [];
  const { trace, result } = await dryRun({ learners: 10, admins: 1, pgContainer: 'none', credentialsFile: path.join(os.tmpdir(), 'none') }, (l) => lines.push(l));
  assert.ok(lines.some((l) => l.includes('Nothing was sent')));
  assert.ok(lines.some((l) => /credentials:\s+MISSING/.test(l)));
  assert.ok(trace.includes('POST /api/auth/login'));
  assert.equal(result.flow.units_studied, 36);
  assert.equal(result.flow.courses_completed, 1);
  assert.equal(result.flow.admin_report_loads, 1);
});

test('full run over HTTP against the stub: flow, retries, refresh rotation, accounting', async () => {
  const server = await startStubServer({
    password: STUB_PASSWORD, accessTtlS: 1, fault429Rate: 0.03, fault500Rate: 0.01, retryAfterS: 0, faultAfterRequests: 10, seed: 11,
  });
  const out = path.join(os.tmpdir(), `lt-selftest-${process.pid}.json`);
  try {
    const result = await runDeadlineMorning({
      target: server.url, learners: 20, startIndex: 101, rampS: 1, durationS: 60, unitsPerSession: 6, think: fastThink,
      appDelayScale: 0.01, notificationPollS: 0.3, studySyncS: 0.5, studyFirstSyncS: 0.1, refreshIntervalS: 0.7,
      admins: 1, adminIntervalS: 0.2, adminExportEvery: 1, adminMaxCycles: 2, healthIntervalS: 0.2,
      pgContainer: 'none', metricsPath: '/internal/metrics', out, label: 'selftest', quiet: true,
    }, { password: STUB_PASSWORD, pgContainer: 'none', log: () => {} });

    const stats = server.stub.stats();
    assert.equal(result.safety_stop, null);
    assert.equal(result.flow.logins_learner, 20);
    assert.equal(result.flow.logins_admin, 1);
    assert.equal(result.flow.learners_finished, 20);
    assert.equal(result.flow.units_studied, 120);
    assert.equal(result.flow.admin_report_loads, 2);
    assert.ok(result.flow.admin_exports >= 1);
    assert.equal(result.flow.logouts_learner, 20);
    assert.equal(stats.events.refreshReuse, 0, 'a refresh token was reused');
    assert.ok((result.flow.refreshes_scheduled || 0) > 0, 'no scheduled refresh happened');
    assert.ok((result.flow.refresh_on_401 || 0) > 0, 'no 401 -> refresh path happened');
    assert.equal(stats.events.loginOriginRefused, 0);
    assert.equal(result.metrics.status, 'absent');
    assert.equal(result.pg.available, false);

    // Every request the stub served was recorded exactly once by the runner (preflight + endpoints + health probes).
    const served = Object.values(stats.counts).reduce((a, byStatus) => a + Object.values(byStatus).reduce((x, y) => x + y, 0), 0);
    const probes = result.probes['probe GET /api/health']?.count || 0;
    assert.equal(served, result.preflight.requests + result.totals.requests + probes + result.metrics.requests);
    // Injected faults show up as 429 / 5xx in the results; 429s were retried.
    assert.equal(result.totals.by_class['429'] || 0, stats.events.injected429);
    assert.equal(result.totals.by_class['5xx'] || 0, stats.events.injected500);
    if (stats.events.injected429) assert.ok(result.flow.retries_429 > 0);
    for (const e of Object.values(result.endpoints)) assert.ok(e.p50 <= e.p95 && e.p95 <= e.p99 && e.p99 <= e.max);
    assert.ok(result.timeline.length >= 1);
    assert.ok(fs.existsSync(out));
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).label, 'selftest');
    assert.ok(!fs.readFileSync(out, 'utf8').includes(STUB_PASSWORD), 'the password must never be written to the result');

    // compare: identical results show no regression; a doubled p95 is flagged.
    const slower = JSON.parse(JSON.stringify(result));
    const name = 'POST /api/learner/complete-blocks';
    slower.endpoints[name].p95 = result.endpoints[name].p95 * 2 + 10;
    assert.equal(compareResults(result, result).regressions.length, 0);
    const cmp = compareResults(result, slower);
    assert.ok(cmp.regressions.some((r) => r.startsWith(name)));
    assert.match(renderComparison(result, slower, cmp), /REGRESSIONS/);
  } finally {
    await server.close();
    fs.rmSync(out, { force: true });
  }
});

test('safety: a sign-in into any other tenant stops before load', async () => {
  const otherTenant = new Map([['brandingTenantId', '11e1e243-9221-4a2b-ab56-dc66cc0d9fae'], ['tenantId', '11e1e243-9221-4a2b-ab56-dc66cc0d9fae']]);
  const base = { learners: 2, rampS: 0, durationS: 10, think: fastThink, appDelayScale: 0, pgContainer: 'none', metricsPath: 'none', healthIntervalS: 0, quiet: true };
  const hooks = (stub) => ({ transport: createInProcessTransport(stub), password: STUB_PASSWORD, pgContainer: 'none', write: false, log: () => {} });

  // Domain resolves to another tenant: refused in preflight.
  await assert.rejects(runDeadlineMorning(base, hooks(createStub({ password: STUB_PASSWORD, brandingTenantId: otherTenant.get('brandingTenantId') }))), /resolves to tenant/);
  // Domain right but the account belongs to another tenant: safety stop on the first sign-in.
  await assert.rejects(runDeadlineMorning(base, hooks(createStub({ password: STUB_PASSWORD, brandingTenantId: LOADTEST_TENANT.id, tenantId: otherTenant.get('tenantId') }))), /SAFETY STOP/);
  // Wrong password: refused in preflight, no learner starts.
  await assert.rejects(runDeadlineMorning(base, { ...hooks(createStub({ password: 'other' })) }), /sign-in of lt-0001 failed/);
});
