// Reading semantic learning blocks: normalization of the blocks a provider or a stored plan
// carries, their server-owned source fact ids, and the blocks derived from a legacy component plan.
// Split out of lesson-author-component-registry.logic.ts (move only), which re-exports the public
// names.

import type { LessonAuthorComponentPlan } from '../../../course-authoring/course-authoring.service.js';
import {
  IMPORTANCE, INTENTS, MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE,
} from './lesson-author-component-registry.constants.js';
import type {
  LearningBlockImportance, LearningBlockIntent, SemanticLearningBlock,
} from './lesson-author-component-registry.constants.js';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().slice(0, maxLength);
    if (normalized) result.add(normalized);
    if (result.size >= maxItems) break;
  }
  return Array.from(result);
}

/** IDs in the v4 semantic contract are not display strings and cannot truncate. */
function canonicalIdList(value: unknown, maxItems: number, maxLength = 96): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) throw new Error('Semantic Blueprint identifier list exceeds its contract limit.');
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Semantic Blueprint identifier is invalid.');
    const identifier = item.trim();
    if (!identifier || identifier.length > maxLength) throw new Error('Semantic Blueprint identifier is invalid.');
    result.add(identifier);
  }
  return [...result];
}

function localObjectiveRefList(value: unknown, maxItems: number): string[] {
  const refs = canonicalIdList(value, maxItems, 16);
  if (refs.some(ref => !/^lo_([1-9][0-9]*)$/.test(ref))) {
    throw new Error('Semantic learning block objective reference must be a local lo_N identifier.');
  }
  return refs;
}

export function readServerOwnedSourceFactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || normalized.length > 96) {
      throw new Error('Server-owned Source Fact ID is invalid.');
    }
    ids.add(normalized);
    if (ids.size > MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE) {
      throw new Error(`Server-owned Source Fact allocation exceeds ${MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE} IDs for one scope.`);
    }
  }
  return Array.from(ids);
}

/** Parses only the semantic representation; invalid declared blocks are rejected. */
export function normalizeSemanticLearningBlocks(
  value: unknown,
  unitSourceFactIds: readonly string[] = [],
  options: { strictLocalObjectiveRefs?: boolean } = {},
): SemanticLearningBlock[] {
  if (!Array.isArray(value)) return [];
  const knownFacts = new Set(unitSourceFactIds);
  const seenIds = new Set<string>();
  return value.slice(0, 12).map((valueItem, index) => {
    const item = asRecord(valueItem);
    const intent = typeof item.intent === 'string' ? item.intent.trim().toLowerCase() : '';
    if (!INTENTS.includes(intent as LearningBlockIntent)) {
      throw new Error(`Semantic learning block ${index + 1} has an unsupported intent.`);
    }
    const importance = typeof item.importance === 'string' ? item.importance.trim().toLowerCase() : 'core';
    if (!IMPORTANCE.includes(importance as LearningBlockImportance)) {
      throw new Error(`Semantic learning block ${index + 1} has an unsupported importance.`);
    }
    const suppliedId = typeof item.id === 'string' ? item.id.trim() : '';
    if (suppliedId.length > 96) throw new Error(`Semantic learning block ${index + 1} has an invalid identifier.`);
    const id = suppliedId || `lb_${index + 1}`;
    if (seenIds.has(id)) throw new Error(`Semantic learning block ID "${id}" is duplicated.`);
    seenIds.add(id);
    const sourceFactIds = readServerOwnedSourceFactIds(item.source_fact_ids ?? item.sourceFactIds);
    const invalidFactIds = sourceFactIds.filter(idValue => knownFacts.size > 0 && !knownFacts.has(idValue));
    if (invalidFactIds.length > 0) {
      throw new Error(`Semantic learning block "${id}" references source facts outside its unit.`);
    }
    const primaryEvidenceScopeIds = canonicalIdList(
      item.primary_evidence_scope_ids ?? item.primaryEvidenceScopeIds,
      12,
    );
    const supportingEvidenceScopeIds = canonicalIdList(
      item.supporting_evidence_scope_ids ?? item.supportingEvidenceScopeIds,
      12,
    );
    if (primaryEvidenceScopeIds.some(scopeId => supportingEvidenceScopeIds.includes(scopeId))) {
      throw new Error(`Semantic learning block "${id}" cannot primary-own and support the same evidence scope.`);
    }
    return {
      id,
      intent: intent as LearningBlockIntent,
      importance: importance as LearningBlockImportance,
      content: asRecord(item.content),
      source_fact_ids: sourceFactIds,
      ...(canonicalIdList(item.concept_ids ?? item.conceptIds, 24).length > 0
        ? { concept_ids: canonicalIdList(item.concept_ids ?? item.conceptIds, 24) }
        : {}),
      ...(canonicalIdList(item.source_refs ?? item.sourceRefs, 8).length > 0
        ? { source_refs: canonicalIdList(item.source_refs ?? item.sourceRefs, 8) }
        : {}),
      ...(canonicalIdList(item.primary_concept_ids ?? item.primaryConceptIds, 24).length > 0
        ? { primary_concept_ids: canonicalIdList(item.primary_concept_ids ?? item.primaryConceptIds, 24) }
        : {}),
      ...(primaryEvidenceScopeIds.length > 0
        ? { primary_evidence_scope_ids: primaryEvidenceScopeIds }
        : {}),
      ...(supportingEvidenceScopeIds.length > 0
        ? { supporting_evidence_scope_ids: supportingEvidenceScopeIds }
        : {}),
      ...((options.strictLocalObjectiveRefs
        ? localObjectiveRefList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12)
        : textList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12, 160)).length > 0
        ? { learning_objective_refs: options.strictLocalObjectiveRefs
          ? localObjectiveRefList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12)
          : textList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12, 160) }
        : {}),
      ...(Object.keys(asRecord(item.metadata)).length > 0 ? { metadata: asRecord(item.metadata) } : {}),
    };
  });
}

