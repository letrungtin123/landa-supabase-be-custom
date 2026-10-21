# Error codes

Every error response of the API carries a stable `code`. This page lists the
codes: the HTTP status, what the code means, and where it is raised. Message
texts are not listed here; they stay in the code (most are Vietnamese, some
follow `X-UI-Locale`).

## The error body

```json
{ "success": false, "message": "Text the UI shows", "code": "UPPER_SNAKE_CODE" }
```

- `message`: unchanged by this contract. The dashboard shows it when the UI is
  in Vietnamese and its own English fallback otherwise
  (`landa-dashboard/src/utils/localized-error.ts`); the learner app shows
  `message` or its fallback.
- `code`: always present. An error raised with its own code keeps it exactly
  (renaming one is a breaking change: the frontends branch on many of them).
  An error without one gets the code of its HTTP status (table below).
- Extra fields stay where a response already sent them: `error` (the code
  again, from `sendError(res, message, status, error)`; the frontends read it
  as a fallback), `field` (AI credit input errors), `request_id`, `conflict`,
  `kind` / `admission_status` / `correlation_id` (AI ID), and `stack` (only for
  an unexpected error outside production).

Built by `src/utils/errors.ts` (`errorBody`, `errorCodeForStatus`, `AppError`),
used by the global error handler (`src/middleware/error-handler.ts`),
`sendError` (`src/utils/response.ts`) and `sendClientError`
(`src/utils/client-error.ts`).

To raise an error: `throw new AppError(message, status, CODE)` with a code
constant (`export const X_CODE = 'X'`), or a domain error class with a
string-literal code union. Never `throw { status, message }`: a plain object
is not an `AppError` and becomes a 500.

## Codes from the HTTP status

For an error without a code of its own (`new AppError(message, status)`,
`sendError(res, message, status)`).

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | The request is invalid (missing or malformed input). Also any other 4xx not listed here. |
| 401 | `UNAUTHORIZED` | Not signed in, or the session is invalid, expired or revoked. |
| 403 | `FORBIDDEN` | Signed in but not allowed (role, tenant, runtime fence). |
| 404 | `NOT_FOUND` | The resource does not exist, or belongs to another tenant. |
| 405 | `METHOD_NOT_ALLOWED` | The method is not supported on this resource. |
| 409 | `CONFLICT` | The current state does not allow it (duplicate, changed meanwhile, busy). |
| 410 | `GONE` | The resource existed but has expired. |
| 413 | `PAYLOAD_TOO_LARGE` | The upload or body is over its limit. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | The content type is not accepted. |
| 416 | `RANGE_NOT_SATISFIABLE` | The requested byte range is outside the file. |
| 422 | `UNPROCESSABLE_ENTITY` | The input is well formed but cannot be processed. |
| 429 | `TOO_MANY_REQUESTS` | A rate limit or quota is reached. |
| 500 | `INTERNAL_ERROR` | An unexpected error (also any other status that is not a 4xx). |
| 502 | `BAD_GATEWAY` | An upstream service (Storage, AI service) answered an error. |
| 503 | `SERVICE_UNAVAILABLE` | A dependency is not available right now; retry later. |
| 504 | `GATEWAY_TIMEOUT` | An upstream service did not answer in time. |

None of these collides with a code or a prefix the frontends branch on
(checked in `src/utils/errors.test.ts`).

## Codes of the shared layers

