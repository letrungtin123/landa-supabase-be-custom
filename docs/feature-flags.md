# Feature flags and settings

Every environment setting that `src/config/env/*.ts` reads, with its default in
the code, its value in the two PM2 deployments we have the files of, whether it
still changes anything, and what to do with it. Documentation only: no flag is
removed or changed by this page. Audit references: BE-S11 and §3.4 of
`AUDIT_2026-10-18/backend_code_structure.md`.

## How to read this page

- **Default**: what the code uses when the variable is not set
  (`src/config/env/__snapshots__/env-characterization.json`, scenario
  `values/minimal`). `required`: the process does not start without it.
- **Local**: the value in `ecosystem.config.cjs` of the main checkout (the PM2
  apps on this PC). Only names and non-secret values were read.
- **226**: the value in `ecosystem.production-no-ai.config.cjs` (the file prod
  226 runs, kept in git).
- `–`: the ecosystem file does not set it. Both deployments run with
  `NODE_ENV=production`, so `env.ts` also loads `.env.production` on each
  machine. Those files were **not** read for this page: a `–` means "the code
  default, unless that machine's `.env.production` sets it". Where the audit
  (§3.4) reported a local `.env.production` value, it is quoted as "audit".
- **Dead**: the flag has one value in the code default and in both ecosystem
  files, so today it changes nothing in a deployment. It may still be set in a
  `.env.production`; check that before removing it.
- Recommendation: **keep**; **remove the flag, keep the behavior** (the code
  always does what the flag does today); **remove the behavior** (the code
  path the flag guards goes away).

## Summary

- 206 settings in `src/config/env/*.ts` (plus `isProduction`, derived from
  `NODE_ENV`), and `UV_THREADPOOL_SIZE` (16) that both ecosystem files set for
  Node itself.
- 33 of them switch behavior: 26 boolean flags, 3 one-of selectors
  (`LANDA_PROCESS_ROLE`, `LESSON_AUTHOR_ORCHESTRATION_V2_ROLE`,
  `REPORT_PDF_BROWSER_CHANNEL`) and 4 lists (`RUNTIME_TENANT_ALLOWLIST`,
  `RUNTIME_TENANT_DENYLIST`, `TRUSTED_PROXY_CIDRS`,
  `LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST`). They are in the next table.
- The other 173 are connection settings, secrets, limits, timeouts, batch
  sizes and model names (appendix). Recommendation for all of them: keep. Only
  `LANDA_API_INSTANCES`, `DB_POOL_MAX`, `REPORTS_DB_POOL_MAX`, `NODE_ENV` and
  three lesson-author values (V2 tenant and workspace concurrency, stream auth
  lease) are set in an ecosystem file; the rest use the default unless a `.env.production` sets
  them.
- **Dead flags (12)**: always `true`: `COURSE_PROGRESS_RECALC_WORKER_ENABLED`,
  `KB_OPERATION_WORKER_ENABLED`, `AI_ENGINE_TRANSITION_WORKER_ENABLED`,
  `LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED`, `EMAIL_OUTBOX_WORKER_ENABLED`,
  `TENANT_DATA_QUOTA_WORKER_ENABLED` and `COURSE_OUTLINE_TRANSFER_WORKER_ENABLED`
  (in the only process that reads each), `METRICS_ENABLED`,
  `AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION`, `SMTP_TLS_REJECT_UNAUTHORIZED`;
  always `false`: `EMAIL_OUTBOX_INLINE_WORKER_ENABLED` (in both deployments;
  `true` only in `npm run dev`), `LESSON_AUTHOR_GENERATION_STATUS_ENABLED`.
  `REPORT_PDF_STORAGE_ENABLED` and `REPORT_PDF_AI_NARRATIVE_ENABLED` are off in
  both ecosystem files too, but they guard unreleased features: owner decision.
- **Still needed (differ between deployments or select a role)**: the five
  `LESSON_AUTHOR_WORKSPACE_*_ENABLED`, `COURSE_PUBLISH_GOVERNANCE_ENABLED`,
  `LANDA_PROCESS_ROLE`, the lesson-author V2 lane selectors, the runtime lane
  lists and `RUNTIME_GLOBAL_MAINTENANCE_ENABLED` (demo lane),
  `LESSON_AUTHOR_IDM_PIPELINE_*`, `TRUSTED_PROXY_CIDRS`,
  `REPORT_PDF_BROWSER_CHANNEL`.

