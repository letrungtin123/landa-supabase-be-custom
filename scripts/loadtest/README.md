# Load-test kit: "deadline morning" (LOCAL ONLY)

Up to 2,000 synthetic learners of the local tenant **"Thử tải"** (slug `loadtest`) sign in over a ramp and rush through
one mandatory course on the morning of its deadline. A few tenant admins can keep the report page open in parallel.
The kit records per-endpoint p50/p95/p99, throughput, error rates by status (429, 5xx, network), the learner journey,
and server-side signals: read-only `pg_stat_activity` every 2 s, `pg_stat_database` deltas, `/api/health` latency, and
`/internal/metrics` if the API has it.

Node 24 only, no packages (`node:http` keep-alive, `perf_hooks` HDR histograms, `node:test`).

| File | Purpose |
|---|---|
| `deadline-morning.mjs` | the scenario runner (CLI: `--help`) |
| `compare.mjs` | before/after comparison of two result files |
| `stub-server.mjs` | local imitation of the API surface, for trying the kit without the real API |
| `loadtest.selftest.test.mjs` | self-test against the stub (no docker, no real API) |
| `lib/` | config and safety, transport, session (tokens, retries), learner and admin journeys, samplers, stats, stub |
| `.credentials.local` | **git-ignored**: `LOADTEST_PASSWORD=...`, the shared password of every `lt-*` account. Never commit, print or paste it. |
| `results/` | **git-ignored**: result JSON files |

The tenant is created and removed by SQL files that must be applied separately, each with the owner's approval:

- `supabase/manual_sql/20261018_1200_loadtest_seed_tenant.sql` creates the tenant `4af392ce-8be9-4d9b-aae9-35572f3f676c`.
  - Learner domain `http://loadtest.localhost:5273`, admin domain `http://loadtest.localhost:5274`.
  - 2,000 learners `lt-0001` … `lt-2000` (`lt-NNNN@loadtest.test`) and 3 admins `lt-admin-01` … `03` (role superuser).
  - 4 teams of 500.
  - 1 published course `course-v1:LoadTest+DEADLINE_MORNING+2026`: 3 chapters × 4 lessons × 3 units, each unit = 1 html + 1 quiz, 72 leaves. It is assigned to the 4 teams and everyone is enrolled at 0 %.
  - 3 badge rules and 3 notifications × 2,000 recipients.
  - Modules `ai_chatbot` and `news` are off, so the test never calls an AI provider.
- `supabase/manual_sql/20261018_1200_loadtest_seed_tenant_CLEANUP.sql` removes every row of that tenant, including everything the load test wrote, and nothing else.

## Safety rules

- **Local only.** `--target` must be `http://` on loopback (`127.0.0.1`, `localhost`, `::1`); anything else is refused.
  - The ports of the live local apps (3101 API, 5273 learner app, 5274 dashboard) also need `--confirm-local-api`.
  - Never point it at prod 226. Never run it during demo hours: the API, Postgres, Redis and RabbitMQ are shared with every real tenant on this machine.
- **Preflight before any load.** The run aborts unless all of these pass:
  - `GET /api/health` returns 200;
  - `loadtest.localhost` resolves to the load-test tenant id (`GET /api/branding/by-domain/loadtest.localhost`);
  - `lt-<start>` can sign in;
  - `GET /api/auth/me` returns 200.
- **Safety stop.** If any sign-in lands in another tenant, the whole run stops (`SAFETY STOP`, exit code 3). Only `lt-*` accounts are ever used.
- **Read-only database access.** The Postgres sampler opens one session with `default_transaction_read_only=on`, `statement_timeout=1500ms` and `lock_timeout=500ms` (`docker exec … psql`, application name `landa-loadtest-sampler`). Turn it off with `--pg-container none`.
- **Secrets stay out of output.** The password is read from `LOADTEST_PASSWORD` or `.credentials.local` and never logged or written to a result file. Result files contain no tokens.
- **SQL needs owner approval each time.** The seed and the cleanup are applied only through `supabase/apply-sql.ps1`, each after the owner's `APPROVE SQL APPLY LOCAL <file>`. This kit never runs SQL.

