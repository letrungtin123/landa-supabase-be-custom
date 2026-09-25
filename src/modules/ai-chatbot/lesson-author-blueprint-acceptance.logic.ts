import { AppError } from '../../middleware/error-handler.js';
import {
  validateLessonAuthorBlueprintArchitecture,
  type BlueprintArchitecture, type BlueprintArchitectureValidationResult, type LessonAuthorSourceMap,
} from './lesson-author-blueprint-validator.logic.js';

/** A terminal acceptance failure retains metadata, never the private blueprint. */
export class BlueprintAcceptanceError extends AppError {
  readonly failure_stage = 'node_blueprint_validation';
  readonly internal_failure_code = 'LESSON_AUTHOR_BLUEPRINT_ARCHITECTURE_INVALID';
  constructor(readonly diagnostics: ReturnType<typeof blueprintValidationDiagnostics>) {
    super('Bản thiết kế khóa học không đạt kiểm tra kiến trúc và provenance.', 422, 'LESSON_AUTHOR_BLUEPRINT_ARCHITECTURE_INVALID');
  }
}

export function blueprintValidationDiagnostics(result: BlueprintArchitectureValidationResult) {
  const findings = [...result.errors, ...result.warnings, ...result.info];
  return {
    status: result.status,
    error_count: result.errors.length, warning_count: result.warnings.length, info_count: result.info.length,
    score_summary: result.score_summary,
    findings: findings.slice(0, 40).map(item => ({
      code: /^[A-Z][A-Z0-9_]{0,95}$/.test(item.code) ? item.code : 'UNKNOWN_VALIDATION_CODE',
      severity: item.severity,
      path: /^(?:blueprint|source_map|chapters\[\d+\](?:\.lessons\[\d+\])?(?:\.units\[\d+\])?)$/.test(item.path) ? item.path : 'unknown_path',
      repair_scope: item.repair_scope,
    })),
    omitted_finding_count: Math.max(0, findings.length - 40),
  };
}

/** Counts only: never log titles, objective text, arbitrary metadata or raw IDs. */
export function blueprintBoundaryCounts(value: unknown) {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
  const raw = record(value);
  const chapters = array(raw.chapters);
  const lessons = chapters.flatMap(c => array(record(c).lessons));
  const units = lessons.flatMap(l => array(record(l).units));
  const blocks = units.flatMap(u => array(record(u).learning_blocks));
  const plans = units.flatMap(u => array(record(u).component_plan));
  const components: Record<string, number> = {};
  for (const plan of plans) {
    const type = record(plan).type;
    const key = typeof type === 'string' && ['html', 'problem', 'la_faq', 'la_crossword', 'la_diagram', 'la_sortable'].includes(type) ? type : 'unsupported';
    components[key] = (components[key] ?? 0) + 1;
  }
  return {
    architecture_contract_version: [3, 4, 5].includes(Number(raw.architecture_contract_version)) ? raw.architecture_contract_version : null,
    component_capability_version: record(raw.component_capabilities).version === 2 ? 2 : null,
    chapter_count: chapters.length, lesson_count: lessons.length, unit_count: units.length, block_count: blocks.length,
    component_count_by_type: components,
    primary_scope_reference_count: blocks.reduce<number>((n, b) => n + array(record(b).primary_evidence_scope_ids).length, 0),
    supporting_scope_reference_count: blocks.reduce<number>((n, b) => n + array(record(b).supporting_evidence_scope_ids).length, 0),
    allocated_fact_count: typeof record(raw.source_fact_allocation).allocated_count === 'number' ? record(raw.source_fact_allocation).allocated_count : null,
    media_plan_count: units.filter(u => Boolean(record(u).media_plan)).length,
  };
}

/** The same production gate is exercised with fake persistence in offline tests. */
export async function acceptAndPersistLessonAuthorBlueprint<T>(
  blueprint: BlueprintArchitecture,
  sourceMap: LessonAuthorSourceMap | null | undefined,
  report: (diagnostics: ReturnType<typeof blueprintValidationDiagnostics>) => void,
  persist: (validation: BlueprintArchitectureValidationResult) => Promise<T>,
): Promise<T> {
  const validation = validateLessonAuthorBlueprintArchitecture(blueprint, sourceMap);
  const diagnostics = blueprintValidationDiagnostics(validation);
  report(diagnostics);
  if (validation.status === 'FAIL') throw new BlueprintAcceptanceError(diagnostics);
  return persist(validation);
}