| Code | Status | Meaning | Raised in |
|---|---|---|---|
| `INTERNAL_ERROR` | 500 | Unexpected error reaching the global handler. Message hidden in production; its own code (SQLSTATE, Node code) is never sent. | `middleware/error-handler.ts` |
| `INVALID_JSON` | 400 | The JSON body could not be parsed. Logged by type, status, method and path only (never the body). | `middleware/error-handler.ts` (body-parser `entity.parse.failed`) |
| `PAYLOAD_TOO_LARGE` | 413 | The JSON body is over its route limit (`middleware/body-limits.ts`), or an uploaded file is over its multer limit. | `middleware/error-handler.ts` (`entity.too.large`, multer `LIMIT_FILE_SIZE`) |
| `UNSUPPORTED_ENCODING` | 415 | The body uses an unsupported content encoding or charset. | `middleware/error-handler.ts` (`encoding.unsupported`, `charset.unsupported`) |
| `REQUEST_ABORTED` | 400 | The client stopped sending the body before it was complete. | `middleware/error-handler.ts` (`request.aborted`) |
| `TOO_MANY_PARAMETERS` | 413 | A form (urlencoded) body with more than 1000 fields. Logged by type only. | `middleware/error-handler.ts` (`parameters.too.many`) |
| `INVALID_FORM_BODY` | 400 | A form (urlencoded) body nested deeper than 32 levels. Logged by type only. | `middleware/error-handler.ts` (`querystring.parse.rangeError`) |
| `REQUEST_SIZE_INVALID` | 400 | The body is shorter or longer than its `Content-Length`. Logged by type only. | `middleware/error-handler.ts` (`request.size.invalid`) |
| `UPLOAD_TOO_MANY_FILES` | 400 | More files than the route's multer `files` limit. | `middleware/error-handler.ts` (multer `LIMIT_FILE_COUNT`) |
| `UPLOAD_UNEXPECTED_FILE` | 400 | A file in a field the route does not read, or more files than its `array(name, max)`. | `middleware/error-handler.ts` (multer `LIMIT_UNEXPECTED_FILE`) |
| `UPLOAD_TOO_MANY_PARTS` | 400 | More multipart parts than the route allows. | `middleware/error-handler.ts` (multer `LIMIT_PART_COUNT`) |
| `UPLOAD_FIELD_NAME_TOO_LONG` | 400 | A multipart field name over the limit. | `middleware/error-handler.ts` (multer `LIMIT_FIELD_KEY`) |
| `UPLOAD_FIELD_VALUE_TOO_LONG` | 400 | A multipart text field over the limit. | `middleware/error-handler.ts` (multer `LIMIT_FIELD_VALUE`) |
| `UPLOAD_TOO_MANY_FIELDS` | 400 | More multipart text fields than the route allows. | `middleware/error-handler.ts` (multer `LIMIT_FIELD_COUNT`) |
| `UPLOAD_FIELD_NAME_MISSING` | 400 | A multipart part without a field name. | `middleware/error-handler.ts` (multer `MISSING_FIELD_NAME`) |
| `UPLOAD_FIELD_NESTING_TOO_DEEP` | 400 | A multipart text field name with more than 5 bracket levels (`MULTIPART_FIELD_NAME_LIMITS`, `middleware/body-limits.ts`). | `middleware/error-handler.ts` (multer `LIMIT_FIELD_NESTING`) |
| `UPLOAD_FIELD_ARRAY_INDEX_TOO_LARGE` | 400 | A multipart text field name with an array index over 100 (same limits). | `middleware/error-handler.ts` (multer `LIMIT_FIELD_ARRAY_INDEX`) |
| `TENANT_DATA_LIMIT_REACHED` | 409 | The tenant's data quota is used up (quota trigger SQLSTATE `LQ001`, or the storage check). | `middleware/error-handler.ts`, `utils/client-error.ts`, `tenants/tenant-data-quota.service.ts` |
| `TENANT_DATA_QUOTA_RECONCILING` | 503 | The tenant's quota is being recounted (SQLSTATE `LQ002`); retry in a few minutes. | same as above |
| `REQUEST_FAILED` | 500 | Unexpected error caught by a controller through `sendClientError`; fixed message in the request language, cause only in the log. | `utils/client-error.ts` |
| `PERMISSION_DENIED` | 403 | The permission group does not allow this action on the module. | `middleware/authorize.ts` (`checkPermission`) |
| `MODULE_DISABLED` | 403 | The feature is turned off for the tenant. Also sent as `error` by `requireTenantModule`. | `middleware/authorize.ts`, `middleware/require-tenant-module.ts` |
| `TENANT_REQUIRED` | 403 | The user belongs to no tenant. Also sent as `error`. | `middleware/require-tenant-module.ts` |
| `ROUTE_NOT_FOUND` | 404 | No endpoint at this path ("Endpoint không tồn tại"). | `app.ts` (404 handler) |
| `DEMO_LOGIN_RATE_LIMITED` | 429 | More than 120 demo-login requests a minute. | `app.ts` (`demoLoginLimiter`) |
| `STUDY_SESSION_RATE_LIMITED` | 429 | More than 30 study-session requests a minute. | `app.ts` (`studySessionLimiter`) |
| `LOGIN_RATE_LIMITED` | 429 | Too many failed sign-ins for the account or the IP. | `middleware/auth-rate-limit.ts` |
| `REFRESH_RATE_LIMITED` | 429 | Too many session refreshes for the token or the IP. | `middleware/auth-rate-limit.ts` |
| `PASSWORD_CHANGE_RATE_LIMITED` | 429 | Too many password change attempts. | `middleware/auth-rate-limit.ts` |
| `ACCOUNT_ACTION_RATE_LIMITED` | 429 | Too many one-time links or profile updates. | `middleware/auth-rate-limit.ts` |
| `API_RATE_LIMITED` | 429 | The general per-user / per-IP API limit. | `middleware/auth-rate-limit.ts` (`apiLimiter`) |

Upload refusals (multer errors) reach the global handler from the routes that
do not answer them: assignments, badges, branding, the course mentor logo,
help docs, news, prompt templates, the user avatar, KB documents and FAQ, and
the bot avatar for anything but its size. They are logged as one
`[Upload] upload_refused` line (multer code, status, method, path), never the
field name, a field value or the file. Routes that answer multer themselves
keep their own codes and messages (bot avatar size, library, course assets,
AI ID video and source uploads).

`authenticate`, `authorize(...roles)` and `tenantContext` refuse with
`sendError` and no code of their own, so they send `UNAUTHORIZED` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404, unknown tenant), `BAD_REQUEST` (400) or
`INTERNAL_ERROR` (500).

## Module codes

### auth (`modules/auth`)

`AuthLoginError` sends `AUTH_<KEY>` with a message in the request language
(`auth-login-error.logic.ts`); thrown in `auth.service.ts`.

| Code | Status | Meaning |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong username or password. |
| `AUTH_ACCOUNT_DISABLED` | 403 | The account is disabled. |
| `AUTH_LEARNER_ADMIN_FORBIDDEN` | 403 | A learner account tried to sign in to the admin site. |
| `AUTH_NO_ADMIN_ACCESS` | 403 | The account has no access to the admin site. |
| `AUTH_NO_ORGANIZATION` | 403 | The account belongs to no organization. |
| `AUTH_ORGANIZATION_DISABLED` | 403 | The account's organization is disabled. |
| `AUTH_DEMO_ACCOUNT_LOCKED` | 403 | The account is in use for a demo. |
| `AUTH_REFRESH_CONTEXT_UNAVAILABLE` | 503 | The session context could not be read after a refresh; retry. |

