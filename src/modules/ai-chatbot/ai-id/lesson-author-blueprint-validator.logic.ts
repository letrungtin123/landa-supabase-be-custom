/**
 * Deterministic architecture validator. It deliberately judges the blueprint
 * separately from the Course Architect/provider and never generates a repair.
 * A Source Map is available only for the self-built-RAG path in Phase 3;
 * File Search retains a compatibility warning rather than pretending parity.
 */

export type BlueprintValidationSeverity = 'error' | 'warning' | 'info';
export type BlueprintValidationStatus = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';

export interface SourceMapSection {
  id: string;
  document_id: string;
  source_ref: string;
  title: string;
  level: number;
  parent_id: string | null;
  order: number;
  source_fact_ids: string[];
}

export interface SourceMapConcept {
  id: string;
  name: string;
  source_section_ids: string[];
  source_fact_ids: string[];
  prerequisite_concept_ids: string[];
  importance: 'core' | 'supporting';
  relationship_evidence?: 'source_hierarchy' | 'none';
}

export interface SourceEvidenceScope {
  id: string;
  document_id: string;
  section_id: string;
  concept_ids: string[];
  source_ref: string;
  source_fact_ids: string[];
  fact_count: number;
  evidence_char_count: number;
  evidence_token_estimate: number;
  derivation_basis: string;
  provenance_complete: boolean;
}

export interface LessonAuthorSourceMap {
  version: string;
  documents: Array<{ id: string; title: string; language?: string; source_section_ids: string[] }>;
  sections: SourceMapSection[];
  concepts: SourceMapConcept[];
  source_evidence_scopes?: SourceEvidenceScope[];
  facts: Array<{ id: string; section_id: string; document_id: string; source_ref?: string; page?: number | null; chunk?: number | null }>;
  coverage: {
    section_count: number;
    source_fact_count: number;
    mapped_fact_count: number;
    unmapped_fact_ids?: string[];
    fact_scope_complete: boolean;
    section_scope_complete: boolean;
    total_fact_count?: number;
    represented_fact_count?: number;
    concept_count?: number;
    incomplete_reason?: string | null;
    evidence_scope_count?: number;
    evidence_scope_complete?: boolean;
  };
  warnings?: string[];
}

export interface BlueprintArchitectureUnit {
  title: string;
  purpose?: string;
  concept_ids?: string[];
  primary_concept_ids?: string[];
  source_refs?: string[];
  source_fact_ids?: string[];
  primary_evidence_scope_ids?: string[];
  supporting_evidence_scope_ids?: string[];
  learning_objective_refs?: string[];
  learning_blocks?: Array<{
    id?: string;
    intent?: string;
    concept_ids?: string[];
    primary_concept_ids?: string[];
    source_refs?: string[];
    source_fact_ids?: string[];
    primary_evidence_scope_ids?: string[];
    supporting_evidence_scope_ids?: string[];
    learning_objective_refs?: string[];
  }>;
}

export interface BlueprintArchitectureLesson {
  title: string;
  objective: string;
  learning_objectives?: string[];
  primary_concept_ids?: string[];
  supporting_concept_ids?: string[];
  prerequisite_concept_ids?: string[];
  estimated_minutes?: number;
  assessment_required?: boolean;
  assessment_objective_refs?: string[];
  source_refs?: string[];
  units: BlueprintArchitectureUnit[];
}

export interface BlueprintArchitectureChapter {
  title: string;
  objective: string;
  learning_objectives?: string[];
  concept_ids?: string[];
  source_refs?: string[];
  lessons: BlueprintArchitectureLesson[];
}

export interface BlueprintArchitecture {
  source_chapter_policy?: SourceChapterPolicy;
  architecture_contract_version?: number;
  title: string;
  learning_outcomes: string[];
  course_outcomes?: string[];
  chapters: BlueprintArchitectureChapter[];
  source_fact_allocation?: {
    version: string;
    authority?: string;
    architecture_contract_version?: number;
    required_count: number;
    allocated_count: number;
    complete: boolean;
    allocations: Array<{ fact_id: string; unit_path: string; learning_block_id: string; evidence_scope_id?: string; basis: string }>;
    unallocated: Array<{ fact_id: string; code: string; path: string }>;
  };
  source_evidence_scope_allocation?: {
    version: string;
    authority?: string;
    architecture_contract_version?: number;
    required_count: number;
    allocated_count: number;
    complete: boolean;
    allocations: Array<{ evidence_scope_id: string; unit_path: string; learning_block_id: string; basis: string }>;
    unallocated: Array<{ evidence_scope_id: string; code: string; path: string }>;
  };
}

export interface SourceChapterPolicy {
  version: 1;
  mode: 'MODEL_DESIGNED' | 'SOURCE_LOCKED_TOC' | 'SOURCE_LOCKED_HEADINGS';
  complete: true;
  reason_codes: string[];
  chapters: Array<{ document_id: string; source_ref: string; title: string; source_title: string; basis: string; parser_version: string | null }>;
}

/** Additive server metadata; absent on stored V3/V4/earlier V5 records. */
export function normalizeSourceChapterPolicy(value: unknown): SourceChapterPolicy | undefined {
  if (value === undefined) return undefined;
  const raw = asRecord(value);
  const fail = (): never => { throw new Error('SOURCE_CHAPTER_POLICY_INVALID'); };
  if (!raw || raw.version !== 1 || raw.complete !== true
    || !['MODEL_DESIGNED', 'SOURCE_LOCKED_TOC', 'SOURCE_LOCKED_HEADINGS'].includes(String(raw.mode))
    || !Array.isArray(raw.reason_codes) || raw.reason_codes.length !== 0
    || !Array.isArray(raw.chapters) || raw.chapters.length > 12) return fail();
  const chapters = raw.chapters.map(value => {
    const node = asRecord(value);
    if (!node || ['document_id', 'source_ref', 'title', 'source_title'].some(key => typeof node[key] !== 'string' || !String(node[key]).trim())
      || !['SOURCE_LOCKED_TOC', 'SOURCE_LOCKED_HEADINGS'].includes(String(node.basis))
      || (node.parser_version !== null && typeof node.parser_version !== 'string')) return fail();
    return { document_id: node.document_id as string, source_ref: node.source_ref as string,
      title: node.title as string, source_title: node.source_title as string, basis: node.basis as string,
      parser_version: node.parser_version as string | null };
  });
  if ((raw.mode === 'MODEL_DESIGNED') !== (chapters.length === 0)
    || new Set(chapters.map(c => `${c.document_id}:${c.source_ref}`)).size !== chapters.length) return fail();
  return { version: 1, mode: raw.mode as SourceChapterPolicy['mode'], complete: true, reason_codes: [], chapters };
}

