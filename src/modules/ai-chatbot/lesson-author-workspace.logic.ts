import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';

/** Draft/revision contract only. Not a provider, payload validator or Apply API. */
export const WORKSPACE_CONTRACT_VERSION = 1;
export const WORKSPACE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_EVENT_PAGE_SIZE = 100;
export type WorkspaceLocale = 'vi' | 'en';
export type WorkspaceNodeKind = 'course' | 'chapter' | 'lesson' | 'unit' | 'component' | 'media_brief';
export type WorkspaceContentState = 'planned' | 'generating' | 'content_ready' | 'needs_action';
export type WorkspaceCheck = 'PASS' | 'FAIL' | 'NOT_RUN';
export type WorkspaceErrorCode =
  | 'WORKSPACE_CONTRACT_INVALID' | 'WORKSPACE_LOCALE_INVALID'
  | 'WORKSPACE_REVISION_CONFLICT' | 'WORKSPACE_NODE_NOT_READY'
  | 'WORKSPACE_NODE_FIELD_PROTECTED' | 'WORKSPACE_CONTENT_INVALID'
  | 'WORKSPACE_APPLY_SCOPE_INVALID' | 'WORKSPACE_APPLY_VALIDATION_REQUIRED'
  | 'WORKSPACE_SOURCE_CHANGED' | 'WORKSPACE_APPLY_TARGET_CHANGED'
  | 'WORKSPACE_EVENT_RESNAPSHOT_REQUIRED';

export class WorkspaceContractError extends Error {
  constructor(readonly code: WorkspaceErrorCode) { super(code); this.name = 'WorkspaceContractError'; }
}

export type WorkspaceJson = null | boolean | number | string | WorkspaceJson[] | { [key: string]: WorkspaceJson };
export interface WorkspaceContent {
  title: string;
  purpose: string | null;
  /** Existing typed component payload, NOT a second prose copy for the modal. */
  data: WorkspaceJson;
  implementation_notes: string | null;
}
export interface WorkspaceNodeSnapshot {
  node_id: string;
  kind: WorkspaceNodeKind;
  content_state: WorkspaceContentState;
  current_revision: number | null;
  baseline: WorkspaceContent | null;
  current: WorkspaceContent | null;
}
export interface WorkspaceRevisionCandidate {
  revision: number;
  parent_revision: number;
  origin: 'author_edit' | 'author_reset';
  content: WorkspaceContent;
  content_hash: string;
  user_modified: boolean;
  validation_state: 'pending';
}

const CONTENT_FIELDS = ['title', 'purpose', 'data', 'implementation_notes'] as const;
const PROTECTED = new Set([
  '__proto__', 'prototype', 'constructor', 'source_fact_ids', 'source_refs',
  'primary_evidence_scope_ids', 'supporting_evidence_scope_ids', 'learning_objective_refs',
  'primary_concept_ids', 'source_concept_ids', 'component_plan_id', 'parent_id',
  'node_id', 'workspace_id', 'tenant_id', 'course_id', 'sort_order',
]);
function fail(code: WorkspaceErrorCode): never { throw new WorkspaceContractError(code); }
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function json(value: unknown, depth = 0, ancestors = new Set<object>()): WorkspaceJson {
  if (depth > 48) fail('WORKSPACE_CONTENT_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) fail('WORKSPACE_CONTENT_INVALID');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, item => json(item, depth + 1, ancestors));
    if (!plain(value) || Object.getOwnPropertySymbols(value).length) fail('WORKSPACE_CONTENT_INVALID');
    const pairs: Array<[string, WorkspaceJson]> = [];
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (PROTECTED.has(key)) fail('WORKSPACE_NODE_FIELD_PROTECTED');
      if (!('value' in descriptor) || !descriptor.enumerable) fail('WORKSPACE_CONTENT_INVALID');
      pairs.push([key, json(descriptor.value, depth + 1, ancestors)]);
    }
    return Object.fromEntries(pairs);
  } finally { ancestors.delete(value); }
}

/** Exact locale only: transport cannot silently mutate a run's frozen language. */
export function workspaceLocale(value: unknown): WorkspaceLocale {
  if (value !== 'vi' && value !== 'en') fail('WORKSPACE_LOCALE_INVALID');
  return value;
}

/** Structural envelope. Registry/sanitization/pedagogy acceptance is STILL required. */
export function readWorkspaceContent(value: unknown): WorkspaceContent {
  if (!plain(value)) fail('WORKSPACE_CONTENT_INVALID');
  const keys = Object.keys(value);
  if (keys.some(key => !(CONTENT_FIELDS as readonly string[]).includes(key))) fail('WORKSPACE_NODE_FIELD_PROTECTED');
  if (keys.length !== CONTENT_FIELDS.length) fail('WORKSPACE_CONTENT_INVALID');
  const copy = json(value) as unknown as WorkspaceContent;
  if (typeof copy.title !== 'string' || !copy.title.trim() || copy.title.length > 500) fail('WORKSPACE_CONTENT_INVALID');
  for (const field of ['purpose', 'implementation_notes'] as const) {
    if (copy[field] !== null && (typeof copy[field] !== 'string' || copy[field].length > 8000)) fail('WORKSPACE_CONTENT_INVALID');
  }
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > WORKSPACE_CONTENT_MAX_BYTES) fail('WORKSPACE_CONTENT_INVALID');
  return copy;
}