/** Compatibility adapter for persisted or provider responses created before Phase 2. */
export function deriveSemanticLearningBlocksFromLegacyComponentPlan(
  plan: readonly Pick<LessonAuthorComponentPlan, 'type' | 'purpose' | 'source_fact_ids' | 'title' | 'required_artifacts'>[],
): SemanticLearningBlock[] {
  return plan.map((item, index) => {
    const intent: LearningBlockIntent = item.type === 'problem'
      ? 'knowledge_check'
      : item.type === 'la_faq'
        ? 'faq'
        : item.type === 'la_sortable'
          ? 'practice'
          : item.type === 'la_crossword'
            ? 'terminology_reinforcement'
            : item.type === 'la_diagram'
              ? 'relationship_visualization'
              : item.purpose === 'sequence'
                ? 'procedure'
                : item.purpose === 'relationship'
                  ? 'relationship_visualization'
                  : item.purpose === 'terminology'
                    ? 'terminology_reinforcement'
                    : item.purpose === 'clarify'
                      ? 'faq'
                      : 'concept_explanation';
    return {
      id: `legacy_lb_${index + 1}`,
      intent,
      importance: intent === 'knowledge_check' ? 'assessment' : 'core',
      source_fact_ids: item.source_fact_ids ?? [],
      content: {
        ...(item.title ? { title: item.title } : {}),
        legacy_component_type: item.type,
        ...(item.type === 'la_faq' ? { anticipated_questions: true, question_count: 2 } : {}),
        ...(item.type === 'la_sortable' ? { requires_ordering_practice: true, ordered_sequence: true, sequence_item_count: 3 } : {}),
        ...(item.type === 'la_crossword' ? { terminology_count: 3, definitions_supported: true } : {}),
        ...(item.type === 'la_diagram' ? { relationship_evidence: true } : {}),
      },
      metadata: {
        adapter: 'legacy_component_plan',
        ...(item.required_artifacts?.length ? { required_artifacts: item.required_artifacts } : {}),
      },
    };
  });
}