function validateSourceChapterPolicy(blueprint: BlueprintArchitecture, sourceMap: LessonAuthorSourceMap): BlueprintValidationIssue[] {
  const errors: BlueprintValidationIssue[] = [];
  const reject = (path: string) => errors.push(issue('error', 'BLUEPRINT_SOURCE_STRUCTURE_MISMATCH', path, 'Source chapter identity or primary evidence boundary differs from the server policy.', 'chapter'));
  let policy: SourceChapterPolicy | undefined;
  try { policy = normalizeSourceChapterPolicy(blueprint.source_chapter_policy); }
  catch { reject('blueprint'); return errors; }
  if (!policy || policy.mode === 'MODEL_DESIGNED') return errors;
  if (policy.chapters.length !== blueprint.chapters.length) { reject('blueprint'); return errors; }
  const scopes = new Map(sourceMap.source_evidence_scopes?.map(scope => [scope.id, scope]));
  policy.chapters.forEach((binding, index) => {
    const path = `chapters[${index}]`;
    const chapter = blueprint.chapters[index];
    const roots = sourceMap.sections.filter(s => s.document_id === binding.document_id && s.source_ref === binding.source_ref);
    if (roots.length !== 1 || chapter.title !== binding.title || chapter.source_refs?.length !== 1 || chapter.source_refs[0] !== binding.source_ref) {
      reject(path); return;
    }
    const owned = new Set([roots[0].id]);
    for (let pass = 0; pass < sourceMap.sections.length; pass++) {
      const size = owned.size;
      sourceMap.sections.forEach(s => { if (s.parent_id && owned.has(s.parent_id) && s.document_id === binding.document_id) owned.add(s.id); });
      if (size === owned.size) break;
    }
    if (chapter.lessons.some(l => l.units.some(u => u.learning_blocks?.some(b => b.primary_evidence_scope_ids?.some(id => !owned.has(scopes.get(id)?.section_id ?? '')))))) reject(path);
  });
  return errors;
}

export interface BlueprintValidationIssue {
  code: string;
  severity: BlueprintValidationSeverity;
  path: string;
  message: string;
  repair_scope: 'blueprint' | 'chapter' | 'lesson' | 'unit';
}

export interface BlueprintArchitectureValidationResult {
  status: BlueprintValidationStatus;
  score_summary: { source_coverage: number | null; concept_coverage: number | null };
  errors: BlueprintValidationIssue[];
  warnings: BlueprintValidationIssue[];
  info: BlueprintValidationIssue[];
  concept_ownership: Record<string, { primary_lesson_path: string; supporting_lesson_paths: string[] }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const values = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, maxLength);
    if (text) values.add(text);
    if (values.size >= maxItems) break;
  }
  return [...values];
}

/** Canonical IDs are evidence/contract keys, never display text. */
function canonicalIdList(value: unknown, maxItems: number, maxLength = 96): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const values = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const identifier = item.trim();
    if (!identifier || identifier.length > maxLength) return null;
    values.add(identifier);
  }
  return [...values];
}

function isLocalObjectiveRef(value: string, objectiveCount: number): boolean {
  const match = /^lo_([1-9][0-9]*)$/.exec(value);
  return Boolean(match) && Number(match![1]) <= objectiveCount;
}

function isSupportingFactlessUnit(unit: BlueprintArchitectureUnit): boolean {
  const blocks = unit.learning_blocks ?? [];
  return blocks.length > 0
    && (unit.primary_concept_ids?.length ?? 0) === 0
    && blocks.every(block => (block.primary_concept_ids?.length ?? 0) === 0);
}

/** Validate network data before treating it as the self-built-RAG provenance map. */
export function normalizeLessonAuthorSourceMap(value: unknown): LessonAuthorSourceMap | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.version !== 'string' || !Array.isArray(raw.sections)
    || !Array.isArray(raw.concepts) || !Array.isArray(raw.facts) || !Array.isArray(raw.documents)) return null;
  const coverage = asRecord(raw.coverage);
  if (!coverage || typeof coverage.section_count !== 'number' || typeof coverage.source_fact_count !== 'number'
    || typeof coverage.mapped_fact_count !== 'number' || typeof coverage.fact_scope_complete !== 'boolean'
    || typeof coverage.section_scope_complete !== 'boolean') return null;
  const sections: SourceMapSection[] = [];
  for (const item of raw.sections) {
    const section = asRecord(item);
    if (!section || typeof section.id !== 'string' || typeof section.document_id !== 'string'
      || typeof section.source_ref !== 'string' || typeof section.title !== 'string'
      || typeof section.level !== 'number' || typeof section.order !== 'number') return null;
    const sectionFactIds = canonicalIdList(section.source_fact_ids, 1600);
    if (!sectionFactIds || section.id.trim().length > 96 || section.document_id.trim().length > 96 || section.source_ref.trim().length > 96) return null;
    sections.push({ id: section.id, document_id: section.document_id, source_ref: section.source_ref, title: section.title,
      level: section.level, parent_id: typeof section.parent_id === 'string' ? section.parent_id : null,
      order: section.order, source_fact_ids: sectionFactIds });
  }
  const concepts: SourceMapConcept[] = [];
  for (const item of raw.concepts) {
    const concept = asRecord(item);
    if (!concept || typeof concept.id !== 'string' || typeof concept.name !== 'string'
      || (concept.importance !== 'core' && concept.importance !== 'supporting')) return null;
    const sectionIds = canonicalIdList(concept.source_section_ids, 400);
    const factIds = canonicalIdList(concept.source_fact_ids, 1600);
    const prerequisiteIds = canonicalIdList(concept.prerequisite_concept_ids, 400);
    if (!sectionIds || !factIds || !prerequisiteIds || concept.id.trim().length > 96) return null;
    concepts.push({ id: concept.id, name: concept.name,
      source_section_ids: sectionIds,
      source_fact_ids: factIds,
      prerequisite_concept_ids: prerequisiteIds,
      importance: concept.importance,
      ...(concept.relationship_evidence === 'source_hierarchy' || concept.relationship_evidence === 'none'
        ? { relationship_evidence: concept.relationship_evidence } : {}),
    });
  }
  const facts: LessonAuthorSourceMap['facts'] = [];
  for (const item of raw.facts) {
    const fact = asRecord(item);
    if (!fact || typeof fact.id !== 'string' || typeof fact.section_id !== 'string' || typeof fact.document_id !== 'string'
      || fact.id.trim().length > 96 || fact.section_id.trim().length > 96 || fact.document_id.trim().length > 96
      || (typeof fact.source_ref === 'string' && fact.source_ref.trim().length > 96)) return null;
    facts.push({ id: fact.id, section_id: fact.section_id, document_id: fact.document_id,
      ...(typeof fact.source_ref === 'string' ? { source_ref: fact.source_ref } : {}),
      ...(typeof fact.page === 'number' ? { page: fact.page } : {}),
      ...(typeof fact.chunk === 'number' ? { chunk: fact.chunk } : {}),
    });
  }
  const sourceEvidenceScopes: SourceEvidenceScope[] = [];
  if (raw.source_evidence_scopes !== undefined) {
    if (!Array.isArray(raw.source_evidence_scopes)) return null;
    for (const item of raw.source_evidence_scopes) {
      const scope = asRecord(item);
      if (!scope || typeof scope.id !== 'string' || typeof scope.document_id !== 'string'
        || typeof scope.section_id !== 'string' || typeof scope.source_ref !== 'string'
        || typeof scope.fact_count !== 'number' || typeof scope.evidence_char_count !== 'number'
        || typeof scope.evidence_token_estimate !== 'number' || typeof scope.derivation_basis !== 'string'
        || typeof scope.provenance_complete !== 'boolean') return null;
      const conceptIds = canonicalIdList(scope.concept_ids, 24);
      const factIds = canonicalIdList(scope.source_fact_ids, 1600);
      if (!conceptIds || !factIds || scope.id.trim().length > 96 || scope.document_id.trim().length > 96
        || scope.section_id.trim().length > 96 || scope.source_ref.trim().length > 96
        || scope.fact_count !== factIds.length || scope.evidence_char_count < 0 || scope.evidence_token_estimate < 0) return null;
      sourceEvidenceScopes.push({
        id: scope.id, document_id: scope.document_id, section_id: scope.section_id,
        concept_ids: conceptIds, source_ref: scope.source_ref, source_fact_ids: factIds,
        fact_count: scope.fact_count, evidence_char_count: scope.evidence_char_count,
        evidence_token_estimate: scope.evidence_token_estimate, derivation_basis: scope.derivation_basis,
        provenance_complete: scope.provenance_complete,
      });
    }
  }
  const documents = raw.documents.map(item => {
    const document = asRecord(item);
    if (!document || typeof document.id !== 'string' || typeof document.title !== 'string') return null;
    const sectionIds = canonicalIdList(document.source_section_ids, 400);
    if (!sectionIds || document.id.trim().length > 96) return null;
    return { id: document.id, title: document.title,
      ...(typeof document.language === 'string' ? { language: document.language } : {}),
      source_section_ids: sectionIds };
  });
  if (documents.some((document): document is null => document === null)) return null;
  return {
    version: raw.version,
    documents: documents as LessonAuthorSourceMap['documents'], sections, concepts, facts,
    ...(raw.source_evidence_scopes !== undefined ? { source_evidence_scopes: sourceEvidenceScopes } : {}),
    coverage: { section_count: coverage.section_count, source_fact_count: coverage.source_fact_count,
      mapped_fact_count: coverage.mapped_fact_count, unmapped_fact_ids: textList(coverage.unmapped_fact_ids, 80, 96),
      fact_scope_complete: coverage.fact_scope_complete, section_scope_complete: coverage.section_scope_complete,
      ...(typeof coverage.total_fact_count === 'number' ? { total_fact_count: coverage.total_fact_count } : {}),
      ...(typeof coverage.represented_fact_count === 'number' ? { represented_fact_count: coverage.represented_fact_count } : {}),
      ...(typeof coverage.concept_count === 'number' ? { concept_count: coverage.concept_count } : {}),
      ...(typeof coverage.evidence_scope_count === 'number' ? { evidence_scope_count: coverage.evidence_scope_count } : {}),
      ...(typeof coverage.evidence_scope_complete === 'boolean' ? { evidence_scope_complete: coverage.evidence_scope_complete } : {}),
      ...(typeof coverage.incomplete_reason === 'string' ? { incomplete_reason: coverage.incomplete_reason } : {}),
    },
    warnings: textList(raw.warnings, 80, 120),
  };
}