## Before the first real run (checklist)

1. **Owner approves and applies the seed:**

   ```powershell
   .\supabase\apply-sql.ps1 20261018_1200_loadtest_seed_tenant.sql -Target local
   ```

   - The file refuses any database that is not the local Landa DB. It checks the cluster identity, that the local-only tenant Deep C is present, and that no prod tenant (Digi Edu / L&A / Việt Úc) exists.
   - `.credentials.local` must be the one generated with the seed's hash (it is, in this worktree).
2. **Check the backend env (read the value only, do not print secrets).** `RUNTIME_TENANT_ALLOWLIST` must be empty or contain `4af392ce-8be9-4d9b-aae9-35572f3f676c`, and `RUNTIME_TENANT_DENYLIST` must not contain it. Otherwise every learner request gets 403, and the preflight stops with that hint.
3. **Wait out stale caches if needed.** If anything requested `branding/by-domain/loadtest.localhost` before the seed existed, wait 5 minutes for the Redis branding cache, or the preflight fails.
4. **Check that nothing else is running:**
   - no demo is in progress;
   - no AI ID run is active;
   - nobody else is load-testing.
5. **Run the self-test and a dry run:**

   ```bash
   node --test scripts/loadtest/loadtest.selftest.test.mjs
   node scripts/loadtest/deadline-morning.mjs --dry-run --learners 2000 --admins 3
   ```

   `--dry-run` sends nothing. It prints:
   - the plan;
   - the request-rate estimate (about 420 req/s with 2,000 active learners at the default think times);
   - the exact request sequence of one learner and one admin, replayed against the in-process stub.

## Commands (run from `landa-backend/`)

Ladder, one step at a time. Look at the summary before going higher:

```bash
node scripts/loadtest/deadline-morning.mjs --target http://127.0.0.1:3101 --confirm-local-api --learners 100  --ramp-s 60  --label "before <release> 100"  --out scripts/loadtest/results/before-0100.json
node scripts/loadtest/deadline-morning.mjs --target http://127.0.0.1:3101 --confirm-local-api --learners 500  --ramp-s 120 --start-index 101  --label "before <release> 500"  --out scripts/loadtest/results/before-0500.json
node scripts/loadtest/deadline-morning.mjs --target http://127.0.0.1:3101 --confirm-local-api --learners 1000 --ramp-s 180 --start-index 601  --admins 3 --label "before <release> 1000" --out scripts/loadtest/results/before-1000.json
```

- The full 2,000-learner run needs fresh learners, so see "Comparing two runs" below.
- Through the learner app's proxy on :5273, which also measures the `vite preview` proxy, use `--target http://127.0.0.1:5273 --confirm-local-api`.
- Ctrl+C stops gracefully: every learner finishes its current request, syncs study time and signs out.
- Useful options:
  - `--think-scale 0.5`: twice as fast learners.
  - `--units-per-session 12`: one chapter per learner, instead of the whole course.
  - `--duration-s`: hard stop (default 1500).
  - `--admin-interval-s`, `--admin-export-every`.
  - `--seed`: the same seed gives the same think times and answers.
  - `--forwarded-for`: a distinct `X-Forwarded-For` per learner. It only has an effect if `TRUSTED_PROXY_CIDRS` trusts loopback; by default all learners share one client IP, as behind a single proxy.

Try the kit against the stub, with nothing real involved:

```bash
node scripts/loadtest/stub-server.mjs --port 3999 --latency-ms 5,40 --fault-429 0.01 --fault-500 0.005
LOADTEST_PASSWORD=stub-password node scripts/loadtest/deadline-morning.mjs --target http://127.0.0.1:3999 --learners 50 --ramp-s 5 --think-scale 0.01 --pg-container none --out /tmp/stub.json
```

## What one learner does

The requests and timings come from fe-5173 (`src/api/*`, `stores/useAuthStore.ts`, `pages/LessonDetailPage.tsx`, `hooks/useNotifications.ts`, `hooks/useStudyTimeEngine.ts`). Paths and bodies are the app's.