## Owner decisions for 226

1. **AI ID on 226** (`LESSON_AUTHOR_WORKSPACE_{READ,STREAM,EDIT,EXECUTION,APPLY}_ENABLED`):
   off on 226, on locally. Stay off, or turn on when AI ID ships to 226? Once
   one answer holds everywhere, the five flags can become one (plus Apply if
   it must stay separate).
2. **Course publish governance on 226** (`COURSE_PUBLISH_GOVERNANCE_ENABLED`):
   on locally, not set on 226 (so off, unless 226's `.env.production` sets
   it). Turn it on there? It needs its SQL on 226 first.
3. **V2 admission and the V1 path** (`LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED`,
   audit: `true` in the local `.env.production`; 226 unknown). When V2
   admission is on wherever AI ID runs, the V1 runtime and its flags
   (`LESSON_AUTHOR_GENERATION_ENABLED`, `LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED`,
   `LESSON_AUTHOR_GENERATION_STATUS_ENABLED`) can be removed. Retire V1?
4. **AI background workers on a no-AI 226** (`KB_OPERATION_WORKER_ENABLED`,
   `AI_ENGINE_TRANSITION_WORKER_ENABLED`, `LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED`):
   default `true`, and the no-AI file does not turn them off, so 226's
   background process runs them (unless its `.env.production` says otherwise).
   Should they run there? If they must be off on 226, these three are not dead
   and stay; if not, remove the flags (the process role already decides).
5. **Report PDF features** (`REPORT_PDF_STORAGE_ENABLED`,
   `REPORT_PDF_AI_NARRATIVE_ENABLED`): off in both files. Release them (then
   keep the flags until they are on everywhere) or remove the code paths?
6. **IDM pipeline on 226** (`LESSON_AUTHOR_IDM_PIPELINE_ENABLED` and its tenant
   allowlist; audit: `true` locally): keep until IDM is the official pipeline;
   say when that is for 226.
7. **Check 226's `.env.production`** (ops, before removing any dead flag):
   it is the only place a dead flag could still be set, and it decides values
   this page cannot see, e.g. `REPORT_PDF_BROWSER_CHANNEL` (default `msedge`;
   the 226 host must have that browser or set another channel or
   `REPORT_PDF_BROWSER_PATH`) and `SMTP_TLS_REJECT_UNAUTHORIZED`.

## Flags and selectors

