import { readIdmCourseDesign, type IdmCourseDesignV1 } from './lesson-author-idm.contract.js';

/**
 * Read-only author guidance of an IDM run (QC course 234653, R3/R4), derived on
 * every read from the stored `course_skeleton` artifact (`payload.idm`). Nothing
 * here is persisted or hashed, so runs published before this projection existed
 * show it too and Apply/inventory parity is untouched.
 *
 * - `hold_items`: every Hold block with its reason, SME question and the Must
 *   Dos it keeps out of the lessons (statements, never ids).
 * - `pending_objectives`: objectives whose every Must Do is held; the skeleton
 *   no longer shows them to learners as outcomes ("chờ SME").
 * - `nice_to_know`: blocks the methodology keeps out of the lessons; the author
 *   may add one back by hand.
 */
export interface IdmAuthorGuidanceHoldItemV1 {
  name: string;
  reason: string | null;
  sme_question: string | null;
  blocked_must_dos: string[];
}

export interface IdmAuthorGuidanceSkippedBlockV1 {
  name: string;
  summary: string;
}

export interface IdmAuthorGuidanceV1 {
  hold_items: IdmAuthorGuidanceHoldItemV1[];
  pending_objectives: string[];
  nice_to_know: IdmAuthorGuidanceSkippedBlockV1[];
}

/** Bounds of the read projection (the dashboard parser enforces the same). */
export const IDM_GUIDANCE_MAX_HOLD_ITEMS = 200;
export const IDM_GUIDANCE_MAX_NICE_TO_KNOW = 400;

/** Author text for the editor surface: no `<`/`>` (R10), and the W2 placeholder "-" means none. */
function authorText(value: string): string | null {
  const text = value.replace(/</g, '‹').replace(/>/g, '›').trim();
  return text && text !== '-' ? text : null;
}

/** Objectives whose every Must Do is blocked (mirror of Python `pending_objective_ids`). */
export function idmPendingObjectiveIds(design: Pick<IdmCourseDesignV1,
  'learning_objectives' | 'must_dos' | 'blocked_must_do_ids'>): string[] {
  const blocked = new Set(design.blocked_must_do_ids);
  return design.learning_objectives.filter(objective => {
    const ids = design.must_dos.filter(mustDo => mustDo.lo_id === objective.lo_id).map(mustDo => mustDo.must_do_id);
    return ids.length > 0 && ids.every(id => blocked.has(id));
  }).map(objective => objective.lo_id);
}

export function buildIdmAuthorGuidance(design: IdmCourseDesignV1): IdmAuthorGuidanceV1 {
  const mustDo = new Map(design.must_dos.map(item => [item.must_do_id, item.statement]));
  const objective = new Map(design.learning_objectives.map(item => [item.lo_id, item.statement]));
  const classification = new Map(design.blueprint.map(row => [row.block_id, row.classification]));
  return {
    hold_items: design.hold_items.slice(0, IDM_GUIDANCE_MAX_HOLD_ITEMS).map(item => ({
      name: authorText(item.name) ?? item.block_id,
      reason: authorText(item.reason),
      sme_question: authorText(item.sme_question),
      blocked_must_dos: item.blocked_must_do_ids.map(id => mustDo.get(id)).filter((value): value is string => !!value)
        .map(value => authorText(value)!).filter(Boolean),
    })),
    pending_objectives: idmPendingObjectiveIds(design).map(id => authorText(objective.get(id) ?? ''))
      .filter((value): value is string => !!value),
    nice_to_know: design.blocks.filter(block => classification.get(block.block_id) === 'nice_to_know')
      .slice(0, IDM_GUIDANCE_MAX_NICE_TO_KNOW)
      .map(block => ({ name: authorText(block.name) ?? block.block_id, summary: authorText(block.summary) ?? '' })),
  };
}

/**
 * Guidance for the course node of an IDM run, or `null` (legacy run, no
 * skeleton yet, or a stored design this reader cannot verify). Never throws:
 * the guidance is advisory and must not make the workspace read fail.
 */
export function readIdmAuthorGuidance(storedDesign: unknown): IdmAuthorGuidanceV1 | null {
  if (storedDesign === null || storedDesign === undefined) return null;
  try {
    return buildIdmAuthorGuidance(readIdmCourseDesign(storedDesign));
  } catch {
    return null;
  }
}

/** Bound of the author-notes SME list (the course note itself shows only 10). */
export const IDM_GUIDANCE_MAX_SME_QUESTIONS = 300;
/** Internal identifiers never shown to authors (mirror of Python `notes._INTERNAL_ID_RE`). */
const INTERNAL_ID = /\[?\b(?:cb_\d{4}|sec_\d{3}|lo_\d{1,2}|md_\d{1,2}|lsn_\d{3}|mod_\d{2}|pt_\d|idmcb_[0-9a-f]{32}|cp2_[0-9a-f]{32}|ao2_[0-9a-f]{32}|scope3_[0-9a-z_]+)\b\]?/g;

/**
 * The complete "other questions for the SME" list (QLT-3), in the order of the
 * Python course note (`architecture._build_notes`): blocks with a conflict or
 * outdated issue first, then the rest; Hold blocks are left out (their
 * question is on the Hold item); duplicates once. The free-text note truncates
 * this list after ten questions ("và N mục khác"); author notes keep it whole.
 */
export function idmAuthorSmeQuestions(design: Pick<IdmCourseDesignV1, 'blocks' | 'hold_items'>): string[] {
  const held = new Set(design.hold_items.map(item => item.block_id));
  const urgent = (block: IdmCourseDesignV1['blocks'][number]) => block.issues.some(issue => issue.type === 'conflict' || issue.type === 'outdated');
  const ordered = [...design.blocks.filter(urgent), ...design.blocks.filter(block => !urgent(block))];
  const questions = ordered.filter(block => !held.has(block.block_id)).flatMap(block => block.sme_questions)
    .map(question => authorText(question.replace(INTERNAL_ID, '').replace(/(?<=\S)[ \t]{2,}/g, ' ')))
    .filter((question): question is string => !!question);
  return [...new Set(questions)].slice(0, IDM_GUIDANCE_MAX_SME_QUESTIONS);
}

/**
 * Guidance persisted in the course-root author notes at Apply: the workspace
 * guidance plus the complete SME question list. The workspace read keeps its
 * exact three-key contract (`readIdmAuthorGuidance`), so the dashboard's
 * strict workspace parser is unaffected. Never throws.
 */
export function readIdmAuthorNotesGuidance(storedDesign: unknown): (IdmAuthorGuidanceV1 & { sme_questions: string[] }) | null {
  if (storedDesign === null || storedDesign === undefined) return null;
  try {
    const design = readIdmCourseDesign(storedDesign);
    return { ...buildIdmAuthorGuidance(design), sme_questions: idmAuthorSmeQuestions(design) };
  } catch {
    return null;
  }
}
