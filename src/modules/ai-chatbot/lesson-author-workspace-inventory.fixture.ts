import type { LessonAuthorBlueprint, LessonAuthorBlueprintUnit } from './chat.service.js';

/** Synthetic offline fixture; no customer content/provider output. */
export function workspaceInventoryFixture(unitCount = 2, locale: 'vi' | 'en' = 'en'): LessonAuthorBlueprint {
  const facts = Array.from({ length: unitCount }, (_, i) => `fact_${i + 1}`);
  const scopes = facts.map((fact, i) => ({ id: `scope_${i + 1}`, document_id: 'doc_1', section_id: 'section_1',
    concept_ids: ['concept_1'], source_ref: 'src_1', source_fact_ids: [fact], fact_count: 1, evidence_char_count: 80,
    evidence_token_estimate: 20, derivation_basis: 'FALLBACK_PAGE_FACT_ORDINAL_RANGE' as const, provenance_complete: true }));
  const units: LessonAuthorBlueprintUnit[] = facts.map((fact, i) => ({ title: locale === 'en' ? `Unit ${i + 1}` : `Bài ${i + 1}`, purpose: 'Explain the concept',
    concept_ids: ['concept_1'], learning_objective_refs: ['lo_1'], source_refs: ['src_1'], source_fact_ids: [fact],
    primary_evidence_scope_ids: [scopes[i].id], supporting_evidence_scope_ids: [],
    learning_blocks: [{ id: `block_${i + 1}`, intent: 'concept_explanation', importance: 'core', content: {}, concept_ids: ['concept_1'], source_refs: ['src_1'],
      learning_objective_refs: ['lo_1'], source_fact_ids: [fact], primary_evidence_scope_ids: [scopes[i].id], supporting_evidence_scope_ids: [] }],
    component_plan: [{ type: 'html' as const, component_plan_id: `plan_${i + 1}`, title: 'Explanation', rationale: 'Grounded teaching',
      source_fact_ids: [fact], learning_objective_refs: ['lo_1'], learning_block_ids: [`block_${i + 1}`] }],
  }));
  const allocations = facts.map((fact, i) => ({ fact_id: fact, evidence_scope_id: scopes[i].id,
    unit_path: `chapter_${Math.floor(i / 512) + 1}.lesson_${Math.floor((i % 512) / 256) + 1}.unit_${i % 256 + 1}`, learning_block_id: `block_${i + 1}`, basis: 'PRIMARY_EVIDENCE_SCOPE' as const }));
  return { architecture_contract_version: 5, content_contract_version: 1, title: locale === 'en' ? 'Synthetic course' : 'Khoá học thử nghiệm',
    summary: 'Synthetic summary', target_audience: 'Synthetic audience', prerequisites: [], learning_outcomes: ['Explain the concept.'],
    assessment_strategy: '', assumptions: [],
    chapters: Array.from({ length: Math.ceil(unitCount / 512) }, (_, ci) => ({ title: `Chapter ${ci + 1}`, objective: 'Explain the concept.',
      lessons: Array.from({ length: Math.ceil(Math.min(512, unitCount - ci * 512) / 256) }, (_, li) => ({ title: `Lesson ${li + 1}`, objective: 'Explain the concept.',
        learning_objectives: ['Explain the concept.'], primary_concept_ids: ['concept_1'], learning_activities: ['Read'], assessment: '', units: units.slice(ci * 512 + li * 256, ci * 512 + (li + 1) * 256) })) })),
    source_map: { version: 'source-map-v2', documents: [{ id: 'doc_1', title: 'Synthetic source', language: locale, source_section_ids: ['section_1'] }],
      sections: [{ id: 'section_1', document_id: 'doc_1', source_ref: 'src_1', title: 'Section', level: 1, parent_id: null, order: 1, source_fact_ids: facts }],
      concepts: [{ id: 'concept_1', name: 'Concept', source_section_ids: ['section_1'], source_fact_ids: facts, prerequisite_concept_ids: [], importance: 'core' }],
      facts: facts.map((id, i) => ({ id, section_id: 'section_1', document_id: 'doc_1', source_ref: 'src_1', page: i + 1, chunk: i })),
      source_evidence_scopes: scopes,
      coverage: { section_count: 1, source_fact_count: unitCount, mapped_fact_count: unitCount, fact_scope_complete: true,
        section_scope_complete: true, evidence_scope_complete: true, evidence_scope_count: unitCount } },
    source_fact_allocation: { version: 'source-fact-allocation-v3', authority: 'server', architecture_contract_version: 5,
      complete: true, required_count: unitCount, allocated_count: unitCount, unallocated: [], allocations },
    source_evidence_scope_allocation: { version: 'source-evidence-scope-allocation-v1', authority: 'server', architecture_contract_version: 5,
      complete: true, required_count: unitCount, allocated_count: unitCount, unallocated: [],
      allocations: allocations.map(({ fact_id: _fact, ...scope }) => scope) } };
}