function assertEditable(node: WorkspaceNodeSnapshot, expected: unknown): number {
  if (node.content_state !== 'content_ready' || node.baseline === null || node.current === null
    || !safeInteger(node.current_revision)) fail('WORKSPACE_NODE_NOT_READY');
  if (!safeInteger(expected) || expected !== node.current_revision) fail('WORKSPACE_REVISION_CONFLICT');
  if (expected >= Number.MAX_SAFE_INTEGER) fail('WORKSPACE_CONTRACT_INVALID');
  return expected;
}

/** Candidate only: repository must validate then CAS-persist; never grants Apply authority. */
export function prepareWorkspaceEdit(node: WorkspaceNodeSnapshot, request: unknown): WorkspaceRevisionCandidate {
  if (!plain(request)) fail('WORKSPACE_CONTENT_INVALID');
  if (Object.keys(request).some(key => key !== 'expected_revision' && key !== 'changes')) fail('WORKSPACE_NODE_FIELD_PROTECTED');
  const expected = assertEditable(node, request.expected_revision);
  if (!plain(request.changes) || !Object.keys(request.changes).length) fail('WORKSPACE_CONTENT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(request.changes);
  if (Object.getOwnPropertySymbols(request.changes).length) fail('WORKSPACE_NODE_FIELD_PROTECTED');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!(CONTENT_FIELDS as readonly string[]).includes(key)) fail('WORKSPACE_NODE_FIELD_PROTECTED');
    if (!('value' in descriptor) || !descriptor.enumerable) fail('WORKSPACE_CONTENT_INVALID');
  }
  const content = readWorkspaceContent({ ...node.current, ...request.changes });
  const baseline = readWorkspaceContent(node.baseline);
  return {
    revision: expected + 1, parent_revision: expected, origin: 'author_edit', content,
    content_hash: generationSnapshotHash(content),
    user_modified: generationSnapshotHash(content) !== generationSnapshotHash(baseline), validation_state: 'pending',
  };
}

export function prepareWorkspaceReset(node: WorkspaceNodeSnapshot, expectedRevision: unknown): WorkspaceRevisionCandidate {
  const expected = assertEditable(node, expectedRevision);
  const content = readWorkspaceContent(node.baseline);
  return { revision: expected + 1, parent_revision: expected, origin: 'author_reset', content,
    content_hash: generationSnapshotHash(content), user_modified: false, validation_state: 'pending' };
}

const PARENT_KIND: Record<Exclude<WorkspaceNodeKind, 'course'>, WorkspaceNodeKind> = {
  chapter: 'course', lesson: 'chapter', unit: 'lesson', component: 'unit', media_brief: 'unit',
};
export function assertWorkspaceParent(kind: WorkspaceNodeKind, parentKind: WorkspaceNodeKind | null): void {
  if (!(kind === 'course' ? parentKind === null : PARENT_KIND[kind] !== undefined && PARENT_KIND[kind] === parentKind)) {
    fail('WORKSPACE_CONTRACT_INVALID');
  }
}

export interface WorkspaceApplyValidation {
  scope_id: string;
  revision_set_hash: string;
  source_snapshot_hash: string;
  target_snapshot_hash: string;
  checks: Record<'schema' | 'evidence' | 'pedagogy' | 'coverage' | 'duplicates' | 'dependencies' | 'registry', WorkspaceCheck>;
}
/** Server-only proof binding; API must never accept this proof from a browser. */
export function assertWorkspaceApplyReady(input: {
  scope_id: string; kind: WorkspaceNodeKind; complete: boolean;
  revision_set_hash: string; source_snapshot_hash: string; target_snapshot_hash: string;
  validation: WorkspaceApplyValidation | null;
}): void {
  if (!['chapter', 'lesson', 'unit', 'component'].includes(input.kind)) fail('WORKSPACE_APPLY_SCOPE_INVALID');
  const proof = input.validation;
  const hash = /^[0-9a-f]{64}$/;
  if (!input.complete || !proof || !input.scope_id || proof.scope_id !== input.scope_id
    || !hash.test(input.revision_set_hash) || !hash.test(input.source_snapshot_hash) || !hash.test(input.target_snapshot_hash)
    || proof.revision_set_hash !== input.revision_set_hash) fail('WORKSPACE_APPLY_VALIDATION_REQUIRED');
  if (proof.source_snapshot_hash !== input.source_snapshot_hash) fail('WORKSPACE_SOURCE_CHANGED');
  if (proof.target_snapshot_hash !== input.target_snapshot_hash) fail('WORKSPACE_APPLY_TARGET_CHANGED');
  if (!['schema', 'evidence', 'pedagogy', 'coverage', 'duplicates', 'dependencies', 'registry']
    .every(key => proof.checks?.[key as keyof WorkspaceApplyValidation['checks']] === 'PASS')) {
    fail('WORKSPACE_APPLY_VALIDATION_REQUIRED');
  }
}

/** Gap/expired cursor must re-snapshot, never manufacture missed node state. */
export function workspaceEventCursor(after: unknown, earliestRetained: number, head: number): number {
  if (!safeInteger(after) || !safeInteger(earliestRetained) || !safeInteger(head)
    || earliestRetained > head + 1 || after > head || after < earliestRetained - 1) {
    fail('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
  }
  return after;
}
