import { GENERATION_JOB_DEADLINE_MS, generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';

export class WorkspaceBudgetError extends Error {
  constructor(readonly code: 'WORKSPACE_BUDGET_INVALID' | 'WORKSPACE_CHAPTER_BUDGET_CAPACITY_EXCEEDED' | 'WORKSPACE_BUDGET_EXHAUSTED') { super(code); }
}
export interface WorkspaceBudgetEntry {
  ordinal: number; node_id: string; kind: 'generate_unit' | 'validate_chapter'; contract_hash: string;
  input_tokens: number; output_tokens: number; embedding_tokens: number;
  max_output_tokens: number; max_provider_attempts: number; execution_budget_ms: number;
}
export interface WorkspaceBudgetManifest { version: 1; entries: WorkspaceBudgetEntry[]; }
export interface WorkspaceChapterBudgetInput {
  chapter_node_id: string; chapter_contract_hash: string;
  units: Array<{ node_id: string; contract_hash: string }>;
  /** Prepared by EXISTING buildAiTurnTokenBudget / grantedOutputTokenLimit.
   * These are admission estimates, never Gemini observed usage. */
  fixed_input_tokens: number; embedding_tokens: number; output_tokens: number; max_provider_attempts: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
function fail(): never { throw new WorkspaceBudgetError('WORKSPACE_BUDGET_INVALID'); }
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(); return value;
}
const sum = (values: number[]) => integer(values.reduce((n, v) => n + integer(v), 0));

/** Freeze one finite inventory of unit invocations plus final chapter checks.
 * This is NOT a new provider output/retry setting and performs no reservation.
 * The sum equals legacy chapter admission I*(U*A+1)+E*(U+1)+O*U*A.
 * Existing per-chapter 2m ceiling remains; monthly quota still gates each grant.
 * No pause/queue wall-clock expiry or automatic recovery is inferred here. */
export function buildWorkspaceBudgetManifest(chapters: readonly WorkspaceChapterBudgetInput[]) {
  if (!Array.isArray(chapters) || !chapters.length || chapters.length > 4096) fail();
  const entries: WorkspaceBudgetEntry[] = [], nodeIds = new Set<string>();
  for (const chapter of chapters) {
    const I = integer(chapter.fixed_input_tokens, 1), E = integer(chapter.embedding_tokens), O = integer(chapter.output_tokens, 1), A = integer(chapter.max_provider_attempts, 1);
    if (O > 65_536 || A > 2) fail();
    if (!Array.isArray(chapter.units) || !chapter.units.length || chapter.units.length > 512) fail();
    const total = sum([I * (chapter.units.length * A + 1), E * (chapter.units.length + 1), O * chapter.units.length * A]);
    if (total > 2_000_000) throw new WorkspaceBudgetError('WORKSPACE_CHAPTER_BUDGET_CAPACITY_EXCEEDED');
    function push(nodeId: string, contract: string, kind: WorkspaceBudgetEntry['kind']) {
      if (!UUID.test(nodeId) || nodeIds.has(nodeId) || !HASH.test(contract)) fail();
      nodeIds.add(nodeId);
      const generate = kind === 'generate_unit';
      entries.push({ ordinal: entries.length, node_id: nodeId, kind, contract_hash: contract,
        input_tokens: generate ? I * A : I, embedding_tokens: E, output_tokens: generate ? O * A : 0,
        max_output_tokens: generate ? O : 0, max_provider_attempts: generate ? A : 0,
        execution_budget_ms: GENERATION_JOB_DEADLINE_MS });
      if (entries.length > 8192) fail();
    }
    for (const u of chapter.units) push(u.node_id, u.contract_hash, 'generate_unit');
    push(chapter.chapter_node_id, chapter.chapter_contract_hash, 'validate_chapter');
  }
  const manifest: WorkspaceBudgetManifest = { version: 1, entries };
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 4 * 1024 * 1024) fail();
  return { manifest, manifest_hash: hash(manifest), token_ceiling: sum(entries.map(e => sum([e.input_tokens, e.output_tokens, e.embedding_tokens]))),
    execution_budget_ms: sum(entries.map(e => e.execution_budget_ms)), usage_source: 'local_estimate' as const };
}

/** Admission consumes an authorized ordinal once. Known savings and unknown
 * holds NEVER create permission for another identical paid invocation. An
 * explicit recovery attempt needs its own reviewed policy, not this helper. */
export function workspaceBudgetForNextItem(manifest: WorkspaceBudgetManifest, expectedHash: string,
  completedOrdinals: readonly number[], pendingOrdinal: number | null) {
  if (manifest.version !== 1 || !HASH.test(expectedHash) || hash(manifest) !== expectedHash
    || !Array.isArray(manifest.entries) || !manifest.entries.length || pendingOrdinal !== null) fail();
  if (completedOrdinals.some((ordinal, i) => ordinal !== i) || completedOrdinals.length > manifest.entries.length) fail();
  const next = manifest.entries[completedOrdinals.length];
  if (!next) throw new WorkspaceBudgetError('WORKSPACE_BUDGET_EXHAUSTED');
  if (next.ordinal !== completedOrdinals.length) fail();
  return structuredClone(next);
}