function issue(
  severity: BlueprintValidationSeverity,
  code: string,
  path: string,
  message: string,
  repair_scope: BlueprintValidationIssue['repair_scope'],
): BlueprintValidationIssue {
  return { severity, code, path, message, repair_scope };
}

function textKey(value: string): string {
  return value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9à-ỹ]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenSet(value: string): Set<string> {
  return new Set(textKey(value).split(' ').filter(token => token.length >= 3));
}

function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function hasObservableVerb(value: string): boolean {
  return /\b(?:identify|apply|explain|demonstrate|perform|compare|classify|calculate|select|analyze|evaluate|design|implement|recognize|xác định|áp dụng|giải thích|thực hiện|so sánh|phân loại|đánh giá|thiết kế|nhận diện|lựa chọn)\b/i.test(value);
}

// V5 remains semantic at this boundary. The registry/planner later maps the
// required `knowledge_check` intent to the allowed `problem` CMS component.
const V5_TEACHING_INTENTS = new Set([
  'concept_explanation', 'definition', 'example', 'worked_example',
  'procedure', 'comparison', 'warning', 'tip',
]);
const V5_GENERIC_EXPLANATION_INTENTS = new Set(['concept_explanation', 'definition', 'introduction']);
// JS \b is ASCII-based, unlike Python re's Unicode boundary. Keep VI/EN
// action vocabulary identical without matching it inside another word.
const V5_ACTION_OR_PROCEDURE_OBJECTIVE = /(?:^|[^\p{L}\p{N}_])(?:apply|perform|demonstrate|execute|practice|procedure|process|áp\s+dụng|thực\s+hiện|thực\s+hành|quy\s+trình|vận\s+hành)(?=$|[^\p{L}\p{N}_])/iu;

function blockIntent(block: NonNullable<BlueprintArchitectureUnit['learning_blocks']>[number]): string {
  return typeof block.intent === 'string' ? block.intent.trim() : '';
}

function canonicalIdSet(value: unknown): Set<string> {
  return new Set(canonicalIdList(value, 1600) ?? []);
}

