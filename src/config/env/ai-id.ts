// Env: AI ID — lesson-author feature flags, orchestration V2, the IDM
// pipeline, course publish governance and video transcription (part of `env`, see ../env.ts).
// Tests of src/modules/ai-chatbot read the text of this file to check that the
// rollout gates below stay off by default.

import './load.js';
import { optionalBoolean, optionalBoundedInt, optionalOneOf, optionalString, optionalUuidCsv } from './helpers.js';

export const aiIdEnv = {
  // AI ID default-off rollout gates.
  // Read-only durable-job API. Does not enable enqueue or start any worker.
  LESSON_AUTHOR_GENERATION_STATUS_ENABLED: optionalBoolean('LESSON_AUTHOR_GENERATION_STATUS_ENABLED', false),
  // Reads only; does not enable workspace admission, generation, editing or Apply.
  LESSON_AUTHOR_WORKSPACE_READ_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_READ_ENABLED', false),
  // Save/Reset only. Requires reads too; never enables admission, workers or Apply.
  LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED', false),
  // Enables durable self-built-RAG Blueprint admission and its bounded worker.
  LESSON_AUTHOR_GENERATION_ENABLED: optionalBoolean('LESSON_AUTHOR_GENERATION_ENABLED', false),


  // Authenticated metadata-only server push. It is separately gated from all
  // generation/edit/Apply behavior and requires the manual SQL notification
  // trigger to have been installed before production enablement.
  LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED', false),
  // Re-authenticate long-lived metadata streams periodically without forcing
  // every open modal to reconnect twice per minute at production scale.
  LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS',
    300_000,
    60_000,
    900_000,
  ),
  LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED', false),
  // Draft-only course Apply. Requires READ, EDIT and EXECUTION plus the
  // installed workspace execution schema; this flag is intentionally separate
  // so a worker rollout can never publish course blocks by accident.
  LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED', false),
  // CP5 candidate/approval APIs and application-side publish handshake. The
  // reviewed SQL fence remains authoritative for every enrolled course.
  COURSE_PUBLISH_GOVERNANCE_ENABLED: optionalBoolean('COURSE_PUBLISH_GOVERNANCE_ENABLED', false),
  LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED: optionalBoolean('LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED', false),
  // Server-owned workspace launch switch. It admits durable V2 work in the API
  // transaction only when workspace execution is also enabled. Execution stays
  // isolated in a dedicated process with exactly one dispatcher/worker role.
  LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED: optionalBoolean(
    'LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED',
    false,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY',
    16,
    1,
    1_024,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY',
    4,
    1,
    128,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED: optionalBoolean('LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED', false),
  LESSON_AUTHOR_ORCHESTRATION_V2_ROLE: optionalOneOf('LESSON_AUTHOR_ORCHESTRATION_V2_ROLE', 'disabled', [
    'disabled',
    'dispatcher',
    'worker',
  ] as const),
  LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT',
    1,
    1,
    4_096,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX',
    0,
    0,
    4_095,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS',
    30,
    5,
    300,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS',
    8,
    1,
    100,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS',
    1_000,
    1,
    3_600_000,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS',
    60_000,
    1,
    86_400_000,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS',
    120,
    5,
    3_600,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE',
    25,
    1,
    500,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE',
    25,
    1,
    500,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS',
    1_000,
    100,
    300_000,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY',
    64,
    1,
    4_096,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY',
    8,
    1,
    4_096,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS',
    45_000,
    5_000,
    120_000,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS',
    30,
    5,
    45,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE',
    25,
    1,
    500,
  ),
  // AI ID IDM pipeline (spec §5.4). Admission-only switch: new V2 runs of allow-listed tenants
  // (empty list = every tenant) record the IDM runtime hash; running runs are never re-routed.
  LESSON_AUTHOR_IDM_PIPELINE_ENABLED: optionalBoolean('LESSON_AUTHOR_IDM_PIPELINE_ENABLED', false),
  LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST: optionalUuidCsv('LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST'),
  LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS',
    120_000,
    30_000,
    300_000,
  ),
  // Author "Stop" of a running AI ID V2 design (stop and keep what is done). Also needs the
  // workspace read, edit and execution gates. No SQL change; default off.
  LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED: optionalBoolean('LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED', false),

  // Lesson-author video transcription. The upload route streams to a private
  // bucket; these limits are enforced before expensive media processing.
  LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB: optionalBoundedInt('LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB', 500, 10, 2_048),
  LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS',
    10_800,
    30,
    21_600,
  ),
  LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS',
    2_000_000,
    1_000,
    5_000_000,
  ),
  LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS', 168, 1, 720),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: optionalBoolean('LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED', true),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS',
    10_000,
    1_000,
    300_000,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE',
    2,
    1,
    8,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY',
    1,
    1,
    4,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS',
    1_800,
    120,
    7_200,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS',
    3,
    1,
    12,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS',
    60,
    5,
    3_600,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt(
    'LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS',
    3_600,
    30,
    86_400,
  ),
  LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR: optionalString(
    'LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR',
    './tmp/lesson-author-transcription',
  ),
  FFMPEG_PATH: optionalString('FFMPEG_PATH', 'ffmpeg'),
  FFPROBE_PATH: optionalString('FFPROBE_PATH', 'ffprobe'),
  GEMINI_TRANSCRIPTION_MODEL: optionalString('GEMINI_TRANSCRIPTION_MODEL', 'gemini-3.5-transcribe'),
} as const;
