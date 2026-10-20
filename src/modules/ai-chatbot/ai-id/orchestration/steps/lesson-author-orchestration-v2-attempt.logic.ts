export const ORCHESTRATION_V2_ATTEMPT_TRACE_MAX_EVENTS = 64;

export type OrchestrationV2AttemptOutcome =
  | 'started' | 'succeeded' | 'failed' | 'retrying' | 'fallback' | 'unknown' | 'requeued';
export type OrchestrationV2AttemptUsageSource = 'provider_reported' | 'estimated' | 'unknown';
export type OrchestrationV2InvocationKind = 'writer' | 'evaluator' | 'repair' | 'deterministic';

export interface OrchestrationV2AttemptTraceEvent {
  sequence: number;
  invocation_kind: OrchestrationV2InvocationKind;
  invocation_index: number;
  provider_attempt: number | null;
  phase: string;
  outcome: OrchestrationV2AttemptOutcome;
  event_code: string;
  failure_stage: string | null;
  failure_code: string | null;
  failure_path: string | null;
  provider_dispatched: boolean;
  usage_source: OrchestrationV2AttemptUsageSource;
  observed_usage: Readonly<Record<string, number>>;
  duration_ms: number;
  diagnostics: Readonly<Record<string, string | number | boolean | null>>;
}

const INVOCATION_KINDS = new Set<OrchestrationV2InvocationKind>(['writer', 'evaluator', 'repair', 'deterministic']);
const OUTCOMES = new Set<OrchestrationV2AttemptOutcome>(
  ['started', 'succeeded', 'failed', 'retrying', 'fallback', 'unknown', 'requeued'],
);
const USAGE_SOURCES = new Set<OrchestrationV2AttemptUsageSource>(['provider_reported', 'estimated', 'unknown']);
const TRACE_KEYS = new Set([
  'sequence', 'invocation_kind', 'invocation_index', 'provider_attempt', 'phase', 'outcome', 'event_code',
  'failure_stage', 'failure_code', 'failure_path', 'provider_dispatched', 'usage_source', 'observed_usage', 'duration_ms', 'diagnostics',
]);
const OBSERVED_USAGE_KEYS = new Set(['provider_input_tokens', 'provider_output_tokens', 'provider_total_tokens']);
const DIAGNOSTIC_KEYS = new Set([
  'provider_http_status', 'provider_status', 'provider_error_category',
  'provider_schema_constraint', 'provider_finish_reason',
]);
const LOWER_TOKEN = /^[a-z][a-z0-9_]{0,95}$/;
const FAILURE_TOKEN = /^[A-Z][A-Z0-9_]{0,99}$/;
const FAILURE_PATH = /^[A-Za-z0-9_.:[\]-]{1,256}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value
  && typeof value === 'object' && !Array.isArray(value);
const safeInt = (value: unknown, min: number, max: number) => Number.isSafeInteger(value)
  && Number(value) >= min && Number(value) <= max;

/**
 * Admit only bounded operational metadata from the AI service. Prompts, source
 * text, model output and arbitrary provider payloads are deliberately rejected.
 */
export function readOrchestrationV2AttemptTrace(value: unknown): OrchestrationV2AttemptTraceEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ORCHESTRATION_V2_ATTEMPT_TRACE_MAX_EVENTS) {
    throw new Error('ORCHESTRATION_V2_ATTEMPT_TRACE_INVALID');
  }
  return value.map((raw, index) => {
    if (!isRecord(raw) || Object.keys(raw).some(key => !TRACE_KEYS.has(key))
      || raw.sequence !== index + 1 || !safeInt(raw.invocation_index, 1, 64)
      || !INVOCATION_KINDS.has(raw.invocation_kind as OrchestrationV2InvocationKind)
      || !(raw.provider_attempt === null || safeInt(raw.provider_attempt, 1, 8))
      || typeof raw.phase !== 'string' || !LOWER_TOKEN.test(raw.phase)
      || !OUTCOMES.has(raw.outcome as OrchestrationV2AttemptOutcome)
      || typeof raw.event_code !== 'string' || !LOWER_TOKEN.test(raw.event_code)
      || !(raw.failure_stage === null || (typeof raw.failure_stage === 'string' && LOWER_TOKEN.test(raw.failure_stage)))
      || !(raw.failure_code === null || (typeof raw.failure_code === 'string' && FAILURE_TOKEN.test(raw.failure_code)))
      || !(raw.failure_path === null || (typeof raw.failure_path === 'string' && FAILURE_PATH.test(raw.failure_path)))
      || typeof raw.provider_dispatched !== 'boolean'
      || !USAGE_SOURCES.has(raw.usage_source as OrchestrationV2AttemptUsageSource)
      || !safeInt(raw.duration_ms, 0, 3_600_000)
      || !isRecord(raw.observed_usage) || Object.keys(raw.observed_usage).some(key => !OBSERVED_USAGE_KEYS.has(key))
      || Object.values(raw.observed_usage).some(count => !safeInt(count, 0, Number.MAX_SAFE_INTEGER))
      || !isRecord(raw.diagnostics) || Object.keys(raw.diagnostics).some(key => !DIAGNOSTIC_KEYS.has(key))
      || Object.values(raw.diagnostics).some(item => item !== null
        && !['string', 'number', 'boolean'].includes(typeof item))
      || JSON.stringify(raw.diagnostics).length > 2_048) {
      throw new Error('ORCHESTRATION_V2_ATTEMPT_TRACE_INVALID');
    }
    if (raw.outcome === 'failed' && (!raw.failure_stage || !raw.failure_code)) {
      throw new Error('ORCHESTRATION_V2_ATTEMPT_TRACE_INVALID');
    }
    if (raw.outcome === 'fallback' && (!raw.failure_stage || !raw.failure_code)) {
      throw new Error('ORCHESTRATION_V2_ATTEMPT_TRACE_INVALID');
    }
    if (!['failed', 'fallback'].includes(raw.outcome as string)
      && (raw.failure_stage !== null || raw.failure_code !== null || raw.failure_path !== null)) {
      throw new Error('ORCHESTRATION_V2_ATTEMPT_TRACE_INVALID');
    }
    const observedUsage = Object.fromEntries(Object.entries(raw.observed_usage).map(([key, count]) => [key, Number(count)]));
    return Object.freeze({
      sequence: Number(raw.sequence),
      invocation_kind: raw.invocation_kind as OrchestrationV2InvocationKind,
      invocation_index: Number(raw.invocation_index),
      provider_attempt: raw.provider_attempt === null ? null : Number(raw.provider_attempt),
      phase: raw.phase,
      outcome: raw.outcome as OrchestrationV2AttemptOutcome,
      event_code: raw.event_code,
      failure_stage: raw.failure_stage as string | null,
      failure_code: raw.failure_code as string | null,
      failure_path: raw.failure_path as string | null,
      provider_dispatched: raw.provider_dispatched,
      usage_source: raw.usage_source as OrchestrationV2AttemptUsageSource,
      observed_usage: Object.freeze(observedUsage),
      duration_ms: Number(raw.duration_ms),
      diagnostics: Object.freeze({ ...raw.diagnostics }) as OrchestrationV2AttemptTraceEvent['diagnostics'],
    });
  });
}