### sso (`modules/sso`)

`SsoLoginError` sends `SSO_LOGIN_<KEY>` (`sso-account-link.logic.ts`); thrown
in `sso-account-link.logic.ts` and `sso.service.ts`.

| Code | Status | Meaning |
|---|---|---|
| `SSO_LOGIN_OTHER_ORGANIZATION` | 403 | The account belongs to another organization. |
| `SSO_LOGIN_EMAIL_NOT_VERIFIED` | 403 | The provider did not verify the email, so it cannot be linked. |
| `SSO_LOGIN_EMAIL_DOMAIN_NOT_ALLOWED` | 403 | The email domain is not allowed for the organization. |
| `SSO_LOGIN_ALLOWED_DOMAINS_INVALID` | 503 | The organization's allowed domains are set up wrongly. |
| `SSO_LOGIN_ACCOUNT_INACTIVE` | 403 | The account is pending or disabled. |
| `SSO_LOGIN_ALREADY_LINKED` | 409 | The provider identity is linked to another user. |
| `SSO_LOGIN_PROVIDER_TIMEOUT` | 504 | The sign-in provider did not answer in time. |

### users (`modules/users`)

`UserAuthorityError` sends `USER_AUTHORITY_<KEY>` (`user-authority.logic.ts`);
thrown in `users.service.ts`, answered by `users.controller.ts`.

| Code | Status | Meaning |
|---|---|---|
| `USER_AUTHORITY_SELF_ROLE_CHANGE` | 403 | Changing one's own role. |
| `USER_AUTHORITY_SELF_STATUS_CHANGE` | 403 | Disabling or activating one's own account. |
| `USER_AUTHORITY_SELF_PASSWORD_CHANGE` | 403 | Changing one's own password from the user admin (use the profile page). |
| `USER_AUTHORITY_SELF_DELETE` | 403 | Deleting one's own account. |
| `USER_AUTHORITY_SELF_PERMISSION_GROUP_CHANGE` | 403 | Changing one's own permission group. |
| `USER_AUTHORITY_SUPERADMIN_ONLY` | 403 | Only a Super Admin manages Super Admin accounts. |
| `USER_AUTHORITY_ROLE_NOT_ASSIGNABLE` | 403 | The role is above what the actor may assign. |
| `USER_AUTHORITY_TARGET_NOT_MANAGEABLE` | 403 | The target account is not manageable by the actor. |
| `USER_AUTHORITY_CROSS_TENANT` | 403 | The target account is in another organization. |
| `USER_AUTHORITY_TENANT_REQUIRED` | 403 | The active organization is unknown. |
| `USER_AUTHORITY_LAST_SUPERADMIN` | 409 | The last active Super Admin cannot be disabled, demoted or deleted. |
| `USER_AUTHORITY_TARGET_CHANGED` | 409 | The account changed meanwhile; reload. |

### ai-credits (`modules/ai-credits`)

| Code | Status | Meaning | Raised in |
|---|---|---|---|
| `AI_CREDIT_INVALID_INPUT` | 400 | Invalid input; `field` names the first refused field. | `ai-credit.validator.ts` |
| `AI_USAGE_FORBIDDEN` | 403 | Learners may not see AI usage. | `ai-credit.access.ts` |
| `AI_CREDIT_INSUFFICIENT_FOR_RUN` | 429 | Not enough AI points left for this run. | `ai-credit.service.ts` |
| `AI_CREDIT_MONTH_INVALID` | 400 | The month is not `YYYY-MM`. | `ai-credit.service.ts` |
| `AI_CREDIT_MONTH_NOT_FOUND` | 404 | No AI point data for that month yet. | `ai-credit.service.ts` |
| `AI_CREDIT_PLAN_CODE_TAKEN` | 409 | The plan code is already used. | `ai-credit.service.ts` |
| `AI_CREDIT_PLAN_NOT_FOUND` | 404 | The plan does not exist. | `ai-credit.service.ts` |
| `AI_CREDIT_PLAN_INACTIVE` | 400 | The plan is turned off and cannot be assigned. | `ai-credit.service.ts` |
| `TENANT_NOT_FOUND` | 404 | The tenant does not exist (the AI credit admin shows a specific message). | `ai-credit.service.ts` |

### news (`modules/news`)

| Code | Status | Meaning | Raised in |
|---|---|---|---|
| `INVALID_CURSOR` | 400 | The paging cursor is invalid. | `news.logic.ts` |
| `INVALID_NEWS_IMAGE` | 400, 422 | An image is not one of the tenant's news images (400), or the remote address is not a JPEG, PNG, WebP or GIF image (422). | `news.logic.ts`, `news.service.ts`, `news-remote-image.logic.ts` |
| `INVALID_NEWS_IMAGE_URL` | 400 | The remote image address is not allowed. | `news-remote-image.logic.ts` |
| `NEWS_IMAGE_FETCH_FAILED` | 422 | The remote image could not be fetched. | `news-remote-image.logic.ts` |
| `NEWS_IMAGE_FETCH_TIMEOUT` | 504 | Fetching the remote image took too long. | `news-remote-image.logic.ts` |
| `NEWS_IMAGE_TOO_LARGE` | 413 | The remote image is over 10 MB. | `news-remote-image.logic.ts` |
| `NEWS_ASSET_INVALID` | 409 | An article image is invalid or expired. | `news.service.ts` |
| `NEWS_ASSET_NOT_PENDING` | 409 | The image does not exist or is already attached. | `news.service.ts` |
| `NEWS_NOT_FOUND` | 404 | The article does not exist. | `news.service.ts` |
| `NEWS_VERSION_CONFLICT` | 409 | The article changed meanwhile; reload. | `news.service.ts` |