1. **Sign-in page.** In parallel:
   - `GET /api/branding/by-domain/loadtest.localhost`
   - `GET /api/dashboard-content/by-domain/loadtest.localhost`
   - `GET /api/sso/public/by-domain/loadtest.localhost`

   Then, after a think time, `POST /api/auth/login` with `{username, password, client_app:"learner", origin:"http://loadtest.localhost:5273"}` and the `Origin` header.
   - The tenant is resolved by that exact origin and afterwards by the JWT `tid` claim. There is no tenant header.
   - Then `GET /api/auth/me`.
2. **Session-wide components.** In parallel:
   - `GET /api/welcome-init/state`
   - `POST /api/learner/badges/evaluate`
   - `GET /api/enrollments/weekly-study-time`
   - `GET /api/ai-chatbot/chat/active-bot?target=learner`
   - `GET /api/learner/notifications/unread-count`
   - `GET /api/learner/notifications?page_size=20`
   - `GET /api/learner/enrollments`
   - `GET /api/learner/courses?page_size=200`

   Then `GET /api/learner/progress-batch?courseIds=…`, and `POST /api/welcome-init/seen` when the welcome popup shows.
3. **Course page.** In parallel:
   - `progress/:id`
   - `courses/:id/modal-config`
   - `courses/:id/blocks` (all unit content)
   - `courses/:id`
   - `courses/:id/files`
   - `assignments/learner/courses/:id`

   Then `modal-state`. After the 800 ms skeleton, `section-modal-configs` and `section-modal-shown`. The welcome popup sends `PATCH modal-state {welcome_shown:true}`, followed by a badge evaluation.
4. **Per unit, in course order.**
   - `POST /api/learner/complete-blocks` for the html leaf, sent at once.
   - `GET /api/learner/blocks/:quizId`.
   - A reading think time.
   - `POST /api/learner/blocks/:quizId/submit {answers:{olx_mcq_0:"choice_N"}}`. The answer is right at the first try 60 % of the time, otherwise after 1–2 wrong answers.
   - `POST complete-blocks [quizId]`.
   - Follow-ups as the app does them: a badge evaluation when `completion_changed`; progress-batch, enrollments and assignments when the course completes; stale course-page queries are refetched on a lesson change.
5. **Course completed.**
   - `PATCH modal-state {confirm_shown}`, then `{complete_shown}`.
   - A badge evaluation, then `PATCH /api/learner/badges/:id/shown` and a second evaluation.
   - A linger time, a final study-time sync, then `POST /api/auth/logout`.
6. **Background timers while signed in:**
   - unread-count every 60 s; when the count changes, the list is fetched and sometimes one item is read;
   - `POST /api/enrollments/study-session {entries:[{date, minutes}]}` 15 s after sign-in and then every 5 min;
   - token refresh at `expires_in - 300 s` with `POST /api/auth/refresh {refresh_token, tenant_id}`. The refresh token rotates and is never reused. A 401 triggers one refresh and one replay.
7. **The app's request rules are applied:**
   - at most 6 `apiClient` requests in flight per tab;
   - a 429 is retried at most twice, honouring `Retry-After` up to 10 s, with full-jitter backoff otherwise;
   - the app's retrying queries (blocks, course detail, enrollments, …) retry a 5xx, timeout or network error after 1 s and then 2 s.

Admins (`--admins N`) sign in with `client_app:"admin"` from `http://loadtest.localhost:5274`. Every `--admin-interval-s` they load the report page's requests (`groups`, `summary` for this and the previous 30 days, `chart` window, `course-completion-ranking`, `learners`). Every Nth load also downloads `export.xlsx`.

Approximations:
- Images and static files are not loaded.
- The learner app's odd `weekly-study-time` query string (React Query context serialized into it) is sent without parameters.
- Browser `beforeunload` beacons are replaced by the final sync before logout.
- The load generator is one Node process. If `load_generator.event_loop_delay_ms.p99` is above ~100 ms, the generator itself was the bottleneck.