| Flag | Default | Local | 226 | Read in | Dead? | Recommendation | Owner (226) |
|---|---|---|---|---|---|---|---|
| `LANDA_PROCESS_ROLE` | `all` | `api` (API cluster), `background` | `api`, `background` | `config/process-role.ts` | no | keep: decides what each process starts | – |
| `LESSON_AUTHOR_WORKSPACE_READ_ENABLED` | `false` | `true` | `false` | `ai-chatbot.routes.ts`, workspace runtime | no | keep; merge the five into one AI ID flag once 226 is decided | #1 |
| `LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED` | `false` | `true` | `false` | `ai-chatbot.routes.ts` | no | as above | #1 |
| `LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED` | `false` | `true` | `false` | `ai-chatbot.routes.ts` | no | as above | #1 |
| `LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED` | `false` | `true` | `false` | `ai-chatbot.routes.ts`, workspace runtime | no | as above | #1 |
| `LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED` | `false` | `true` | `false` | `ai-chatbot.routes.ts` | no | as above (or keep Apply separate) | #1 |
| `COURSE_PUBLISH_GOVERNANCE_ENABLED` | `false` | `true` | – | course outline and publish governance controllers | no | keep until on everywhere, then remove the flag, keep the behavior | #2 |
| `LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED` | `false` | – (audit: `true`) | – | `ai-chatbot.routes.ts` (chooses V2 over the V1 `createLessonAuthorWorkspace`) | no | keep; when on everywhere, remove the flag and the V1 branch | #3 |
| `LESSON_AUTHOR_GENERATION_ENABLED` | `false` | – (audit: `true`) | – | routes, durable Blueprint, chat turn admission/context | no | V1 path: remove the behavior together with V1 | #3 |
| `LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED` | `false` | – (audit: `true`) | – | chapter runtime, chat turn admission/context | no | V1 path: remove the behavior together with V1 | #3 |
| `LESSON_AUTHOR_GENERATION_STATUS_ENABLED` | `false` | – | – | `ai-chatbot.routes.ts` (OR'd with `LESSON_AUTHOR_GENERATION_ENABLED`) | yes (always `false`) | remove the flag (the status route follows `LESSON_AUTHOR_GENERATION_ENABLED`) | #3 |
| `LESSON_AUTHOR_IDM_PIPELINE_ENABLED` | `false` | – (audit: `true`) | – | `ai-chatbot.routes.ts` | no | keep until IDM is official | #6 |
| `LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST` | `[]` | – | – | `ai-chatbot.routes.ts` (selects the pipeline, does not gate access) | – | keep with the flag above | #6 |
| `LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED` | `false` | – (set by `ecosystem.lesson-author-orchestration-v2.config.cjs`) | – | V2 runtime config | no | keep: turns the V2 dispatcher/worker processes on | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_ROLE` | `disabled` | – (as above) | – | V2 runtime config | no | keep: dispatcher or worker | – |
| `EMAIL_OUTBOX_INLINE_WORKER_ENABLED` | `true` | `false` | `false` | `process-main.ts` | yes in deployments (`true` only in `npm run dev`) | remove the behavior once `npm run dev` starts the email worker process | – |
| `EMAIL_OUTBOX_WORKER_ENABLED` | `true` | `true` (email worker app) | `true` (email worker app) | `email-outbox.service.ts` | yes (always `true`) | remove the flag, keep the behavior | – |
| `TENANT_DATA_QUOTA_WORKER_ENABLED` | `false` | `true` (its own app) | `true` (its own app) | `workers/tenant-data-quota.worker.ts` only | yes (`true` in the only process that reads it) | remove the flag, keep the behavior: the dedicated entry point is the switch | – |
| `COURSE_OUTLINE_TRANSFER_WORKER_ENABLED` | `false` | `true` (its own app) | `true` (its own app) | `workers/course-outline-transfer.worker.ts` only | yes (as above) | remove the flag, keep the behavior | – |
| `COURSE_PROGRESS_RECALC_WORKER_ENABLED` | `true` | – | – | `learner/progress-recalculation.worker.ts` | yes (always `true`) | remove the flag, keep the behavior (`LANDA_PROCESS_ROLE` decides) | – |
| `KB_OPERATION_WORKER_ENABLED` | `true` | – | – | `kb/kb-operation.worker.ts` | yes (always `true`) | remove the flag, keep the behavior, unless #4 wants it off on 226 | #4 |
| `AI_ENGINE_TRANSITION_WORKER_ENABLED` | `true` | – | – | `ai-platform/ai-engine-transition.worker.ts` | yes (always `true`) | as above | #4 |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED` | `true` | – | – | `ai-id/sources/lesson-author-transcription.worker.ts` | yes (always `true`) | as above | #4 |
| `REPORT_PDF_STORAGE_ENABLED` | `false` | – | – | `ai-report/report-pdf-export.service.ts` | off everywhere | owner: release or remove the behavior (audit perf L3) | #5 |
| `REPORT_PDF_AI_NARRATIVE_ENABLED` | `false` | – | – | `ai-report/report-pdf-narrative.service.ts` | off everywhere | owner: release or remove the behavior | #5 |
| `REPORT_PDF_BROWSER_CHANNEL` | `msedge` | – | – | `ai-report/report-pdf-renderer.service.ts` | – | keep (host specific) | #7 |
| `METRICS_ENABLED` | `true` | – | – | `metrics.routes.ts`, `process-main.ts` | yes (always `true`) | keep as a kill switch for the metrics endpoint, or remove the flag, keep the behavior | – |
| `AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION` | `true` | – | – | `process-main.ts` | yes (always `true`) | remove the flag, keep the behavior (Redis is required in production) | – |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | – | – | `utils/smtp-client.ts` | yes (always `true`) | remove the flag, keep the behavior, unless a tenant SMTP server needs it off | #7 |
| `RUNTIME_GLOBAL_MAINTENANCE_ENABLED` | `true` | – | – | `process-main.ts` | not in these two files | keep: the demo lane turns it off | – |
| `RUNTIME_TENANT_ALLOWLIST` | `[]` | – | – | `config/runtime-tenant-fence.ts` | not in these two files | keep: demo / lane split | – |
| `RUNTIME_TENANT_DENYLIST` | `[]` | – | – | `config/runtime-tenant-fence.ts` | not in these two files | keep: demo / lane split | – |
| `TRUSTED_PROXY_CIDRS` | `[]` | – | – | `config/trust-proxy.ts` | – | keep (network specific) | – |

## Appendix: every setting by domain

⚑ = in the flags table above. Status of every row without ⚑: keep. A `–` in
both columns means the code default applies in both deployments unless a
`.env.production` sets it; secrets and required values come from
`.env.production` and are never listed.

### AI ID (lesson author) (`src/config/env/ai-id.ts`, 49)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `COURSE_PUBLISH_GOVERNANCE_ENABLED` ⚑ | `false` | true (2 apps) | – |
| `FFMPEG_PATH` | `ffmpeg` | – | – |
| `FFPROBE_PATH` | `ffprobe` | – | – |
| `GEMINI_TRANSCRIPTION_MODEL` | `gemini-3.5-transcribe` | – | – |
| `LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED` ⚑ | `false` | – | – |
| `LESSON_AUTHOR_GENERATION_ENABLED` ⚑ | `false` | – | – |
| `LESSON_AUTHOR_GENERATION_STATUS_ENABLED` ⚑ | `false` | – | – |
| `LESSON_AUTHOR_IDM_PIPELINE_ENABLED` ⚑ | `false` | – | – |
| `LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST` ⚑ | `[]` | – | – |
| `LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS` | 120000 (120 s) | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED` ⚑ | `false` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE` | `25` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED` ⚑ | `false` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY` | `64` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT` | `1` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX` | `0` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS` | `30` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS` | `8` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS` | `1000` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY` | `8` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS` | `120` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE` | `25` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS` | `1000` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS` | 60000 (60 s) | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_ROLE` ⚑ | `disabled` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY` | `16` | 4 (2 apps) | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS` | 45000 (45 s) | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS` | `30` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE` | `25` | – | – |
| `LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY` | `4` | 4 (2 apps) | – |
| `LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR` | `./tmp/lesson-author-transcription` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE` | `2` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY` | `1` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED` ⚑ | `true` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS` | `1800` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS` | `3` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS` | 10000 (10 s) | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS` | `60` | – | – |
| `LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS` | `3600` | – | – |
| `LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS` | `2000000` | – | – |
| `LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS` | `168` | – | – |
| `LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS` | `10800` | – | – |
| `LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB` | `500` | – | – |
| `LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED` ⚑ | `false` | true (2 apps) | false (2 apps) |
| `LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED` ⚑ | `false` | true (2 apps) | false (2 apps) |
| `LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED` ⚑ | `false` | true (2 apps) | false (2 apps) |
| `LESSON_AUTHOR_WORKSPACE_READ_ENABLED` ⚑ | `false` | true (2 apps) | false (2 apps) |
| `LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS` | 300000 (300 s) | 300000 (2 apps) | – |
| `LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED` ⚑ | `false` | true (2 apps) | false (2 apps) |

### AI platform, KB, chat (`src/config/env/ai.ts`, 40)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `AI_CHAT_ANSWER_DEADLINE_MS` | 180000 (180 s) | – | – |
| `AI_CHAT_GLOBAL_CONCURRENCY` | `48` | – | – |
| `AI_CHAT_TENANT_CONCURRENCY` | `8` | – | – |
| `AI_CHAT_TOKEN_RESERVE_ESTIMATE` | `16000` | – | – |
| `AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE` | `20` | – | – |
| `AI_ENGINE_TRANSITION_WORKER_ENABLED` ⚑ | `true` | – | – |
| `AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS` | `300` | – | – |
| `AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS` | `30` | – | – |
| `AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS` | 15000 (15 s) | – | – |
| `AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS` | `30` | – | – |
| `AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS` | `3600` | – | – |
| `AI_INDEX_TOKEN_RESERVE_ESTIMATE` | `20000` | – | – |
| `AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE` | `250000` | – | – |
| `AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS` | 30000 (30 s) | – | – |
| `AI_RAG_INDEX_REQUEST_TIMEOUT_MS` | 900000 (900 s) | – | – |
| `AI_RAG_REQUEST_TIMEOUT_MS` | 600000 (600 s) | – | – |
| `AI_RAG_SERVICE_HMAC_KEY_ID` | `''` (secret) | – | – |
| `AI_RAG_SERVICE_HMAC_SECRET` | `''` (secret) | – | – |
| `AI_RAG_SERVICE_TOKEN` | `''` (secret) | – | – |
| `AI_RAG_SERVICE_URL` | `''` | – | – |
| `AI_RAG_STORAGE_SIGNED_URL_ORIGIN` | `''` | – | – |
| `AI_RAG_STORAGE_SIGNED_URL_TTL_SECONDS` | `600` | – | – |
| `AI_SECRET_ENCRYPTION_KEY` | `''` (secret) | – | – |
| `AI_TOKEN_RESERVATION_SECONDS` | `600` | – | – |
| `GEMINI_CHAT_MODEL` | `gemini-3.8-flash` | – | – |
| `GEMINI_LESSON_AUTHOR_MODEL` | `gemini-3.8-flash` | – | – |
| `GEMINI_STORE_CREATE_TIMEOUT_MS` | 60000 (60 s) | – | – |
| `GEMINI_TEMP_DIR` | `./tmp/gemini` | – | – |
| `KB_FAQ_SHEET_READ_CONCURRENCY` | `2` | – | – |
| `KB_FAQ_SHEET_READ_MAX_MEMORY_MB` | `1024` | – | – |
| `KB_FAQ_SHEET_READ_TIMEOUT_MS` | 60000 (60 s) | – | – |
| `KB_OPERATION_WORKER_BATCH_SIZE` | `24` | – | – |
| `KB_OPERATION_WORKER_CONCURRENCY` | `4` | – | – |
| `KB_OPERATION_WORKER_ENABLED` ⚑ | `true` | – | – |
| `KB_OPERATION_WORKER_LEASE_SECONDS` | `300` | – | – |
| `KB_OPERATION_WORKER_MAX_ATTEMPTS` | `12` | – | – |
| `KB_OPERATION_WORKER_POLL_INTERVAL_MS` | 10000 (10 s) | – | – |
| `KB_OPERATION_WORKER_RETRY_BASE_SECONDS` | `30` | – | – |
| `KB_OPERATION_WORKER_RETRY_MAX_SECONDS` | `3600` | – | – |
| `KB_RESTORE_RECOVERY_POLL_INTERVAL_MS` | 30000 (30 s) | – | – |

### Auth (`src/config/env/auth.ts`, 12)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `AUTH_ACCOUNT_ACTION_MAX_ATTEMPTS` | `30` | – | – |
| `AUTH_LOGIN_ACCOUNT_MAX_FAILURES` | `10` | – | – |
| `AUTH_LOGIN_IP_MAX_FAILURES` | `300` | – | – |
| `AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS` | `10` | – | – |
| `AUTH_REFRESH_IP_MAX_FAILURES` | `2000` | – | – |
| `AUTH_REFRESH_TOKEN_MAX_ATTEMPTS` | `10` | – | – |
| `AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION` ⚑ | `true` | – | – |
| `BCRYPT_SALT_ROUNDS` | required | – | – |
| `JWT_ACCESS_EXPIRES_IN` | required | – | – |
| `JWT_REFRESH_EXPIRES_IN` | required | – | – |
| `JWT_SECRET` | required | – | – |
| `SSO_CONFIG_ENCRYPTION_KEY` | `''` (secret) | – | – |

### Core (process, tenants, HTTP) (`src/config/env/core.ts`, 13)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `BIND_HOST` | `0.0.0.0` | – | – |
| `LANDA_API_INSTANCES` | `1` | 2 (2 apps) | 4 (2 apps) |
| `LANDA_INAPP_CLUSTER_SLOT` | `''` | – | – |
| `LANDA_INAPP_CLUSTER_WORKERS` | `0` | – | – |
| `LANDA_PROCESS_ROLE` ⚑ | `all` | api (refactor-backend); background (backend-background) | api (refactor-backend); background (backend-background) |
| `NODE_ENV` | required | production (6 apps) | production (5 apps) |
| `PORT` | required | – | – |
| `RUNTIME_GLOBAL_MAINTENANCE_ENABLED` ⚑ | `true` | – | – |
| `RUNTIME_LANE` | `default` | – | – |
| `RUNTIME_TENANT_ALLOWLIST` ⚑ | `[]` | – | – |
| `RUNTIME_TENANT_DENYLIST` ⚑ | `[]` | – | – |
| `TRUSTED_PROXY_CIDRS` ⚑ | `[]` | – | – |
| `TRUST_PROXY_HOPS` | `0` | – | – |

### Database (`src/config/env/database.ts`, 8)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `DATABASE_POOLER_URL` | `''` | – | – |
| `DATABASE_URL` | required | – | – |
| `DB_CONNECTION_RESERVE` | `10` | – | – |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60000 (60 s) | – | – |
| `DB_LOCK_TIMEOUT_MS` | `0` | – | – |
| `DB_POOL_IDLE_TIMEOUT_MS` | 10000 (10 s) | – | – |
| `DB_POOL_MAX` | `20` | 10 (refactor-backend); 10 (backend-background); 3 (email-outbox-worker); 4 (tenant-data-quota-worker); 3 (course-outline-transfer-worker); 2 (news-assets-cleanup-worker) | 8 (refactor-backend); 8 (backend-background); 3 (email-outbox-worker); 4 (tenant-data-quota-worker); 3 (course-outline-transfer-worker) |
| `REPORTS_DB_POOL_MAX` | `4` | – | 2 (refactor-backend) |

### Email (`src/config/env/email.ts`, 18)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `EMAIL_OUTBOX_BATCH_SIZE` | `25` | – | – |
| `EMAIL_OUTBOX_CLAIM_BATCH_SIZE` | `25` | – | – |
| `EMAIL_OUTBOX_CONCURRENCY` | `3` | – | – |
| `EMAIL_OUTBOX_INLINE_WORKER_ENABLED` ⚑ | `true` | false (2 apps) | false (2 apps) |
| `EMAIL_OUTBOX_INTERVAL_MS` | 15000 (15 s) | – | – |
| `EMAIL_OUTBOX_RABBIT_PREFETCH` | `50` | – | – |
| `EMAIL_OUTBOX_RETENTION_BATCH_SIZE` | `1000` | – | – |
| `EMAIL_OUTBOX_SENT_RETENTION_DAYS` | `30` | – | – |
| `EMAIL_OUTBOX_SESSION_MAX_MESSAGES` | `20` | – | – |
| `EMAIL_OUTBOX_TENANT_CONCURRENCY` | `2` | – | – |
| `EMAIL_OUTBOX_TENANT_COOLDOWN_MS` | 300000 (300 s) | – | – |
| `EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD` | `3` | – | – |
| `EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS` | 1800000 (1800 s) | – | – |
| `EMAIL_OUTBOX_TICK_BUDGET_MS` | 45000 (45 s) | – | – |
| `EMAIL_OUTBOX_WAKE_DEBOUNCE_MS` | `500` | – | – |
| `EMAIL_OUTBOX_WORKER_ENABLED` ⚑ | `true` | true (email-outbox-worker) | true (email-outbox-worker) |
| `SMTP_CONFIG_ENCRYPTION_KEY` | `''` (secret) | – | – |
| `SMTP_TLS_REJECT_UNAUTHORIZED` ⚑ | `true` | – | – |

### Redis and RabbitMQ (`src/config/env/messaging.ts`, 7)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `RABBITMQ_QUEUE_PREFIX` | `''` | – | – |
| `RABBITMQ_RETRY_BASE_DELAY_MS` | `2000` | – | – |
| `RABBITMQ_RETRY_MAX_DELAY_MS` | 15000 (15 s) | – | – |
| `RABBITMQ_URL` | required | – | – |
| `REDIS_CONNECT_TIMEOUT_MS` | `2000` | – | – |
| `REDIS_DATABASE` | `0` | – | – |
| `REDIS_URL` | `''` | – | – |

### Metrics (`src/config/env/metrics.ts`, 3)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `METRICS_ENABLED` ⚑ | `true` | – | – |
| `METRICS_TOKEN` | `''` (secret) | – | – |
| `NODE_APP_INSTANCE` | `''` | – | – |

### Origins (`src/config/env/origins.ts`, 2)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `CORS_ORIGIN` | required | – | – |
| `DEMO_IFRAME_PUBLIC_ORIGIN` | `''` | – | – |

### Reports (`src/config/env/reports.ts`, 23)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `REPORTS_ADMISSION_WAIT_MS` | `2000` | – | – |
| `REPORTS_EXPORT_GLOBAL_CONCURRENCY` | `2` | – | – |
| `REPORTS_EXPORT_STATEMENT_TIMEOUT_MS` | 120000 (120 s) | – | – |
| `REPORTS_EXPORT_TENANT_CONCURRENCY` | `2` | – | – |
| `REPORTS_EXPORT_USER_CONCURRENCY` | `1` | – | – |
| `REPORTS_GLOBAL_CONCURRENCY` | `8` | – | – |
| `REPORTS_TENANT_CONCURRENCY` | `2` | – | – |
| `REPORT_AI_MODEL` | `gemini-3.8-flash` | – | – |
| `REPORT_CHAT_NARRATIVE_TIMEOUT_MS` | 15000 (15 s) | – | – |
| `REPORT_CHAT_ROUTER_TIMEOUT_MS` | `8000` | – | – |
| `REPORT_PDF_AI_NARRATIVE_ENABLED` ⚑ | `false` | – | – |
| `REPORT_PDF_AI_NARRATIVE_TIMEOUT_MS` | 20000 (20 s) | – | – |
| `REPORT_PDF_BROWSER_CHANNEL` ⚑ | `msedge` | – | – |
| `REPORT_PDF_BROWSER_IDLE_CLOSE_MS` | 600000 (600 s) | – | – |
| `REPORT_PDF_BROWSER_PATH` | `''` | – | – |
| `REPORT_PDF_RATE_LIMIT_WINDOW_SECONDS` | `600` | – | – |
| `REPORT_PDF_RENDER_CONCURRENCY` | `2` | – | – |
| `REPORT_PDF_RENDER_QUEUE_LIMIT` | `20` | – | – |
| `REPORT_PDF_RENDER_TIMEOUT_MS` | 30000 (30 s) | – | – |
| `REPORT_PDF_STORAGE_ENABLED` ⚑ | `false` | – | – |
| `REPORT_PDF_TENANT_ACTIVE_JOBS` | `5` | – | – |
| `REPORT_PDF_TENANT_EXPORTS_PER_WINDOW` | `60` | – | – |
| `REPORT_PDF_USER_EXPORTS_PER_WINDOW` | `10` | – | – |

### Storage (`src/config/env/storage.ts`, 4)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `STORAGE_DOWNLOAD_IDLE_TIMEOUT_MS` | 60000 (60 s) | – | – |
| `STORAGE_PROXY_HEADERS_TIMEOUT_MS` | 15000 (15 s) | – | – |
| `SUPABASE_SERVICE_KEY` | required | – | – |
| `SUPABASE_URL` | required | – | – |

### Workers (`src/config/env/workers.ts`, 27)

| Setting | Default | Local | 226 |
|---|---|---|---|
| `COURSE_OUTLINE_TRANSFER_WORKER_ENABLED` ⚑ | `false` | true (course-outline-transfer-worker) | true (course-outline-transfer-worker) |
| `COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS` | 10000 (10 s) | – | – |
| `COURSE_PROGRESS_RECALC_BATCH_SIZE` | `1000` | – | – |
| `COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK` | `5` | – | – |
| `COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS` | 60000 (60 s) | – | – |
| `COURSE_PROGRESS_RECALC_RABBIT_PREFETCH` | `1` | – | – |
| `COURSE_PROGRESS_RECALC_WORKER_ENABLED` ⚑ | `true` | – | – |
| `DELETION_JOB_RETENTION_DAYS` | `30` | – | – |
| `DELETION_MAX_ATTEMPTS` | `12` | – | – |
| `DELETION_REQUEUE_INTERVAL_MS` | 30000 (30 s) | – | – |
| `DELETION_RETRY_BASE_MS` | 30000 (30 s) | – | – |
| `DELETION_RETRY_MAX_MS` | 3600000 (3600 s) | – | – |
| `TENANT_DATA_QUOTA_FOLD_BATCH_SIZE` | `5000` | – | – |
| `TENANT_DATA_QUOTA_FOLD_INTERVAL_MS` | `2000` | – | – |
| `TENANT_DATA_QUOTA_FOLD_MAX_BATCHES_PER_TICK` | `20` | – | – |
| `TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS` | 600000 (600 s) | – | – |
| `TENANT_DATA_QUOTA_WORKER_ENABLED` ⚑ | `false` | true (tenant-data-quota-worker) | true (tenant-data-quota-worker) |
| `TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS` | 30000 (30 s) | – | – |
| `TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS` | `120` | – | – |
| `TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM` | `100` | – | – |
| `TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS` | 60000 (60 s) | – | – |
| `TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE` | `1` | – | – |
| `TENANT_DATA_QUOTA_WORKER_PAGE_SIZE` | `500` | – | – |
| `TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS` | 15000 (15 s) | – | – |
| `TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS` | `30` | – | – |
| `TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS` | `3600` | – | – |
| `TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS` | 30000 (30 s) | – | – |