### course-authoring (`modules/course-authoring`)

| Code | Status | Meaning | Raised in |
|---|---|---|---|
| `COURSE_ASSET_STORAGE_SIZE_LIMIT` | 413 | The course file is over the storage size limit. | `course-authoring.controller.ts` |
| `COURSE_BLOCK_DATA_INVALID` | 400 | The component data is invalid: a media quiz, image-choice question or scenario conversation on block create or edit (text that is not JSON reads as "phải là object"), or a diagram on studio submit. The message is the sanitizer's or the diagram normalizer's own Vietnamese text. Nothing is saved. The AI ID apply and workspace keep their own diagram errors. | `course-block-input.logic.ts` (`courseBlockDataInvalid`), `course-outline.service.ts` (studio submit diagrams) |
| `LESSON_AUTHOR_OUTLINE_BUSY` | 409 | The course is being changed elsewhere; retry. | `course-authoring.service.ts` |
| `COMPONENT_APPLY_INSTANCE_INVALID`, `COMPONENT_APPLY_IDENTITY_AMBIGUOUS`, `COMPONENT_APPLY_IDENTITY_CONFLICT`, `COMPONENT_APPLY_PROTECTED_INSTANCE`, `COMPONENT_APPLY_TARGET_REUSED`, `COMPONENT_APPLY_PARITY_FAILED` | 409 | An AI ID component proposal could not be applied in full; nothing was saved. | `lesson-author-component-apply.logic.ts`, answered by `course-authoring.service.ts` |
| `COURSE_AUTHOR_NOTES_TENANT_REQUIRED` | 403 | The active organization is unknown. | `course-authoring.controller.ts` (`getAuthorNotes`) |
| `COURSE_AUTHOR_NOTES_COURSE_INVALID` | 400 | The course id is invalid. | same |
| `COURSE_AUTHOR_NOTES_COURSE_NOT_FOUND` | 404 | The course does not exist in the tenant. | same |
| `COURSE_AUTHOR_NOTES_UNAVAILABLE` | 500 | The AI ID author notes could not be loaded. | same |

Course publish governance (`course-publish-governance.repository.ts`,
`.controller.ts`, `course-authoring.controller.ts`). The controller also uses
some of these codes with status 400 for invalid input.

| Code | Status | Meaning |
|---|---|---|
| `COURSE_PUBLISH_GOVERNANCE_UNAVAILABLE` | 503 | Publish governance is not enabled or not ready. |
| `COURSE_PUBLISH_GOVERNANCE_REQUIRED` | 409 | The course must be published through its current review candidate. |
| `COURSE_PUBLISH_CANDIDATE_REQUIRED` | 409 | Create or choose a review candidate first. |
| `COURSE_PUBLISH_CANDIDATE_NOT_FOUND` | 404 | The review candidate does not exist. |
| `COURSE_PUBLISH_CANDIDATE_EXPIRED` | 409 | The review candidate expired. |
| `COURSE_PUBLISH_CANDIDATE_STALE` | 409 | Content or structure changed since the candidate was made. |
| `COURSE_PUBLISH_CANDIDATE_INVALID` | 400 | The candidate data is invalid. |
| `COURSE_PUBLISH_CANDIDATE_AUTHORITY_INVALID` | 403 | Not allowed to create a candidate for this course. |
| `COURSE_PUBLISH_CANDIDATE_MANIFEST_INCOMPLETE` | 409 | The candidate does not record all dependent content. |
| `COURSE_PUBLISH_POLICY_CHANGED` | 409 | The publish policy changed; make a new candidate. |
| `COURSE_PUBLISH_POLICY_INVALID` | 400 | The publish policy is invalid. |
| `COURSE_PUBLISH_POLICY_DOWNGRADE_FORBIDDEN` | 409 | An HSE course policy cannot be downgraded. |
| `COURSE_PUBLISH_POLICY_FORBIDDEN` | 403 | Not allowed to change the publish policy. |
| `COURSE_PUBLISH_APPROVAL_REQUIRED` | 409 | The assigned expert must approve the candidate. |
| `COURSE_PUBLISH_APPROVAL_FORBIDDEN` | 403 (400) | Not eligible to approve this scope (400: invalid approval input). |
| `COURSE_PUBLISH_APPROVAL_CONFLICT` | 409 | The candidate already has another approval decision. |
| `COURSE_PUBLISH_REVIEWER_INELIGIBLE` | 422 (400) | The reviewer lacks the scope or view rights (400: invalid reviewer input). |
| `COURSE_PUBLISH_QUALITY_RECEIPT_STALE` | 422 | The quality receipt no longer matches the content. |
| `COURSE_PUBLISH_ASSESSMENT_REVIEW_REQUIRED` | 422 | Assessment review items are still open. |
| `COURSE_PUBLISH_CRITICAL_FINDINGS_UNRESOLVED` | 422 | Critical findings are still open. |
| `COURSE_PUBLISH_COMMIT_INVALID` | 409 | Content changed during publishing; nothing was published. |
| `COURSE_PUBLISH_COMMIT_RECEIPT_MISSING` | 409 | The publish transaction lacks its confirmation receipt. |
| `COURSE_PUBLISH_RECEIPT_MISSING` | 409 | The candidate was published but lacks its receipt. |
| `COURSE_PUBLISH_FORBIDDEN` | 403 | Not allowed to publish this course. |
| `COURSE_PUBLISH_ASSIGNMENT_FORBIDDEN` | 403 (400) | Not allowed to assign reviewers (400: invalid assignment id). |
| `COURSE_PUBLISH_ASSIGNMENT_TRANSITION_INVALID` | 409 | The reviewer assignment cannot move to that state. |

