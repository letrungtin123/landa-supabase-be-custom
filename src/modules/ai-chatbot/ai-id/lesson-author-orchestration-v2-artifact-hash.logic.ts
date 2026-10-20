import type { OrchestrationV2ArtifactCommit } from './lesson-author-orchestration-v2-worker-repository.types.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { orchestrationV2UnitArtifactHash } from './lesson-author-orchestration-v2-unit.logic.js';

/** A V2 artifact, revision or node whose stored JSON would not re-hash to the hash stored with it. */
export const ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH = 'ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH' as const;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** `payload` without the keys that are not part of its own hash. */
function without(payload: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !keys.includes(key)));
}

/**
 * Whether `stored` (an artifact payload exactly as read back from jsonb, i.e.
 * after JSON.parse(JSON.stringify(payload))) re-hashes to `artifactHash` by
 * the rule its readers apply:
 * - source_catalog, course_skeleton, chapter_blueprint: the whole payload
 *   (planning.repository loadShardArtifacts);
 * - architecture_validation: the assembly without `assembly_hash`
 *   (readOrchestrationV2ArchitectureAssembly), which is the artifact hash;
 * - inventory_receipt, chapter_receipt: the receipt without `contract_version`
 *   and `receipt_hash` (V2 Apply readChapterReceipt), which is the artifact hash;
 * - course_receipt: the receipt without `contract_version` and
 *   `course_artifact_hash`, which is the artifact hash;
 * - unit_baseline: orchestrationV2UnitArtifactHash (chapter validation, V2 Apply).
 */
export function orchestrationV2StoredArtifactHashMatches(
  kind: OrchestrationV2ArtifactCommit['artifact_kind'],
  artifactHash: string,
  stored: unknown,
): boolean {
  const payload = record(stored);
  if (!payload) return false;
  switch (kind) {
    case 'source_catalog':
    case 'course_skeleton':
    case 'chapter_blueprint':
      return orchestrationV2Hash(payload) === artifactHash;
    case 'architecture_validation':
      return payload.assembly_hash === artifactHash && orchestrationV2Hash(without(payload, 'assembly_hash')) === artifactHash;
    case 'inventory_receipt':
    case 'chapter_receipt':
      return (
        payload.receipt_hash === artifactHash &&
        orchestrationV2Hash(without(payload, 'contract_version', 'receipt_hash')) === artifactHash
      );
    case 'course_receipt':
      return (
        payload.course_artifact_hash === artifactHash &&
        orchestrationV2Hash(without(payload, 'contract_version', 'course_artifact_hash')) === artifactHash
      );
    case 'unit_baseline':
      return orchestrationV2UnitArtifactHash(payload) === artifactHash;
    default:
      return false;
  }
}