function findDependencyCycle(concepts: Map<string, SourceMapConcept>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const trail: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...trail, id];
    if (visited.has(id)) return null;
    visiting.add(id);
    trail.push(id);
    for (const dependency of concepts.get(id)?.prerequisite_concept_ids ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    trail.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of concepts.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function validateV5EvidenceScopeBlueprint(
  blueprint: BlueprintArchitecture,
  sourceMap?: LessonAuthorSourceMap | null,
): BlueprintArchitectureValidationResult {
  const errors: BlueprintValidationIssue[] = [];
  const warnings: BlueprintValidationIssue[] = [];
  const info: BlueprintValidationIssue[] = [];
  const ownership: Record<string, { primary_lesson_path: string; supporting_lesson_paths: string[] }> = {};
  const add = (item: BlueprintValidationIssue) => {
    if (item.severity === 'error') errors.push(item);
    else if (item.severity === 'warning') warnings.push(item);
    else info.push(item);
  };
  if (!sourceMap || sourceMap.version !== 'source-map-v2' || !sourceMap.source_evidence_scopes) {
    add(issue('error', 'SOURCE_MAP_REQUIRED', 'blueprint', 'Blueprint v5 requires a validated v2 Source Map with evidence scopes.', 'blueprint'));
    return { status: 'FAIL', score_summary: { source_coverage: null, concept_coverage: null }, errors, warnings, info, concept_ownership: ownership };
  }
  if (!sourceMap.coverage.fact_scope_complete || !sourceMap.coverage.section_scope_complete || sourceMap.coverage.evidence_scope_complete !== true) {
    add(issue('error', 'SOURCE_MAP_INCOMPLETE', 'source_map', 'Source Map does not represent a complete evidence-scope inventory.', 'blueprint'));
  }
  const scopes = new Map(sourceMap.source_evidence_scopes.map(scope => [scope.id, scope]));
  validateSourceChapterPolicy(blueprint, sourceMap).forEach(add);
  const facts = new Set(sourceMap.facts.map(fact => fact.id));
  const concepts = new Map(sourceMap.concepts.map(concept => [concept.id, concept]));
  const sourceRefs = new Set(sourceMap.sections.map(section => section.source_ref));
  const expectedScopeIds = new Set(sourceMap.source_evidence_scopes.filter(scope => scope.source_fact_ids.length > 0).map(scope => scope.id));
  const expectedFactIds = new Set(sourceMap.facts.map(fact => fact.id));
  const scopeAllocation = blueprint.source_evidence_scope_allocation;
  const factAllocation = blueprint.source_fact_allocation;
  if (!scopeAllocation || scopeAllocation.version !== 'source-evidence-scope-allocation-v1'
    || scopeAllocation.authority !== 'server' || scopeAllocation.architecture_contract_version !== 5) {
    add(issue('error', 'EVIDENCE_SCOPE_ALLOCATION_AUTHORITY_INVALID', 'blueprint', 'Blueprint v5 requires server-issued evidence-scope allocation metadata.', 'blueprint'));
  }
  if (!factAllocation || factAllocation.version !== 'source-fact-allocation-v3'
    || factAllocation.authority !== 'server' || factAllocation.architecture_contract_version !== 5) {
    add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', 'blueprint', 'Blueprint v5 requires server-issued Source Fact allocation metadata.', 'blueprint'));
  }
  const actualScopeTargets = new Map<string, string>();
  const actualFactTargets = new Map<string, string>();
  const primaryScopeIds = new Set<string>();
  const primaryConceptIntroducedAt = new Map<string, number>();
  let lessonSequence = 0;
  blueprint.chapters.forEach((chapter, chapterIndex) => {
    const chapterPath = `chapters[${chapterIndex}]`;
    if (!chapter.title.trim() || !chapter.objective.trim()) add(issue('error', 'EMPTY_CHAPTER', chapterPath, 'Chapter title and objective are required.', 'chapter'));
    for (const ref of chapter.source_refs ?? []) if (!sourceRefs.has(ref)) add(issue('error', 'INVALID_SOURCE_REF', chapterPath, 'Chapter reference is not in the Source Map.', 'chapter'));
    for (const conceptId of chapter.concept_ids ?? []) if (!concepts.has(conceptId)) add(issue('error', 'UNSUPPORTED_CONCEPT', chapterPath, 'Chapter concept is not in the Source Map.', 'chapter'));
    chapter.lessons.forEach((lesson, lessonIndex) => {
      lessonSequence += 1;
      const lessonPath = `${chapterPath}.lessons[${lessonIndex}]`;
      if (!lesson.title.trim() || !lesson.objective.trim() || lesson.units.length === 0) add(issue('error', 'EMPTY_LESSON', lessonPath, 'Lesson title, objective, and unit are required.', 'lesson'));
      if (!hasObservableVerb(lesson.objective)) add(issue('warning', 'OBJECTIVE_TOO_GENERIC', lessonPath, 'Lesson objective lacks an observable action verb.', 'lesson'));
      const lessonConcepts = new Set([...(lesson.primary_concept_ids ?? []), ...(lesson.supporting_concept_ids ?? [])]);
      for (const conceptId of lessonConcepts) if (!concepts.has(conceptId)) add(issue('error', 'UNSUPPORTED_CONCEPT', lessonPath, 'Lesson concept is not in the Source Map.', 'lesson'));
      for (const conceptId of lesson.primary_concept_ids ?? []) {
        if (!primaryConceptIntroducedAt.has(conceptId)) primaryConceptIntroducedAt.set(conceptId, lessonSequence);
        ownership[conceptId] ??= { primary_lesson_path: lessonPath, supporting_lesson_paths: [] };
      }
      for (const conceptId of lesson.supporting_concept_ids ?? []) {
        ownership[conceptId] ??= { primary_lesson_path: '', supporting_lesson_paths: [] };
        ownership[conceptId].supporting_lesson_paths.push(lessonPath);
      }
      const objectiveRefs = new Set(Array.from({ length: lesson.learning_objectives?.length ?? 0 }, (_value, index) => `lo_${index + 1}`));
      if (objectiveRefs.size === 0) add(issue('error', 'MISSING_LESSON_OBJECTIVES', lessonPath, 'A v5 lesson must declare learning objectives.', 'lesson'));

      // The V5 architect owns instructional intent, while the registry owns
      // CMS component selection. Reject an assessment-required lesson that
      // cannot later become a source-grounded `problem` component, instead of
      // persisting a locked chapter draft that is guaranteed to fail in the
      // lesson-quality graph.
      const orderedBlocks: Array<{
        position: number;
        unit: BlueprintArchitectureUnit;
        unitPath: string;
        block: NonNullable<BlueprintArchitectureUnit['learning_blocks']>[number];
        blockId: string;
      }> = [];
      let blockPosition = 0;
      lesson.units.forEach((unit, unitIndex) => {
        const unitPath = `${lessonPath}.units[${unitIndex}]`;
        for (const block of unit.learning_blocks ?? []) {
          blockPosition += 1;
          orderedBlocks.push({ position: blockPosition, unit, unitPath, block, blockId: String(block.id ?? '') });
        }
      });
      const assessmentRefs = canonicalIdSet(lesson.assessment_objective_refs);
      if (lesson.assessment_required && assessmentRefs.size === 0) {
        add(issue('error', 'ASSESSMENT_ALIGNMENT_MISSING', lessonPath, 'Assessment-required V5 lesson lacks assessment objective references.', 'lesson'));
      }
      for (const objectiveRef of assessmentRefs) {
        if (!objectiveRefs.has(objectiveRef)) add(issue('error', 'ASSESSMENT_ALIGNMENT_INVALID', lessonPath, 'Assessment objective reference is not declared by this lesson.', 'lesson'));
      }
      if (lesson.assessment_required) {
        const checks = orderedBlocks.filter(item => blockIntent(item.block) === 'knowledge_check');
        if (checks.length === 0) {
          add(issue('error', 'ASSESSMENT_BLOCK_REQUIRED', lessonPath, 'Assessment-required V5 lesson needs a knowledge_check semantic block before draft planning.', 'lesson'));
        } else {
          const checkObjectives = new Set<string>();
          for (const check of checks) for (const ref of canonicalIdSet(check.block.learning_objective_refs)) checkObjectives.add(ref);
          const missingObjectives = [...assessmentRefs].filter(ref => !checkObjectives.has(ref));
          if (missingObjectives.length > 0) add(issue('error', 'ASSESSMENT_OBJECTIVE_NOT_COVERED', lessonPath, 'Knowledge-check blocks do not cover every declared assessment objective.', 'lesson'));

          for (const check of checks) {
            const checkRefs = [...canonicalIdSet(check.block.learning_objective_refs)].filter(ref => assessmentRefs.has(ref));
            // Mirror evaluate_assessment_teaching_anchor's FULL alignment for
            // EACH local objective. Base-eligible alone is repair authority,
            // not acceptance. orderedBlocks is already scoped to this lesson.
            const teachingByObjective = checkRefs.map(ref => orderedBlocks.filter(candidate => {
              const teaching = candidate.block;
              const teachingRefs = canonicalIdSet(teaching.source_refs);
              const checkSourceRefs = canonicalIdSet(check.block.source_refs);
              const concepts = canonicalIdSet(teaching.concept_ids);
              return candidate.position < check.position && Boolean(candidate.blockId)
                && V5_TEACHING_INTENTS.has(blockIntent(teaching))
                && canonicalIdSet(teaching.primary_evidence_scope_ids).size > 0
                && canonicalIdSet(teaching.learning_objective_refs).has(ref)
                && [...canonicalIdSet(check.block.concept_ids)].some(id => concepts.has(id))
                && (!teachingRefs.size || !checkSourceRefs.size || [...checkSourceRefs].some(id => teachingRefs.has(id)));
            }));
            const priorTeaching = teachingByObjective.flat();
            if (teachingByObjective.some(anchors => anchors.length === 0)) {
              add(issue('error', 'ASSESSMENT_OBJECTIVE_NOT_COVERED', check.unitPath, 'Assessment objectives must be taught by an earlier explanatory or procedural semantic block.', 'unit'));
            }
            const priorPrimaryScopes = new Set<string>();
            for (const teaching of priorTeaching) {
              for (const scopeId of canonicalIdSet(teaching.block.primary_evidence_scope_ids)) priorPrimaryScopes.add(scopeId);
            }
            const supportingScopes = canonicalIdSet(check.block.supporting_evidence_scope_ids);
            if (supportingScopes.size === 0 || ![...supportingScopes].some(scopeId => priorPrimaryScopes.has(scopeId))) {
              add(issue('error', 'ASSESSMENT_EVIDENCE_NOT_GROUNDED', check.unitPath, 'Knowledge check must supporting-reference evidence already primary-owned by earlier teaching.', 'unit'));
            }
          }
        }
      }

      const lessonFactCount = new Set(lesson.units.flatMap(unit => unit.source_fact_ids ?? [])).size;
      const primaryScopeCount = new Set(orderedBlocks.flatMap(item => item.block.primary_evidence_scope_ids ?? [])).size;
      const nonAssessmentBlocks = orderedBlocks.filter(item => blockIntent(item.block) !== 'knowledge_check');
      const nonAssessmentIntents = new Set(nonAssessmentBlocks.map(item => blockIntent(item.block)));
      if (objectiveRefs.size >= 2 && (lessonFactCount >= 8 || primaryScopeCount >= 2)
        && nonAssessmentBlocks.length === 1
        && [...nonAssessmentIntents].every(intent => V5_GENERIC_EXPLANATION_INTENTS.has(intent))) {
        add(issue('error', 'INSTRUCTIONAL_DEPTH_INSUFFICIENT', lessonPath, 'A multi-objective lesson with substantial server-owned evidence cannot use one generic explanatory block for all treatment.', 'lesson'));
      }
      lesson.units.forEach((unit, unitIndex) => {
        const refs = unit.learning_objective_refs ?? [];
        const validRefs = refs.length > 0 && new Set(refs).size === refs.length
          && refs.every(ref => objectiveRefs.has(ref) && isLocalObjectiveRef(ref, objectiveRefs.size));
        if (!validRefs) {
          add(issue('error', 'OBJECTIVE_ALIGNMENT_INVALID', `${lessonPath}.units[${unitIndex}]`, 'Unit must declare unique valid local objective references.', 'unit'));
          return;
        }
        const unitText = [...refs.map(ref => lesson.learning_objectives![Number(ref.slice(3)) - 1]), unit.purpose ?? ''].join(' ');
        const intents = new Set((unit.learning_blocks ?? []).map(block => blockIntent(block)));
        if (V5_ACTION_OR_PROCEDURE_OBJECTIVE.test(unitText) && intents.size > 0
          && [...intents].every(intent => V5_GENERIC_EXPLANATION_INTENTS.has(intent))) {
          add(issue('error', 'ACTION_OBJECTIVE_INSTRUCTION_MISMATCH', `${lessonPath}.units[${unitIndex}]`, 'An action-oriented unit needs procedural or supported learner-action treatment, not generic explanation alone.', 'unit'));
        }
      });
      lesson.units.forEach((unit, unitIndex) => {
        const unitPath = `${lessonPath}.units[${unitIndex}]`;
        const allocationPath = `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`;
        const unitConcepts = new Set(unit.concept_ids ?? []);
        if (!unit.title.trim()) add(issue('error', 'EMPTY_UNIT', unitPath, 'Unit title is required.', 'unit'));
        for (const conceptId of unitConcepts) {
          if (!concepts.has(conceptId)) add(issue('error', 'UNSUPPORTED_CONCEPT', unitPath, 'Unit concept is not in the Source Map.', 'unit'));
          if (!lessonConcepts.has(conceptId)) add(issue('error', 'UNIT_CONCEPT_OUTSIDE_LESSON', unitPath, 'Unit concept is outside the lesson scope.', 'unit'));
        }
        const blockFactTarget = new Map<string, string>();
        for (const block of unit.learning_blocks ?? []) {
          const blockId = String(block.id ?? '');
          const blockConcepts = new Set(block.concept_ids ?? []);
          const primary = new Set(block.primary_evidence_scope_ids ?? []);
          const supporting = new Set(block.supporting_evidence_scope_ids ?? []);
          if (primary.size === 0 && supporting.size === 0) add(issue('error', 'MISSING_EVIDENCE_SCOPE_REFERENCE', unitPath, 'Semantic block needs a primary or supporting evidence scope.', 'unit'));
          for (const scopeId of primary) {
            if (supporting.has(scopeId)) add(issue('error', 'EVIDENCE_SCOPE_OWNERSHIP_OVERLAP', unitPath, 'A scope cannot be primary and supporting in one block.', 'unit'));
            const scope = scopes.get(scopeId);
            if (!scope) { add(issue('error', 'UNKNOWN_EVIDENCE_SCOPE', unitPath, 'Evidence scope is not in the Source Map.', 'unit')); continue; }
            if (!scope.concept_ids.every(conceptId => blockConcepts.has(conceptId) && unitConcepts.has(conceptId))) add(issue('error', 'EVIDENCE_SCOPE_CONCEPT_MISMATCH', unitPath, 'Evidence scope concepts are outside the block or unit semantic scope.', 'unit'));
            if (actualScopeTargets.has(scopeId)) add(issue('error', 'DUPLICATE_PRIMARY_EVIDENCE_SCOPE_OWNER', unitPath, 'Evidence scope has multiple primary owners.', 'unit'));
            actualScopeTargets.set(scopeId, `${allocationPath}:${blockId}`); primaryScopeIds.add(scopeId);
          }
          const referenceDocuments = new Set<string>();
          for (const scopeId of [...primary, ...supporting]) {
            const scope = scopes.get(scopeId);
            if (!scope) { add(issue('error', 'UNKNOWN_EVIDENCE_SCOPE', unitPath, 'Evidence scope is not in the Source Map.', 'unit')); continue; }
            referenceDocuments.add(scope.document_id);
            if (!scope.concept_ids.every(conceptId => blockConcepts.has(conceptId) && unitConcepts.has(conceptId))) add(issue('error', 'EVIDENCE_SCOPE_CONCEPT_MISMATCH', unitPath, 'Evidence scope concepts are outside the block or unit semantic scope.', 'unit'));
          }
          if (referenceDocuments.size > 1) add(issue('error', 'CROSS_DOCUMENT_EVIDENCE_SCOPE_CLAIM', unitPath, 'One block cannot combine evidence scopes from different documents.', 'unit'));
          for (const factId of block.source_fact_ids ?? []) {
            if (blockFactTarget.has(factId)) add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', unitPath, 'A fact is assigned to more than one block.', 'unit'));
            blockFactTarget.set(factId, blockId);
          }
        }
        for (const factId of unit.source_fact_ids ?? []) {
          if (!facts.has(factId)) add(issue('error', 'INVALID_SOURCE_FACT', unitPath, 'Unit fact is not in the Source Map.', 'unit'));
          if (actualFactTargets.has(factId)) add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', unitPath, 'A fact is assigned to more than one unit.', 'unit'));
          actualFactTargets.set(factId, `${allocationPath}:${blockFactTarget.get(factId) ?? ''}`);
        }
        for (const ref of unit.learning_objective_refs ?? []) if (!objectiveRefs.has(ref) || !isLocalObjectiveRef(ref, objectiveRefs.size)) add(issue('error', 'OBJECTIVE_ALIGNMENT_INVALID', unitPath, 'Unit objective reference is not declared by its lesson.', 'unit'));
      });
      for (const prerequisite of lesson.prerequisite_concept_ids ?? []) {
        const introducedAt = primaryConceptIntroducedAt.get(prerequisite);
        if (introducedAt === undefined || introducedAt >= lessonSequence) add(issue('error', 'PREREQUISITE_ORDER_INVALID', lessonPath, 'Prerequisite is not introduced before this lesson.', 'lesson'));
      }
    });
  });
  for (const scopeId of expectedScopeIds) if (!primaryScopeIds.has(scopeId)) add(issue('error', 'MISSING_PRIMARY_EVIDENCE_SCOPE_OWNER', 'blueprint', 'Canonical evidence scope has no primary owner.', 'blueprint'));
  if (scopeAllocation) {
    const ids = scopeAllocation.allocations.map(item => item.evidence_scope_id);
    if (!scopeAllocation.complete || scopeAllocation.required_count !== expectedScopeIds.size || scopeAllocation.allocated_count !== expectedScopeIds.size
      || ids.length !== expectedScopeIds.size || new Set(ids).size !== ids.length || !ids.every(id => expectedScopeIds.has(id)) || scopeAllocation.unallocated.length !== 0
      || scopeAllocation.allocations.some(item => item.basis !== 'PRIMARY_EVIDENCE_SCOPE' || actualScopeTargets.get(item.evidence_scope_id) !== `${item.unit_path}:${item.learning_block_id}`)) {
      add(issue('error', 'EVIDENCE_SCOPE_ALLOCATION_AUTHORITY_INVALID', 'blueprint', 'Evidence scope allocation is incomplete or differs from final primary ownership.', 'blueprint'));
    }
  }
  if (factAllocation) {
    const ids = factAllocation.allocations.map(item => item.fact_id);
    if (!factAllocation.complete || factAllocation.required_count !== expectedFactIds.size || factAllocation.allocated_count !== expectedFactIds.size
      || ids.length !== expectedFactIds.size || new Set(ids).size !== ids.length || !ids.every(id => expectedFactIds.has(id)) || factAllocation.unallocated.length !== 0
      || factAllocation.allocations.some(item => item.basis !== 'PRIMARY_EVIDENCE_SCOPE' || actualFactTargets.get(item.fact_id) !== `${item.unit_path}:${item.learning_block_id}`)) {
      add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', 'blueprint', 'Source Fact allocation is incomplete or differs from final evidence-scope ownership.', 'blueprint'));
    }
  }
  return {
    status: errors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'PASS_WITH_WARNINGS' : 'PASS',
    score_summary: { source_coverage: expectedFactIds.size > 0 ? Number((actualFactTargets.size / expectedFactIds.size).toFixed(4)) : null, concept_coverage: null },
    errors, warnings, info, concept_ownership: ownership,
  };
}

/** Validate structure, provenance, coverage, ownership and instructional order. */
export function validateLessonAuthorBlueprintArchitecture(
  blueprint: BlueprintArchitecture,
  sourceMap?: LessonAuthorSourceMap | null,
): BlueprintArchitectureValidationResult {
  if (blueprint.architecture_contract_version === 5) return validateV5EvidenceScopeBlueprint(blueprint, sourceMap);
  const errors: BlueprintValidationIssue[] = [];
  const warnings: BlueprintValidationIssue[] = [];
  const info: BlueprintValidationIssue[] = [];
  const ownership: Record<string, { primary_lesson_path: string; supporting_lesson_paths: string[] }> = {};
  const add = (item: BlueprintValidationIssue) => {
    if (item.severity === 'error') errors.push(item);
    else if (item.severity === 'warning') warnings.push(item);
    else info.push(item);
  };

  if (!Array.isArray(blueprint.chapters) || blueprint.chapters.length === 0) {
    add(issue('error', 'EMPTY_BLUEPRINT', 'blueprint', 'Blueprint must contain at least one chapter.', 'blueprint'));
  }
  if (!Array.isArray(blueprint.learning_outcomes) || blueprint.learning_outcomes.length === 0) {
    add(issue('error', 'MISSING_COURSE_OUTCOMES', 'blueprint', 'Blueprint must declare learning outcomes.', 'blueprint'));
  }

  const lessons: Array<{ chapterIndex: number; lessonIndex: number; lesson: BlueprintArchitectureLesson }> = [];
  blueprint.chapters.forEach((chapter, chapterIndex) => {
    const chapterPath = `chapters[${chapterIndex}]`;
    if (!chapter.title.trim() || !chapter.objective.trim()) {
      add(issue('error', 'EMPTY_CHAPTER', chapterPath, 'Chapter title and objective are required.', 'chapter'));
    }
    if (!Array.isArray(chapter.lessons) || chapter.lessons.length === 0) {
      add(issue('error', 'EMPTY_CHAPTER', chapterPath, 'Chapter must contain at least one lesson.', 'chapter'));
      return;
    }
    if (chapter.lessons.length === 1 && chapter.lessons[0]?.units?.length <= 1) {
      add(issue('warning', 'CHAPTER_IMBALANCED', chapterPath, 'Chapter contains only one small lesson; review whether it should be merged or expanded.', 'chapter'));
    }
    chapter.lessons.forEach((lesson, lessonIndex) => lessons.push({ chapterIndex, lessonIndex, lesson }));
  });

  const sourceRefs = new Set(sourceMap?.sections.map(section => section.source_ref) ?? []);
  const sourceFacts = new Set(sourceMap?.facts.map(fact => fact.id) ?? []);
  const concepts = new Map(sourceMap?.concepts.map(concept => [concept.id, concept]) ?? []);
  const sourceMapBlueprint = blueprint.architecture_contract_version === 3 || blueprint.architecture_contract_version === 4;
  const strictSourceMap = Boolean(sourceMap && sourceMapBlueprint);
  if (!sourceMap) {
    add(issue(sourceMapBlueprint ? 'error' : 'warning', sourceMapBlueprint ? 'SOURCE_MAP_REQUIRED' : 'SOURCE_MAP_UNAVAILABLE', 'blueprint', sourceMapBlueprint
      ? 'A Source-Map Course Architect blueprint cannot be persisted without a validated Source Map.'
      : 'No self-built-RAG Source Map is available; only compatibility-level architecture checks were run.', 'blueprint'));
  } else {
    if (strictSourceMap && (!sourceMap.coverage.section_scope_complete || !sourceMap.coverage.fact_scope_complete)) {
      add(issue('error', 'SOURCE_MAP_INCOMPLETE', 'source_map', 'Source Map does not represent the complete selected source scope.', 'blueprint'));
    }
    const cycle = findDependencyCycle(concepts);
    if (cycle) add(issue('error', 'PREREQUISITE_CYCLE', 'source_map.concepts', `Source concept dependencies contain a cycle: ${cycle.join(' → ')}.`, 'blueprint'));
  }

  if (strictSourceMap) {
    const sectionIds = new Set(sourceMap!.sections.map(section => section.id));
    const documentIds = new Set(sourceMap!.documents.map(document => document.id));
    for (const fact of sourceMap!.facts) {
      if (!sectionIds.has(fact.section_id) || !documentIds.has(fact.document_id)) {
        add(issue('error', 'SOURCE_MAP_INVALID_PROVENANCE', `source_map.facts[${fact.id}]`, 'A source fact must point to an existing source section and document.', 'blueprint'));
      }
    }
    blueprint.chapters.forEach((chapter, chapterIndex) => {
      const path = `chapters[${chapterIndex}]`;
      for (const sourceRef of chapter.source_refs ?? []) {
        if (!sourceRefs.has(sourceRef)) add(issue('error', 'INVALID_SOURCE_REF', path, `Source reference ${sourceRef} is not in the Source Map.`, 'chapter'));
      }
      for (const conceptId of chapter.concept_ids ?? []) {
        if (!concepts.has(conceptId)) add(issue('error', 'UNSUPPORTED_CONCEPT', path, `Chapter concept ${conceptId} is not in the Source Map.`, 'chapter'));
      }
    });
  }

  if (blueprint.architecture_contract_version === 4) {
    const allocation = blueprint.source_fact_allocation;
    if (!allocation || allocation.version !== 'source-fact-allocation-v2'
      || allocation.authority !== 'server' || allocation.architecture_contract_version !== 4) {
      add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', 'blueprint', 'Blueprint v4 requires server-issued Source Fact allocation metadata.', 'blueprint'));
    } else {
      const canonicalFacts = new Set(sourceMap?.facts.map(fact => fact.id) ?? []);
      const allocationIds = allocation.allocations.map(item => item.fact_id);
      const allocationTargets = new Map(allocation.allocations.map(item => [item.fact_id, `${item.unit_path}:${item.learning_block_id}`]));
      const actualTargets = new Map<string, string>();
      blueprint.chapters.forEach((chapter, chapterIndex) => chapter.lessons.forEach((lesson, lessonIndex) => lesson.units.forEach((unit, unitIndex) => {
        const unitPath = `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`;
        const blockByFact = new Map<string, string>();
        const blocks = unit.learning_blocks ?? [];
        blocks.forEach(block => (block.source_fact_ids ?? []).forEach(factId => {
          if (blockByFact.has(factId)) add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', unitPath, 'A Source Fact is assigned to more than one semantic block.', 'unit'));
          blockByFact.set(factId, String(block.id ?? ''));
        }));
        (unit.source_fact_ids ?? []).forEach(factId => {
          if (actualTargets.has(factId)) add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', unitPath, 'A Source Fact is assigned to more than one unit.', 'unit'));
          actualTargets.set(factId, `${unitPath}:${blockByFact.get(factId) ?? ''}`);
        });
      })));
      const exactIds = allocationIds.length === canonicalFacts.size
        && new Set(allocationIds).size === allocationIds.length
        && allocationIds.every(id => canonicalFacts.has(id));
      const exactTargets = allocationTargets.size === actualTargets.size
        && [...allocationTargets].every(([factId, target]) => actualTargets.get(factId) === target);
      if (!allocation.complete || allocation.required_count !== canonicalFacts.size
        || allocation.allocated_count !== canonicalFacts.size || allocation.unallocated.length !== 0
        || !exactIds || !exactTargets) {
        add(issue('error', 'SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID', 'blueprint', 'Server Source Fact allocation is incomplete or does not match the final semantic architecture.', 'blueprint'));
      }
    }
  }

  const factCoverage = new Set<string>();
  const coreConcepts = new Set(Array.from(concepts.values()).filter(concept => concept.importance === 'core').map(concept => concept.id));
  const allPrimaryConcepts = new Set<string>();
  const lessonIndexByPrimaryConcept = new Map<string, number>();
  for (let sequence = 0; sequence < lessons.length; sequence += 1) {
    const { chapterIndex, lessonIndex, lesson } = lessons[sequence];
    const path = `chapters[${chapterIndex}].lessons[${lessonIndex}]`;
    if (!lesson.title.trim() || !lesson.objective.trim()) {
      add(issue('error', 'EMPTY_LESSON', path, 'Lesson title and objective are required.', 'lesson'));
    }
    if (!Array.isArray(lesson.units) || lesson.units.length === 0) {
      add(issue('error', 'EMPTY_LESSON', path, 'Lesson must contain at least one unit.', 'lesson'));
      continue;
    }
    if (!hasObservableVerb(lesson.objective)) {
      add(issue('warning', 'OBJECTIVE_TOO_GENERIC', path, 'Lesson objective lacks an observable action verb.', 'lesson'));
    }
    const primary = lesson.primary_concept_ids ?? [];
    const supporting = lesson.supporting_concept_ids ?? [];
    const objectiveCount = lesson.learning_objectives?.length ?? 0;
    // v4 has an explicit local-ID contract. Stored v3 blueprints used their
    // own lesson-local string values, so preserve that read compatibility.
    const objectiveRefs = blueprint.architecture_contract_version === 4
      ? new Set(Array.from({ length: objectiveCount }, (_value, index) => `lo_${index + 1}`))
      : new Set(lesson.learning_objectives ?? []);
    if (strictSourceMap && objectiveRefs.size === 0) {
      add(issue('error', 'MISSING_LESSON_OBJECTIVES', path, 'A Source-Map-backed lesson must declare learning objectives.', 'lesson'));
    }
    for (const sourceRef of lesson.source_refs ?? []) {
      if (strictSourceMap && !sourceRefs.has(sourceRef)) add(issue('error', 'INVALID_SOURCE_REF', path, `Source reference ${sourceRef} is not in the Source Map.`, 'lesson'));
    }
    if (strictSourceMap && primary.length === 0) {
      add(issue('error', 'MISSING_PRIMARY_CONCEPT_OWNER', path, 'A Source-Map-backed lesson must own at least one primary concept.', 'lesson'));
    }
    for (const conceptId of [...primary, ...supporting, ...(lesson.prerequisite_concept_ids ?? [])]) {
      if (strictSourceMap && !concepts.has(conceptId)) {
        add(issue('error', 'UNSUPPORTED_CONCEPT', path, `Concept ${conceptId} is not present in the Source Map.`, 'lesson'));
      }
    }
    for (const conceptId of primary) {
      allPrimaryConcepts.add(conceptId);
      const existing = ownership[conceptId];
      if (existing) {
        add(issue('error', 'DUPLICATE_PRIMARY_CONCEPT_OWNER', path, `Concept ${conceptId} is already primarily owned by ${existing.primary_lesson_path}.`, 'lesson'));
      } else {
        ownership[conceptId] = { primary_lesson_path: path, supporting_lesson_paths: [] };
        lessonIndexByPrimaryConcept.set(conceptId, sequence);
      }
    }
    for (const conceptId of supporting) {
      const existing = ownership[conceptId] ?? { primary_lesson_path: '', supporting_lesson_paths: [] };
      existing.supporting_lesson_paths.push(path);
      ownership[conceptId] = existing;
    }
    if (lesson.assessment_required && (lesson.assessment_objective_refs?.length ?? 0) === 0) {
      add(issue('error', 'ASSESSMENT_ALIGNMENT_MISSING', path, 'Assessment-required lesson lacks assessment objective references.', 'lesson'));
    }
    if (strictSourceMap && lesson.assessment_required) {
      for (const objectiveRef of lesson.assessment_objective_refs ?? []) {
        if (!objectiveRefs.has(objectiveRef) || (blueprint.architecture_contract_version === 4 && !isLocalObjectiveRef(objectiveRef, objectiveCount))) {
          add(issue('error', 'ASSESSMENT_ALIGNMENT_INVALID', path, `Assessment objective reference ${objectiveRef} is not declared by this lesson.`, 'lesson'));
        }
      }
    }
    if (lesson.units.length === 1
      && (primary.length <= 1)
      && ((lesson.units[0]?.source_fact_ids?.length ?? 0) <= 1)) {
      add(issue('warning', 'LESSON_TOO_THIN', path, 'Lesson has one small unit and limited concept/fact scope.', 'lesson'));
    }
    const lessonFacts = new Set<string>();
    const lessonConceptIds = new Set([...primary, ...supporting]);
    lesson.units.forEach((unit, unitIndex) => {
      const unitPath = `${path}.units[${unitIndex}]`;
      if (!unit.title.trim()) add(issue('error', 'EMPTY_UNIT', unitPath, 'Unit title is required.', 'unit'));
      const factlessSupportingUnit = (blueprint.architecture_contract_version === 4 || blueprint.architecture_contract_version === 5)
        && isSupportingFactlessUnit(unit);
      if (strictSourceMap && (unit.source_fact_ids?.length ?? 0) === 0 && !factlessSupportingUnit) {
        add(issue('error', 'MISSING_SOURCE_FACTS', unitPath, 'Source-Map-backed unit must contain source fact IDs.', 'unit'));
      }
      if (!unit.purpose?.trim()) add(issue('warning', 'UNIT_PURPOSE_MISSING', unitPath, 'Unit has no declared instructional purpose.', 'unit'));
      for (const sourceRef of unit.source_refs ?? []) {
        if (strictSourceMap && !sourceRefs.has(sourceRef)) add(issue('error', 'INVALID_SOURCE_REF', unitPath, `Source reference ${sourceRef} is not in the Source Map.`, 'unit'));
      }
      for (const factId of unit.source_fact_ids ?? []) {
        factCoverage.add(factId);
        lessonFacts.add(factId);
        if (strictSourceMap && !sourceFacts.has(factId)) add(issue('error', 'INVALID_SOURCE_FACT', unitPath, `Source fact ${factId} is not in the Source Map.`, 'unit'));
      }
      for (const conceptId of unit.concept_ids ?? []) {
        if (strictSourceMap && !concepts.has(conceptId)) add(issue('error', 'UNSUPPORTED_CONCEPT', unitPath, `Unit concept ${conceptId} is not in the Source Map.`, 'unit'));
        if (strictSourceMap && !lessonConceptIds.has(conceptId)) add(issue('error', 'UNIT_CONCEPT_OUTSIDE_LESSON', unitPath, `Unit concept ${conceptId} is not owned or supported by this lesson.`, 'unit'));
      }
      if (strictSourceMap && (unit.learning_objective_refs?.length ?? 0) === 0) {
        add(issue('error', 'OBJECTIVE_ALIGNMENT_MISSING', unitPath, 'Unit must reference at least one lesson learning objective.', 'unit'));
      }
      for (const objectiveRef of unit.learning_objective_refs ?? []) {
        if (strictSourceMap && (!objectiveRefs.has(objectiveRef)
          || (blueprint.architecture_contract_version === 4 && !isLocalObjectiveRef(objectiveRef, objectiveCount)))) {
          add(issue('error', 'OBJECTIVE_ALIGNMENT_INVALID', unitPath, `Unit objective reference ${objectiveRef} is not declared by this lesson.`, 'unit'));
        }
      }
      for (const block of unit.learning_blocks ?? []) {
        for (const objectiveRef of block.learning_objective_refs ?? []) {
          if (strictSourceMap && (!objectiveRefs.has(objectiveRef)
            || (blueprint.architecture_contract_version === 4 && !isLocalObjectiveRef(objectiveRef, objectiveCount)))) {
            add(issue('error', 'OBJECTIVE_ALIGNMENT_INVALID', unitPath, `Learning block objective reference ${objectiveRef} is not declared by this lesson.`, 'unit'));
          }
        }
      }
    });
    if (strictSourceMap) {
      for (const conceptId of primary) {
        const conceptFacts = concepts.get(conceptId)?.source_fact_ids ?? [];
        if (conceptFacts.length > 0 && !conceptFacts.some(factId => lessonFacts.has(factId))) {
          add(issue('error', 'OBJECTIVE_SOURCE_ALIGNMENT_MISSING', path, `Primary concept ${conceptId} has no source fact assigned to this lesson.`, 'lesson'));
        }
      }
    }
  }

  for (let index = 0; index < lessons.length; index += 1) {
    for (let other = index + 1; other < lessons.length; other += 1) {
      const left = lessons[index];
      const right = lessons[other];
      const score = similarity(left.lesson.objective, right.lesson.objective);
      if (score >= 0.82) {
        add(issue('error', 'DUPLICATE_LESSON_OBJECTIVE', `chapters[${right.chapterIndex}].lessons[${right.lessonIndex}]`, `Objective substantially duplicates chapters[${left.chapterIndex}].lessons[${left.lessonIndex}].`, 'lesson'));
      }
      const leftPurposes = left.lesson.units.map(unit => unit.purpose ?? unit.title).join(' ');
      const rightPurposes = right.lesson.units.map(unit => unit.purpose ?? unit.title).join(' ');
      if (similarity(leftPurposes, rightPurposes) >= 0.9) {
        add(issue('warning', 'NEAR_DUPLICATE_UNIT_PURPOSE', `chapters[${right.chapterIndex}].lessons[${right.lessonIndex}]`, `Unit purpose is very similar to chapters[${left.chapterIndex}].lessons[${left.lessonIndex}].`, 'lesson'));
      }
    }
  }

  for (let sequence = 0; sequence < lessons.length; sequence += 1) {
    if (!strictSourceMap) break;
    const { chapterIndex, lessonIndex, lesson } = lessons[sequence];
    for (const prerequisite of lesson.prerequisite_concept_ids ?? []) {
      const ownerIndex = lessonIndexByPrimaryConcept.get(prerequisite);
      if (ownerIndex === undefined || ownerIndex >= sequence) {
        add(issue('error', 'PREREQUISITE_ORDER_INVALID', `chapters[${chapterIndex}].lessons[${lessonIndex}]`, `Prerequisite ${prerequisite} is not primarily introduced before this lesson.`, 'lesson'));
      }
    }
  }
  for (const conceptId of coreConcepts) {
    if (!strictSourceMap) break;
    if (!allPrimaryConcepts.has(conceptId)) {
      add(issue('error', 'CORE_CONCEPT_NOT_COVERED', 'blueprint', `Core Source Map concept ${conceptId} has no primary lesson owner.`, 'blueprint'));
    }
  }
  const sourceCoverage = sourceFacts.size > 0 ? Number((factCoverage.size / sourceFacts.size).toFixed(4)) : null;
  const conceptCoverage = coreConcepts.size > 0 ? Number((Array.from(coreConcepts).filter(id => allPrimaryConcepts.has(id)).length / coreConcepts.size).toFixed(4)) : null;
  return {
    status: errors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'PASS_WITH_WARNINGS' : 'PASS',
    score_summary: { source_coverage: sourceCoverage, concept_coverage: conceptCoverage },
    errors,
    warnings,
    info,
    concept_ownership: ownership,
  };
}