### library (`modules/library`)

| Code | Status | Meaning | Raised in |
|---|---|---|---|
| `LIBRARY_FILE_TOO_LARGE` | 413 | One uploaded file is over the per-file limit (`LIBRARY_DOCUMENT_MAX_UPLOAD_MB`). The upload answer stays 201 and lists the file in `errors` with a text that states the limit and the file's size. A request multer already refuses gets 413 `PAYLOAD_TOO_LARGE` from the route, with the limit in its message. | `library.controller.ts` (`libraryFileTooLargeError`) |

### Refused request bodies

A body that is not a JSON object (no body, a list, text), a required text that
is missing or blank, a field of the wrong type or a text longer than its
column. Status 400, a fixed Vietnamese message naming what to fix (sent as
`error` too), and nothing is read or written. Text limits are the columns'
`VARCHAR(n)`, counted in characters as Postgres counts them
(`utils/text-length.ts`). A missing field the route already answered keeps its
earlier answer (for example `course_id và title là bắt buộc`).

| Code | Routes | Raised in |
|---|---|---|
| `COURSE_CATEGORY_INPUT_INVALID` | `POST /api/course-categories` (name required, at most 200 characters; description text; sort order an integer) | `course-categories.validator.ts` |
| `NOTIFICATION_INPUT_INVALID` | `POST /api/notifications` (title at most 500 characters; course, title and message text) | `notifications.validator.ts` |
| `ENROLLMENT_INPUT_INVALID` | `POST /api/enrollments` (course id text), `DELETE /api/enrollments` (learner id a UUID, course id text; a missing one keeps `user_id and course_id are required`) | `enrollments.validator.ts` |
| `PROFILE_INPUT_INVALID` | `PATCH /api/users/profile`, `PATCH /api/auth/profile` (name 255, phone 20, country 10, language 10 characters; year of birth an integer; on the auth route gender and education one of the database values or empty) | `users.validator.ts`, `auth.validator.ts` |
| `PASSWORD_INPUT_INVALID` | `POST /api/auth/change-password`, `POST /api/users/profile/change-password` (passwords text) | `auth.validator.ts` |
| `HELP_DOC_INPUT_INVALID` | `POST /api/help-docs/folders`, `PATCH /api/help-docs/folders/:id`, `POST /api/help-docs/pages`, `PATCH /api/help-docs/pages/:id` (title required on create; folder title 200, icon 100, page title 500 characters; folder id a UUID; content text; published a boolean), `PATCH /api/help-docs/folders/reorder`, `PATCH /api/help-docs/pages/reorder` (a JSON object; folder id and every `ordered_ids` item a UUID, at most 1000 ids; a missing folder or an `ordered_ids` that is not a list keeps its earlier answer) | `help-docs.validator.ts` |
| `EMAIL_TEMPLATE_INPUT_INVALID` | `PUT /api/email-templates/:key` (a JSON object; each field keeps the service's own checks) | `email-templates.validator.ts` |
| `TEAM_COURSE_CATEGORY_IDS_INVALID` | `POST /api/groups/teams/:teamId/course-categories` (a JSON object; every `category_ids` item a UUID, at most 500; a `category_ids` that is not a list keeps `category_ids phải là mảng`) | `groups.validator.ts` |
| `TEAM_DOCUMENT_CATEGORY_IDS_INVALID` | `POST /api/groups/teams/:teamId/categories` (a JSON object; at most 500 `category_ids` items; every text item a UUID once trimmed, while an item that is not text or is blank is skipped as before; a `category_ids` that is not a list keeps `category_ids phải là mảng`) | `groups.validator.ts` |

### Other modules

assignments, audit-logs, badges, branding (and dashboard content), course-categories,
course-deletion, courses, deletion, demo-login,
email-templates, enrollments, groups, help-docs, library, metrics, modules,
notifications, permissions, prompt-templates, storage, tenant-badges,
tenants, welcome-init and the workers raise `AppError` without codes of their
own (or answer through `sendError`), so they send the codes of their status,
apart from the refused request bodies above.
The storage proxy sends `BAD_REQUEST` (invalid path), `NOT_FOUND`,
`BAD_GATEWAY` and `INTERNAL_ERROR`; its 416 range refusal has no body.
`GET /internal/metrics` answers 401 with plain text (a Prometheus scrape, not
JSON).

### Internal codes (never sent as they are)

- `COURSE_PUBLISH_GOVERNANCE_SCHEMA_*` (`MISSING`, `ACCESS_INVALID`,
  `GUARD_DRIFT`, `TRIGGER_DRIFT`, `UNAVAILABLE`): the publish governance
  schema check (`course-publish-governance-schema.repository.ts`).
- `AI_CREDIT_PERIOD_INVALID` (`ai-credit.logic.ts`) and
  `COURSE_AUTHOR_NOTES_INVALID` (`course-author-notes.logic.ts`): `Error`
  messages of pure functions; callers validate first.

## Modules other lanes are restructuring

`modules/ai-chatbot`, `modules/reports` and `modules/learner` are being moved
or refactored in parallel lanes; their codes are not reviewed here. Through
the shared layers above, every error body they send through the global
handler, `sendError` or `sendClientError` already carries a code. Their
hand-written HTTP error bodies carry one too: the lesson author apply refusal
(`chat.controller.ts`) gets the code of its status when its AppError has none,
and the last plain-object throw (`ai-report/report-date.logic.ts`, an invalid
comparison range) is a `ReportRequestError` (400, same message, no code of its
own, so `BAD_REQUEST`). The chat stream's SSE `error` events are events, not
error bodies, and are unchanged (a `code` only when the error has one).

Inventory from an AST scan of `src` (2026-10-19): codes raised with a status
(`new AppError`, a `[status, vi, en]` table, a `{ code }` body). Keys of three
tables go out with a prefix (`CHAT_COURSE_`, `KB_FAQ_SHEET_`,
`LESSON_AUTHOR_SESSION_`), shown with it. About 190 more codes in these
modules belong to internal error classes (worker, schema and contract errors)
that controllers map before answering; the owning lane should list the ones
that reach a response, with their meaning.

| File | Codes and statuses |
|---|---|
| `ai-chatbot/ai-rag-client.service.ts` | `AI_RAG_SERVICE_AUTH_NOT_CONFIGURED` 503, `AI_RAG_SERVICE_HMAC_NOT_CONFIGURED` 503, `AI_RAG_SERVICE_NOT_CONFIGURED` 503, `AI_RAG_SERVICE_TIMEOUT` 504, `AI_RAG_SERVICE_UNAVAILABLE` 503, `ORCHESTRATION_V2_DISPATCH_FENCE_REQUIRED` 500, `ORCHESTRATION_V2_SOURCE_AUTHORITY_CHANGED` 409, `ORCHESTRATION_V2_SOURCE_CURSOR_INVALID` 422, `ORCHESTRATION_V2_SOURCE_CURSOR_STALLED` 422, `ORCHESTRATION_V2_SOURCE_EMPTY` 422, `ORCHESTRATION_V2_SOURCE_PAGE_LIMIT` 422 |
| `ai-chatbot/ai-report.service.ts` | `AI_PRICING_MODEL_INVALID` 400, `AI_PRICING_RATE_INVALID` 400, `AI_PRICING_SOURCE_NOTE_INVALID` 400, `AI_PRICING_SOURCE_URL_INVALID` 400 |
| `ai-chatbot/ai-settings.service.ts` | `AI_EMBEDDING_DIMENSION_INVALID` 400, `AI_ENGINE_INVALID` 400, `AI_ENGINE_TRANSITION_ACTIVE` 409, `AI_PROVIDER_KEY_MISSING` 400, `AI_SETTINGS_NOT_FOUND` 404 |
| `ai-chatbot/ai-token-quota.service.ts` | `AI_CREDIT_LIMIT_REACHED` 429, `AI_TOKEN_USAGE_NOT_FOUND` 404 |
| `ai-chatbot/chat-course-scope.service.ts` | `CHAT_COURSE_NOT_AVAILABLE` 404 |
| `ai-chatbot/chat-stream-lock.ts` | `GENERATION_LOCK_UNAVAILABLE` 503 |
| `ai-chatbot/chat.controller.ts` | `AI_BUSY`, `LESSON_AUTHOR_ACTION_INVALID` 400 |
| `ai-chatbot/chat.service.ts` | `AI_CHAT_TIMEOUT` 504, `AI_RAG_KB_NOT_ASSIGNED` 400/409, `CHAPTER_BUDGET_CAPACITY_EXCEEDED` 409, `CHAPTER_COMPONENT_NOT_ALLOWED` 403, `CHAPTER_RESERVATION_CHANGED` 409, `CHAT_LOCK_UNAVAILABLE` 503, `GENERATION_ALREADY_ACTIVE` 409, `GENERATION_FORBIDDEN` 403, `GENERATION_INPUT_INVALID` 400, `GENERATION_INPUT_REJECTED` 400, `GENERATION_RESERVATION_LIFETIME_INVALID` 503, `LESSON_AUTHOR_APPLY_IN_PROGRESS` 409, `LESSON_AUTHOR_BLUEPRINT_ARCHITECTURE_REQUIRED` 409, `LESSON_AUTHOR_BLUEPRINT_CHAPTER_SEQUENCE` 409, `LESSON_AUTHOR_BLUEPRINT_INVALID` 502, `SOURCE_CHAPTER_POLICY_INVALID` 422, `SOURCE_SCOPE_INCOMPLETE` 400, `V5_LEARNING_BLOCK_CARDINALITY_INVALID` 422, `V5_UNIT_OBJECTIVE_REFS_INVALID` 422 |
| `ai-chatbot/input-filter/input-filter.schema.ts` | `BINARY_GARBAGE`, `REPEATED_SENTENCE`, `TOO_LONG`, `TOO_SHORT`, `UNSUPPORTED_LANG` |
| `ai-chatbot/kb-document-deletion.logic.ts` | `KB_DOCUMENT_DELETE_CONFLICT` 409, `KB_DOCUMENT_DELETE_FAILED` 500, `KB_DOCUMENT_IN_USE_BY_AI_ID` 409 (single and bulk delete of a document an active AI ID run designs from; `document_ids`; a bulk request is refused as a whole) |
| `ai-chatbot/chat/kb-usage.service.ts` (`PUT /bots/assignments`, `PUT /lesson-author/kb-assignment`, `PUT /bots/:id` with `kb_id`) | `AI_CHATBOT_KB_ALREADY_USED` 409 (the admin page bot, the learner page bot and AI ID need three different knowledge bases; sendError shape, message names where it is used) |
| `ai-chatbot/kb-faq-sheet.logic.ts` | `KB_FAQ_SHEET_TOO_COMPLEX` 422, `KB_FAQ_SHEET_TOO_LARGE` 413 |
| `ai-chatbot/kb-source-download-url.logic.ts` | `KB_SOURCE_PATH_INVALID` 422, `KB_SOURCE_SIGNED_URL_FAILED` 503 |
| `ai-chatbot/kb.controller.ts` | `KB_DOCUMENT_LEARNING` 409 |
| `ai-chatbot/lesson-author-chapter-runtime.service.ts` | `CHAPTER_CHECKPOINT_SCHEMA_INVALID` 503, `CHAPTER_CHECKPOINT_UNAVAILABLE` 503 |
| `ai-chatbot/lesson-author-durable-blueprint.service.ts` | `GENERATION_IDENTIFIER_INVALID` 400, `GENERATION_WORKER_UNAVAILABLE` 503 |
| `ai-chatbot/lesson-author-idm-preserve.logic.ts` | `PRESERVE_UNIT_SHAPE` |
| `ai-chatbot/lesson-author-idm-unit.logic.ts` | `IDM_HTML_DENSITY_EXCEEDED`, `IDM_HTML_VISIBLE_TEXT_INVALID` |
| `ai-chatbot/lesson-author-orchestration-v2-unit.logic.ts` | `HTML_INSTRUCTIONAL_DENSITY_EXCEEDED`, `NORMALIZATION_INSTANCE`, `NORMALIZATION_SHAPE`, `PUBLICATION_TOO_LARGE`, `RESPONSE_COMPONENT_IDENTITY`, `RESPONSE_FACT_IDS` |
| `ai-chatbot/lesson-author-pedagogical-validator.logic.ts` | `LESSON_ASSESSMENT_COMPLETENESS`, `OBJECTIVE_NOT_TAUGHT`, `UNIT_CONTENT_PENDING` |
| `ai-chatbot/lesson-author-session-access.logic.ts` | `LESSON_AUTHOR_SESSION_COURSE_EDIT_REQUIRED` 403, `LESSON_AUTHOR_SESSION_CURSOR_INVALID` 400, `LESSON_AUTHOR_SESSION_DELETE_NOT_FOUND` 404, `LESSON_AUTHOR_SESSION_HAS_APPLIED` 409, `LESSON_AUTHOR_SESSION_INPUT_INVALID` 400, `LESSON_AUTHOR_SESSION_MANAGE_FORBIDDEN` 403, `LESSON_AUTHOR_SESSION_NOT_FOUND` 404, `LESSON_AUTHOR_SESSION_NOT_OWNER` 403 |
| `ai-chatbot/lesson-author-source-upload.controller.ts` | `FILE_REQUIRED` 400, `FILE_TOO_LARGE` 413, `FILE_TYPE_UNSUPPORTED` 400, `NOT_DEPLOYED` 409, `NOT_READY` 409 |
| `ai-chatbot/ai-id/org-context/lesson-author-org-context.controller.ts` (organization context, `/chat/lesson-author/org-context`) | `ORG_CONTEXT_DISABLED` 404, `ORG_CONTEXT_INPUT_INVALID` 400, `ORG_CONTEXT_FILE_INVALID` 400 (missing file, type, over 50 MB), `ORG_CONTEXT_LIMIT_REACHED` 409 (`details: {used_bytes, limit_bytes}`), `ORG_CONTEXT_NOT_DEPLOYED` 409, `ORG_CONTEXT_NOT_READY` 409, `ORG_CONTEXT_REVISION_CONFLICT` 409, `ORG_CONTEXT_NO_LEARNED_DOCUMENTS` 409, `ORG_CONTEXT_DISTILL_RUNNING` 409, `ORG_CONTEXT_PROFILE_INVALID` 422 (`details: {path, reason}`), `ORG_CONTEXT_VERSION_NOT_FOUND` 404, `ORG_CONTEXT_DOCUMENT_NOT_FOUND` 404, `KB_DOCUMENT_LEARNING` 409, `TENANT_DATA_LIMIT_REACHED` 409, `TENANT_DATA_QUOTA_RECONCILING` 503, `AI_CREDIT_LIMIT_REACHED` 429, `ORG_CONTEXT_UNAVAILABLE` 503 |
| `ai-chatbot/ai-id/workspace/launch/lesson-author-workspace-launch.controller.ts` (`use_organization_context`) | `ORG_CONTEXT_NOT_APPLICABLE` 422, `ORG_CONTEXT_NOT_CONFIRMED` 409 (final refusals: the author changes the switch or confirms the profile) |
| `ai-chatbot/lesson-author-transcription.service.ts` | `LESSON_AUTHOR_CONVERSATION_NOT_FOUND` 404, `TRANSCRIPTION_KB_CHANGED` 409, `TRANSCRIPTION_NOT_FOUND` 404, `TRANSCRIPTION_NOT_READY` 409, `VIDEO_FILE_NAME_INVALID` 400, `VIDEO_SIZE_INVALID` 400, `VIDEO_TYPE_UNSUPPORTED` 400 |
| `ai-chatbot/lesson-author-workspace-apply.controller.ts` | `AUTH_REQUIRED` 401, `WORKSPACE_APPLY_CONFLICT` 409, `WORKSPACE_APPLY_COURSE_BUSY` 409, `WORKSPACE_APPLY_COURSE_EDITED` 409, `WORKSPACE_APPLY_COURSE_STRUCTURE_CHANGED` 409, `WORKSPACE_APPLY_DISABLED` 503, `WORKSPACE_APPLY_FORBIDDEN` 403, `WORKSPACE_APPLY_INPUT_INVALID` 400, `WORKSPACE_APPLY_NOT_READY` 409, `WORKSPACE_APPLY_UNAVAILABLE` 503, `WORKSPACE_APPLY_VALIDATION_FAILED` 422 |
| `ai-chatbot/lesson-author-workspace-component.logic.ts` | `WORKSPACE_COMPONENT_COVERAGE_INVALID`, `WORKSPACE_FAQ_NOT_LAST` |
| `ai-chatbot/lesson-author-workspace-content.repository.ts` | `WORKSPACE_UNIT_CONTENT_PENDING` |
| `ai-chatbot/lesson-author-workspace-edit.controller.ts` | `WORKSPACE_EDIT_DISABLED` 503, `WORKSPACE_EDIT_FORBIDDEN` 403, `WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT` 409, `WORKSPACE_EDIT_INPUT_INVALID` 400, `WORKSPACE_EDIT_NOT_FOUND` 404, `WORKSPACE_EDIT_STATE_INVALID` 409, `WORKSPACE_EDIT_UNAVAILABLE` 503, `WORKSPACE_EDIT_VALIDATION_REQUIRED` 422, `WORKSPACE_NODE_NOT_READY` 409, `WORKSPACE_REVISION_CONFLICT` 409, `WORKSPACE_SOURCE_CHANGED` 409 |
| `ai-chatbot/lesson-author-workspace-read.controller.ts` | `WORKSPACE_EVENT_RESNAPSHOT_REQUIRED` 409, `WORKSPACE_NODE_NOT_FOUND` 404, `WORKSPACE_NOT_FOUND` 404, `WORKSPACE_READ_CONTRACT_INVALID` 500, `WORKSPACE_READ_DISABLED` 503, `WORKSPACE_READ_FORBIDDEN` 403, `WORKSPACE_READ_INPUT_INVALID` 400, `WORKSPACE_READ_UNAVAILABLE` 503 |
| `ai-chatbot/lesson-author-workspace-runtime.service.ts` | `WORKSPACE_EXECUTION_DISABLED` 503, `WORKSPACE_RUNTIME_NOT_READY` 503 |
| `ai-chatbot/lesson-author-workspace-work-item.repository.ts` | `WORKSPACE_WORK_ITEM_LEASE_EXPIRED` |
| `ai-chatbot/report-chat-error.logic.ts` | `REPORT_DATA_UNAVAILABLE` 503, `REPORT_FILTER_DATE_INVALID` 400, `REPORT_FILTER_RANGE_INCOMPLETE` 400, `REPORT_FILTER_RANGE_REVERSED` 400, `REPORT_FILTER_RANGE_TOO_LONG` 400, `REPORT_FILTER_UNIT_INVALID` 400, `REPORT_FILTERS_INVALID` 400, `REPORT_PERMISSION_CHECK_FAILED` 500 |
| `ai-chatbot/report-chat.service.ts` | `REPORT_RANGE_INVALID` 400 |
| `ai-chatbot/report-pdf.controller.ts` | `AI_CREDIT_LIMIT_REACHED` 429 (new export while the AI points are spent), `REPORT_PDF_ARTIFACT_TOO_LARGE` 413, `REPORT_PDF_AUDIT_FAILED` 503, `REPORT_PDF_DEMO_SESSION` 403, `REPORT_PDF_EXPORT_EXPIRED` 410, `REPORT_PDF_EXPORT_FAILED` 500, `REPORT_PDF_INVALID_REQUEST` 400, `REPORT_PDF_JOB_NOT_FOUND` 404, `REPORT_PDF_NOT_FOUND` 404, `REPORT_PDF_NOT_READY` 409, `REPORT_PDF_PERMISSION_DENIED` 403, `REPORT_PDF_QUEUE_FULL` 429, `REPORT_PDF_RATE_LIMITED` 429, `REPORT_PDF_RENDER_BUSY` 429, `REPORT_PDF_RENDER_TIMEOUT` 504, `REPORT_PDF_RENDERER_UNAVAILABLE` 503, `REPORT_PDF_SCOPE_DENIED` 403, `REPORT_PDF_SNAPSHOT_UNAVAILABLE` 409, `REPORT_PDF_STORAGE_FAILED` 503 |
| `reports/report-access.service.ts` | `REPORT_SCOPE_FORBIDDEN` 403, `REPORT_SCOPE_INVALID` 400, `REPORT_SCOPE_REQUIRED` 400 |
| `reports/reports.controller.ts` | `REPORT_SUMMARY_REFRESH_FAILED`, `REPORTS_BUSY`, `REPORT_SEARCH_INVALID` 400 (a repeated `search` on the learner lists and learner detail) |
| `learner/learner.controller.ts` | `LEARNER_COURSE_IDS_INVALID` 400 (a repeated `courseIds` on `progress-batch`) |
