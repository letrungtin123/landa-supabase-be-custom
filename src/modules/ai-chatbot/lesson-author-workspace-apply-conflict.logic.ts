// ═══════════════════════════════════════════════════════════════
// Apply conflict protection — pure classification of course-block drift
//
// Every Applied block has a mapping row that stores the exact row hash written
// by that Apply (target_hash). When the live block hash differs, an author (or
// a publish) changed the block afterwards:
//   - content drift (same block identity/position): may be overwritten, but
//     only after the author confirms the exact listed set (confirmation token);
//     drift on blocks this Apply does not write is left untouched and allowed;
//   - structural drift (deleted, moved, re-typed, identity metadata removed):
//     the mapping identity is immutable, so it can never be overwritten.
// ═══════════════════════════════════════════════════════════════

import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';

/** Items returned to the browser; the total is always reported. */
export const WORKSPACE_APPLY_CONFLICT_ITEM_LIMIT = 50;

export type WorkspaceApplyConflictCode = 'WORKSPACE_APPLY_COURSE_EDITED' | 'WORKSPACE_APPLY_COURSE_STRUCTURE_CHANGED';
export type WorkspaceApplyConflictKind = 'chapter' | 'lesson' | 'unit' | 'component';

export interface WorkspaceApplyConflictItem {
  node_id: string;
  kind: WorkspaceApplyConflictKind;
  /** Current course block name (what the author sees in the course outline). */
  title: string;
}

export interface WorkspaceApplyConflictDetails {
  items: WorkspaceApplyConflictItem[];
  total: number;
  /** Only for COURSE_EDITED: echo it back as `overwrite_confirmation`. */
  overwrite_confirmation: string | null;
}

/** Thrown from inside the Apply transaction (rolls everything back). The
 * `code` field keeps the WorkspaceApplyError contract (`error.code`). */
export class WorkspaceApplyConflictError extends Error {
  constructor(readonly code: WorkspaceApplyConflictCode, readonly details: WorkspaceApplyConflictDetails) {
    super(code); this.name = 'WorkspaceApplyConflictError';
  }
}

export interface WorkspaceApplyMappingEvidence {
  node_id: string;
  target_block_id: string;
  target_parent_id: string;
  target_block_type: string;
  target_sort_order: number;
  target_hash: string;
  /** NULL when the block was deleted (or its course was). */
  actual_target_hash: string | null;
}

export interface WorkspaceApplyBlockEvidence {
  id: string;
  display_name: string | null;
  block_type: string;
  parent_id: string | null;
  sort_order: number;
  deleted: boolean;
  workspace_id: string | null;
  workspace_node_id: string | null;
  generated_by: string | null;
}

export interface WorkspaceApplyNodeRef {
  node_id: string;
  kind: string;
  canonical_path: string;
}

export interface WorkspaceApplyDrift {
  /** Content-only drift, eligible for confirmed overwrite or left untouched. */
  content: Array<WorkspaceApplyConflictItem & { canonical_path: string; actual_target_hash: string }>;
  /** Never overwritable. */
  structural: Array<WorkspaceApplyConflictItem & { canonical_path: string }>;
}

const KINDS = new Set<WorkspaceApplyConflictKind>(['chapter', 'lesson', 'unit', 'component']);

function item(node: WorkspaceApplyNodeRef | undefined, mapping: WorkspaceApplyMappingEvidence, block: WorkspaceApplyBlockEvidence | undefined) {
  const kind = node && KINDS.has(node.kind as WorkspaceApplyConflictKind) ? node.kind as WorkspaceApplyConflictKind : 'component';
  const title = typeof block?.display_name === 'string' ? block.display_name.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return { node_id: mapping.node_id, kind, title, canonical_path: node?.canonical_path ?? '' };
}

/**
 * Split drifted mappings into content drift and structural drift. A mapping
 * whose live hash equals its recorded hash is not drift and is ignored.
 */
export function classifyWorkspaceApplyDrift(input: {
  workspace_id: string;
  nodes: readonly WorkspaceApplyNodeRef[];
  mappings: readonly WorkspaceApplyMappingEvidence[];
  blocks: readonly WorkspaceApplyBlockEvidence[];
}): WorkspaceApplyDrift {
  const nodes = new Map(input.nodes.map(node => [node.node_id, node]));
  const blocks = new Map(input.blocks.map(block => [block.id, block]));
  const drift: WorkspaceApplyDrift = { content: [], structural: [] };
  for (const mapping of input.mappings) {
    if (mapping.actual_target_hash !== null && mapping.actual_target_hash === mapping.target_hash) continue;
    const block = blocks.get(mapping.target_block_id), node = nodes.get(mapping.node_id);
    const sameIdentity = !!block && !block.deleted && mapping.actual_target_hash !== null
      && block.parent_id === mapping.target_parent_id && block.sort_order === mapping.target_sort_order
      && block.block_type === mapping.target_block_type && block.workspace_id === input.workspace_id
      && block.workspace_node_id === mapping.node_id && block.generated_by === 'lesson_author_ai';
    if (sameIdentity) drift.content.push({ ...item(node, mapping, block), actual_target_hash: mapping.actual_target_hash! });
    else drift.structural.push(item(node, mapping, block));
  }
  const byPath = (a: { canonical_path: string; node_id: string }, b: { canonical_path: string; node_id: string }) =>
    a.canonical_path.localeCompare(b.canonical_path) || a.node_id.localeCompare(b.node_id);
  drift.content.sort(byPath); drift.structural.sort(byPath);
  return drift;
}

/** Binds a confirmation to the exact drifted blocks and their live hashes, so a
 * later edit of the same or another block requires a new confirmation. */
export function workspaceApplyOverwriteToken(workspaceId: string, items: ReadonlyArray<{ node_id: string; actual_target_hash: string }>): string {
  return hash({ workspace_id: workspaceId, overwrite: [...items].map(entry => [entry.node_id, entry.actual_target_hash])
    .sort((a, b) => a[0].localeCompare(b[0])) });
}

export function workspaceApplyConflictDetails(
  items: ReadonlyArray<WorkspaceApplyConflictItem>, overwriteConfirmation: string | null,
): WorkspaceApplyConflictDetails {
  return {
    items: items.slice(0, WORKSPACE_APPLY_CONFLICT_ITEM_LIMIT).map(entry => ({ node_id: entry.node_id, kind: entry.kind, title: entry.title })),
    total: items.length,
    overwrite_confirmation: overwriteConfirmation,
  };
}

/**
 * Decide the overwrite step after compilation: `writes` are the node ids this
 * Apply will (re)write. Returns the conflict to raise, or null when the Apply
 * may proceed (no drifted block is written, or the author confirmed exactly
 * this drift set).
 */
export function workspaceApplyOverwriteDecision(input: {
  workspace_id: string;
  drift: WorkspaceApplyDrift;
  write_node_ids: ReadonlySet<string>;
  overwrite_confirmation: string | null;
}): WorkspaceApplyConflictError | null {
  const overwrite = input.drift.content.filter(entry => input.write_node_ids.has(entry.node_id));
  if (!overwrite.length) return null;
  const token = workspaceApplyOverwriteToken(input.workspace_id, overwrite);
  if (input.overwrite_confirmation === token) return null;
  return new WorkspaceApplyConflictError('WORKSPACE_APPLY_COURSE_EDITED', workspaceApplyConflictDetails(overwrite, token));
}