## Output

The runner prints a per-endpoint table: count, rps, p50/p95/p99/max, error %, 429, 5xx, network errors. It also prints totals, flow counters, a Postgres summary, the metrics endpoint status, health-probe latency and generator lag. The JSON (`--out`, default `scripts/loadtest/results/…`) contains:

- `endpoints`: per endpoint: `count`, `rps`, `p50`…`max` in ms, `error_rate`, `rate_429`, `rate_5xx`, `rate_net`, `statuses`, `net_errors`.
- `totals`, and `timeline` (10 s windows: requests, rps, p50/p95/p99, ok/4xx/429/5xx/net, VUs).
- `flow`: logins, units studied, blocks marked, quiz attempts, courses completed, badges earned, refreshes (scheduled / on 401 / refused), 429 and query retries, logouts.
- `pg.summary`:
  - connections and active sessions (max/avg);
  - lock waits, also split into **advisory** (the per-tenant quota lock) and row lock waits;
  - the longest lock wait and the longest active statement.
- `pg.top_lock_waits`: the most frequently waiting statements, with literals masked.
- `pg.db_delta`: commits, rollbacks, deadlocks, temp bytes.
- `pg.loadtest_quota_bytes`: the tenant's quota counter at the start and end.
- `metrics`: `absent` when `/internal/metrics` does not exist (404/401/403); otherwise the first and the latest snapshots. If the endpoint needs a header, set `LOADTEST_METRICS_HEADER="Name: value"` in the environment.
- `probes['probe GET /api/health']`: API liveness latency, kept out of the totals.

## Comparing two runs (before/after a release)

```bash
node scripts/loadtest/compare.mjs scripts/loadtest/results/before-1000.json scripts/loadtest/results/after-1000.json --threshold 10
```

- The table shows count, p50, p95 and p99 before/after with Δ %, error % before/after, totals, and the Postgres maxima.
- A **regression** is either of these, on an endpoint with at least 50 requests in both runs:
  - p95 or p99 slower by more than `--threshold` % (default 10) and by more than 5 ms;
  - error rate higher by more than 0.5 percentage points with at least 3 more failures.
- `--fail-on-regression` makes it exit with code 1 on any regression.

Compare like with like:

- **Same options.** Use the same `--learners`, `--ramp-s`, `--think-scale`, `--units-per-session`, `--admins` and `--seed`. compare.mjs warns when learners, seed or think scale differ.
- **Same starting data.** Learners keep their progress, so a second run with the same learners skips their completed units and is a lighter test. Use either:
  - disjoint `--start-index` ranges, for example 1–1000 before and 1001–2000 after; or
  - CLEANUP, then the seed again, between runs. Re-applying the seed needs the owner's approval and `-Force`, because apply-sql.ps1 logs it as applied.
- **Same machine state.** Same PM2 processes and no other load. Note the backend commit in `--label`.
- **Watch these signals:**
  - `pg.summary.advisory_waits_max` and `lock_waits_max`: the per-tenant quota lock serializes all of the tenant's writes;
  - `POST /api/learner/complete-blocks` and `POST /api/auth/login` p95/p99;
  - 429 counts (the per-IP sign-in limiter, by default 300 sign-ins in flight per IP; the refresh limiter);
  - `/api/health` latency, as an event-loop proxy of the API;
  - `pg.db_delta.deadlocks`.

## After the measurements

1. The owner approves and applies the cleanup:

   ```powershell
   .\supabase\apply-sql.ps1 20261018_1200_loadtest_seed_tenant_CLEANUP.sql -Target local
   ```

   - Stop the load test first. Open learner sessions hold `FOR KEY SHARE` locks on their users.
   - The file refuses if the tenant contains non-`lt-*` accounts, extra courses or stored files, or if another tenant's row references an `lt-*` account.
   - The tenant's quota counter goes back to 0 through the normal triggers.
   - API caches of the deleted domain expire within about 5 minutes; no restart is needed.
2. Delete `scripts/loadtest/.credentials.local`. The `results/` files can be kept; they contain no secrets.
