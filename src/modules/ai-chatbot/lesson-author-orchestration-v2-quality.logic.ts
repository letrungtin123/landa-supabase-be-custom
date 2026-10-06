export type OrchestrationV2ContentOrigin =
  | 'provider_validated'
  | 'structured_fallback'
  | 'raw_source_fallback';

export type OrchestrationV2QualityState = 'validated' | 'review_required';

export interface OrchestrationV2QualityPolicy {
  has_envelope: boolean;
  evidence_valid: boolean;
  course_applicable: boolean;
  content_origin: OrchestrationV2ContentOrigin | null;
  quality_state: OrchestrationV2QualityState | null;
}

const CONTENT_ORIGINS = new Set<OrchestrationV2ContentOrigin>([
  'provider_validated', 'structured_fallback', 'raw_source_fallback',
]);
const QUALITY_STATES = new Set<OrchestrationV2QualityState>(['validated', 'review_required']);

/**
 * One compatibility policy for generated-unit quality envelopes at every V2
 * boundary. Missing envelopes are admitted only for pre-envelope artifacts.
 * Raw-source fallback is valid evidence for a reviewable workspace, but it is
 * never learner-ready course content.
 */
export function orchestrationV2QualityPolicy(value: {
  content_origin?: unknown;
  quality_state?: unknown;
}): Readonly<OrchestrationV2QualityPolicy> {
  const hasEnvelope = value.content_origin !== undefined || value.quality_state !== undefined;
  if (!hasEnvelope) return Object.freeze({ has_envelope: false, evidence_valid: true,
    course_applicable: true, content_origin: null, quality_state: null });

  const contentOrigin = CONTENT_ORIGINS.has(value.content_origin as OrchestrationV2ContentOrigin)
    ? value.content_origin as OrchestrationV2ContentOrigin : null;
  const qualityState = QUALITY_STATES.has(value.quality_state as OrchestrationV2QualityState)
    ? value.quality_state as OrchestrationV2QualityState : null;
  const evidenceValid = contentOrigin !== null && qualityState !== null && (
    contentOrigin === 'provider_validated'
      && (qualityState === 'validated' || qualityState === 'review_required')
    || contentOrigin === 'structured_fallback'
      && (qualityState === 'validated' || qualityState === 'review_required')
    || contentOrigin === 'raw_source_fallback' && qualityState === 'review_required'
  );
  return Object.freeze({ has_envelope: true, evidence_valid: evidenceValid,
    course_applicable: evidenceValid && contentOrigin !== 'raw_source_fallback',
    content_origin: contentOrigin, quality_state: qualityState });
}
