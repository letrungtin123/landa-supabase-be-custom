export type LessonAuthorMediaDecisionStatus =
  | 'PROPOSED'
  | 'NOT_NEEDED'
  | 'SOURCE_GAP'
  | 'FAILED'
  | 'NOT_EVALUATED';

export interface LessonAuthorBlueprintMediaReview {
  version: 'media-review-v1';
  decisions: Array<{
    unit_path: string;
    status: LessonAuthorMediaDecisionStatus;
    reason_code: string;
  }>;
}

export interface LessonAuthorMediaReviewPlacement {
  unit_path: string;
  has_media_plan: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readBoundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

/**
 * Validate the additive media-review artifact without interpreting a missing
 * artifact as an evaluated NOT_NEEDED result. New evaluations must account
 * for each normalized unit path exactly once; old Blueprints omit the entire
 * artifact and remain NOT_EVALUATED to callers.
 */
export function normalizeLessonAuthorMediaReview(
  value: unknown,
  placements: readonly LessonAuthorMediaReviewPlacement[],
): LessonAuthorBlueprintMediaReview | null {
  if (value === undefined || value === null) return null;
  const raw = asRecord(value);
  if (raw.version !== 'media-review-v1' || !Array.isArray(raw.decisions)) {
    throw new Error('Blueprint media_review must use the media-review-v1 contract.');
  }
  const placementsByPath = new Map(placements.map(placement => [placement.unit_path, placement]));
  if (raw.decisions.length !== placementsByPath.size) {
    throw new Error('Blueprint media_review must contain one decision for every unit.');
  }
  const statuses = new Set<LessonAuthorMediaDecisionStatus>([
    'PROPOSED', 'NOT_NEEDED', 'SOURCE_GAP', 'FAILED', 'NOT_EVALUATED',
  ]);
  const seenPaths = new Set<string>();
  const decisions: LessonAuthorBlueprintMediaReview['decisions'] = [];
  for (const item of raw.decisions) {
    const decision = asRecord(item);
    const unitPath = readBoundedText(decision.unit_path, 160);
    const status = readBoundedText(decision.status, 32) as LessonAuthorMediaDecisionStatus | null;
    const reasonCode = readBoundedText(decision.reason_code, 80);
    const placement = unitPath ? placementsByPath.get(unitPath) : undefined;
    if (!unitPath || !placement || seenPaths.has(unitPath) || !status || !statuses.has(status) || !reasonCode) {
      throw new Error('Blueprint media_review contains an invalid decision.');
    }
    if (status === 'PROPOSED' && !placement.has_media_plan) {
      throw new Error('A PROPOSED media decision requires a media_plan at the same unit path.');
    }
    if (status !== 'PROPOSED' && status !== 'NOT_EVALUATED' && placement.has_media_plan) {
      throw new Error('A non-proposed evaluated media decision cannot retain a media_plan.');
    }
    seenPaths.add(unitPath);
    decisions.push({ unit_path: unitPath, status, reason_code: reasonCode });
  }
  return { version: 'media-review-v1', decisions };
}
