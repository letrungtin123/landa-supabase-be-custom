// Load-test configuration, CLI parsing and safety checks (local load-test tenant only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The synthetic tenant created by supabase/manual_sql/20261018_1200_loadtest_seed_tenant.sql. */
export const LOADTEST_TENANT = Object.freeze({
  id: '4af392ce-8be9-4d9b-aae9-35572f3f676c',
  slug: 'loadtest',
  hostname: 'loadtest.localhost',
  learnerOrigin: 'http://loadtest.localhost:5273',
  adminOrigin: 'http://loadtest.localhost:5274',
  courseId: 'course-v1:LoadTest+DEADLINE_MORNING+2026',
  learnerCount: 2000,
  adminCount: 3,
  leafCount: 72,
});

/** Ports of the live local apps: a run against them needs --confirm-local-api. */
export const LIVE_LOCAL_PORTS = Object.freeze([3101, 5273, 5274]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const learnerUsername = (n) => `lt-${String(n).padStart(4, '0')}`;
export const adminUsername = (n) => `lt-admin-${String(n).padStart(2, '0')}`;

/** Think-time ranges in milliseconds [min, max], scaled by --think-scale. */
export const DEFAULT_THINK_MS = Object.freeze({
  loginPage: [2000, 6000],
  dashboard: [3000, 10000],
  modal: [2000, 6000],
  unitRead: [8000, 25000],
  quizAnswer: [3000, 8000],
  quizRetry: [2000, 5000],
  betweenUnits: [1000, 4000],
  linger: [30000, 120000],
});

export const DEFAULTS = Object.freeze({
  target: 'http://127.0.0.1:3101',
  learners: 100,
  startIndex: 1,
  rampS: 180,
  durationS: 1500,
  unitsPerSession: 36,
  thinkScale: 1,
  quizFirstTryCorrect: 0.6,
  notificationPollS: 60,
  studySyncS: 300,
  studyFirstSyncS: 15,
  refreshIntervalS: 0,
  admins: 0,
  adminIntervalS: 60,
  adminExportEvery: 5,
  adminMaxCycles: 0,
  appDelayScale: 1,
  reportDays: 30,
  timeoutMs: 30000,
  maxSockets: 1024,
  pgContainer: 'supabase_db_SUPABASE-LOCAL',
  pgIntervalS: 2,
  metricsPath: '/internal/metrics',
  metricsIntervalS: 10,
  healthIntervalS: 2,
  seed: 1,
  logout: true,
  forwardedFor: false,
  confirmLocalApi: false,
  dryRun: false,
  quiet: false,
  label: '',
  out: '',
  credentialsFile: path.join(KIT_DIR, '.credentials.local'),
});

const NUMERIC = new Set(['learners', 'startIndex', 'rampS', 'durationS', 'unitsPerSession', 'thinkScale',
  'quizFirstTryCorrect', 'notificationPollS', 'studySyncS', 'studyFirstSyncS', 'refreshIntervalS', 'admins',
  'adminIntervalS', 'adminExportEvery', 'adminMaxCycles', 'appDelayScale', 'reportDays', 'timeoutMs', 'maxSockets', 'pgIntervalS', 'metricsIntervalS',
  'healthIntervalS', 'seed']);
const BOOLEAN = new Set(['logout', 'forwardedFor', 'confirmLocalApi', 'dryRun', 'quiet']);

const camel = (flag) => flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export const USAGE = `Usage: node scripts/loadtest/deadline-morning.mjs [options]

Scenario "deadline morning": N synthetic learners of the local tenant "Thử tải" sign in over a ramp,
open the mandatory course and work through its units; optional tenant admins open the report page.

  --dry-run                 no network: print the plan and replay one learner against the in-process stub
  --target URL              API base URL, loopback only (default ${DEFAULTS.target})
  --confirm-local-api       required when the target port is a live local app (${LIVE_LOCAL_PORTS.join(', ')})
  --learners N              virtual learners, 1..2000 (default ${DEFAULTS.learners}); lt-NNNN from --start-index
  --start-index N           first learner number (default 1)
  --ramp-s S                seconds over which learners start (default ${DEFAULTS.rampS})
  --duration-s S            hard stop for the whole run (default ${DEFAULTS.durationS})
  --units-per-session N     units each learner studies before lingering and signing out (default 36 = whole course)
  --think-scale X           multiply every think time (default 1; 0.1 = ten times faster learners)
  --quiz-first-try-correct P  share of quizzes answered right at the first try (default ${DEFAULTS.quizFirstTryCorrect})
  --notification-poll-s S   unread-count poll interval (default 60, as the learner app)
  --study-sync-s S          study-time sync interval (default 300, as the learner app)
  --refresh-interval-s S    force a token refresh every S seconds (default 0 = app rule: expires_in - 300 s)
  --admins N                tenant admins on the report page in parallel, 0..3 (default 0)
  --admin-interval-s S      seconds between report page loads per admin (default 60)
  --admin-export-every N    every Nth report load also downloads export.xlsx (default 5, 0 = never)
  --admin-max-cycles N      stop each admin after N report loads (default 0 = until the learners are done)
  --app-delay-scale X       multiply the app's own fixed delays (800 ms skeleton, 500 ms debounce, 1 s badge refetch; default 1)
  --seed N                  random seed (same seed = same think times and answers; default 1)
  --no-logout               keep sessions open at the end (default: sign out)
  --forwarded-for           send a distinct X-Forwarded-For per learner (only meaningful when the API trusts loopback proxies)
  --pg-container NAME|none  container for read-only pg_stat_activity samples (default ${DEFAULTS.pgContainer})
  --pg-interval-s S         sampling interval (default 2)
  --metrics-path PATH       API metrics endpoint probed once, sampled if present (default ${DEFAULTS.metricsPath})
  --out FILE                result JSON (default scripts/loadtest/results/deadline-morning-<N>-<time>.json)
  --label TEXT              free text stored in the result (e.g. "before release 2026-10-18")
  --credentials-file FILE   file with LOADTEST_PASSWORD=... (default scripts/loadtest/.credentials.local)
  --quiet                   no progress lines
`;

/** Defaults for programmatic callers (tests, dry-run) that pass only some options. */
export function withDefaults(partial = {}) {
  return { ...DEFAULTS, ...partial, think: { ...DEFAULT_THINK_MS, ...(partial.think || {}) } };
}

export function parseArgs(argv) {
  const options = withDefaults();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const [flag, inline] = arg.split('=', 2);
    if (flag.startsWith('--no-')) {
      const key = camel(`--${flag.slice(5)}`);
      if (!BOOLEAN.has(key)) throw new Error(`Unknown option ${flag}`);
      options[key] = false;
      continue;
    }
    const key = camel(flag);
    if (BOOLEAN.has(key)) { options[key] = inline === undefined ? true : inline !== 'false'; continue; }
    if (!(key in DEFAULTS)) throw new Error(`Unknown option ${flag}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new Error(`Option ${flag} needs a value`);
    if (NUMERIC.has(key)) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`Option ${flag} needs a number`);
      options[key] = number;
    } else {
      options[key] = value;
    }
  }
  return options;
}

export function validateOptions(options) {
  const problems = [];
  const int = (key, min, max) => {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) problems.push(`--${kebab(key)} must be an integer ${min}..${max}`);
  };
  int('learners', 0, LOADTEST_TENANT.learnerCount);
  int('startIndex', 1, LOADTEST_TENANT.learnerCount);
  if (options.startIndex + options.learners - 1 > LOADTEST_TENANT.learnerCount) problems.push(`--start-index + --learners exceeds lt-${LOADTEST_TENANT.learnerCount}`);
  int('admins', 0, LOADTEST_TENANT.adminCount);
  if (options.learners + options.admins === 0) problems.push('nothing to run: --learners and --admins are both 0');
  int('unitsPerSession', 0, 36);
  int('adminExportEvery', 0, 1000);
  int('adminMaxCycles', 0, 1_000_000);
  int('maxSockets', 1, 65535);
  for (const key of ['rampS', 'durationS', 'thinkScale', 'notificationPollS', 'studySyncS', 'studyFirstSyncS', 'refreshIntervalS',
    'adminIntervalS', 'appDelayScale', 'reportDays', 'timeoutMs', 'pgIntervalS', 'metricsIntervalS', 'healthIntervalS']) {
    if (!(options[key] >= 0)) problems.push(`--${kebab(key)} must be >= 0`);
  }
  if (!(options.durationS > 0)) problems.push('--duration-s must be > 0');
  if (!(options.quizFirstTryCorrect >= 0 && options.quizFirstTryCorrect <= 1)) problems.push('--quiz-first-try-correct must be 0..1');
  if (!(options.timeoutMs >= 1000)) problems.push('--timeout-ms must be >= 1000');
  if (!(options.pgIntervalS >= 0.5)) problems.push('--pg-interval-s must be >= 0.5');
  if (problems.length) throw new Error(problems.join('\n'));
  return options;
}

function kebab(key) {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Refuses anything that is not a loopback URL; live local app ports need the explicit confirmation flag. */
export function assertSafeTarget(target, confirmLocalApi) {
  let url;
  try { url = new URL(target); } catch { throw new Error(`--target ${target} is not a URL`); }
  if (url.protocol !== 'http:') throw new Error('--target must be http:// on loopback (the load test never leaves this machine)');
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`--target host ${url.hostname} is not loopback; this kit only runs against the local machine`);
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--target must be an origin only, e.g. http://127.0.0.1:3101');
  const port = Number(url.port || 80);
  if (LIVE_LOCAL_PORTS.includes(port) && !confirmLocalApi) {
    throw new Error(`--target port ${port} is a live local app: add --confirm-local-api (only outside demo hours, after the seed is applied)`);
  }
  return { origin: url.origin, hostname: url.hostname, port, live: LIVE_LOCAL_PORTS.includes(port) };
}

/** Reads the shared test password from LOADTEST_PASSWORD or the git-ignored credentials file. Never logged. */
export function loadPassword(credentialsFile) {
  if (process.env.LOADTEST_PASSWORD) return process.env.LOADTEST_PASSWORD;
  let text;
  try { text = fs.readFileSync(credentialsFile, 'utf8'); } catch {
    throw new Error(`Credentials file ${credentialsFile} is missing (git-ignored; it is created next to this kit when the seed is generated)`);
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith('LOADTEST_PASSWORD='));
  const password = line ? line.slice('LOADTEST_PASSWORD='.length).trim() : '';
  if (!password) throw new Error(`Credentials file ${credentialsFile} has no LOADTEST_PASSWORD= line`);
  return password;
}

/** Copy of the options safe to store in the result file (no password, no headers). */
export function publicOptions(options) {
  const { credentialsFile, help, ...rest } = options;
  return { ...rest, credentialsFile: credentialsFile ? path.basename(credentialsFile) : undefined };
}

export function scaledRange(options, kind) {
  const [min, max] = options.think[kind];
  return [min * options.thinkScale, max * options.thinkScale];
}
