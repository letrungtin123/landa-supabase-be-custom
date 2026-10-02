import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { readWorkspaceContent, type WorkspaceContent } from './lesson-author-workspace.logic.js';
import { loadWorkspaceGenerationContext, loadWorkspaceChapterGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';

/** Server-only lifecycle for ALREADY admitted work. No imports of connections,
 * config, providers, quota services, timers or routes. Admission, manifest building,
 * baseline acceptance/materialization and deployment schema readiness belong to caller.
 * All callbacks must use the supplied transaction and must never call a provider.
 */
export interface WorkspaceWorkItemLease {
  tenantId: string; courseId: string; conversationId: string; userId: string;
  workspaceId: string; workItemId: string; leaseToken: string;
}
export type WorkspaceWorkItemStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'outcome_unknown' | 'canceled';
export interface WorkspaceWorkItemContext {
  target: Readonly<WorkspaceWorkItemLease>;
  node_id: string; kind: 'generate_unit' | 'validate_chapter'; ordinal: number;
  source_snapshot_hash: string; runtime_config_hash: string; inventory_hash: string; manifest_hash: string;
  contract_hash: string; input_context_hash: string; ai_reservation_id: string;
  reserved_tokens: number; max_output_tokens: number; max_provider_attempts: number;
  correlation_id: string; content_locale: 'vi' | 'en'; dispatched: boolean;
}
export interface WorkspaceWorkItemAccounting {
  state: 'settled' | 'pending_reconciliation';
  usage_complete: boolean;
  observed_usage: Readonly<{
    inputTokens?: number; outputTokens?: number; embeddingTokens?: number; totalTokens?: number;
    usage_source?: 'provider' | 'no_generation' | 'mixed_or_unavailable' | 'local_estimate' | 'unavailable';
  }>;
}
export interface WorkspaceUnitBaselineWrite {
  node_id: string; contract_hash: string; content: WorkspaceContent; content_hash: string;
}
export interface WorkspaceUnitPublication {
  input_context_hash: string;
  result_hash: string;
  validation_contract: 'workspace-unit-baseline-1';
  /** Must come from real Node/Python acceptance, never a browser or raw provider payload. */
  baselines: readonly WorkspaceUnitBaselineWrite[];
}
export interface WorkspaceWorkItemReceipt {
  workspace_id: string; work_item_id: string; node_id: string; status: WorkspaceWorkItemStatus;
  accounting_state: 'reserved' | 'settled' | 'pending_reconciliation';
  result_hash: string | null; replayed: boolean; unit_ready_sequence?: number;
}
export interface WorkspaceWorkItemDiagnostic {
  event: 'workspace_work_item_operation';
  operation: 'prepare_unit' | 'prepare_chapter' | 'renew' | 'dispatch' | 'publish_unit' | 'complete_validation' | 'fail' | 'recover';
  workspace_id: string; work_item_id: string; correlation_id: string | null; node_id: string | null;
  status: 'COMMITTED' | 'REPLAYED' | 'FAIL'; internal_failure_code: string | null;
  baseline_count: number; duration_ms: number;
}
export type WorkspaceWorkItemErrorCode = 'WORKSPACE_WORK_ITEM_INVALID' | 'WORKSPACE_WORK_ITEM_FORBIDDEN'
  | 'WORKSPACE_WORK_ITEM_NOT_FOUND' | 'WORKSPACE_WORK_ITEM_LEASE_LOST' | 'WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED'
  | 'WORKSPACE_WORK_ITEM_CONFLICT' | 'WORKSPACE_WORK_ITEM_SOURCE_CHANGED' | 'WORKSPACE_WORK_ITEM_RUNTIME_CHANGED'
  | 'WORKSPACE_WORK_ITEM_ACCOUNTING_INVALID' | 'WORKSPACE_WORK_ITEM_READBACK_INVALID' | 'WORKSPACE_WORK_ITEM_UNAVAILABLE';
export class WorkspaceWorkItemError extends Error {
  constructor(readonly code: WorkspaceWorkItemErrorCode) { super(code); this.name = 'WorkspaceWorkItemError'; }
}
const fail = (code: WorkspaceWorkItemErrorCode): never => { throw new WorkspaceWorkItemError(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;
const terminal = new Set(['succeeded','failed','timed_out','outcome_unknown','canceled']);
function integer(value: unknown): number {
  if (!(typeof value === 'number' || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
  return Number(value);
}
function millis(value: unknown): number {
  const result = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function targetCopy(input: WorkspaceWorkItemLease) {
  const copy = Object.freeze({ ...input });
  if (![copy.tenantId,copy.userId,copy.conversationId,copy.workspaceId,copy.workItemId,copy.leaseToken].every(v => typeof v === 'string' && UUID.test(v))
    || typeof copy.courseId !== 'string' || !copy.courseId || copy.courseId.length > 255) fail('WORKSPACE_WORK_ITEM_INVALID');
  return copy;
}
const keys = (t: WorkspaceWorkItemLease) => [t.workItemId,t.workspaceId,t.tenantId,t.courseId,t.leaseToken];
const LIVE = `id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5
  AND status='running' AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`;

export function createWorkspaceWorkItemRepository(deps: {
  db: GenerationJobDatabase;
  /** Re-read/lock current actor role, tenant, memberships, permissions and assignments. */
  freshAuthority(tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>): Promise<boolean>;
  currentSourceHash(tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>): Promise<string>;
  /** Includes current model/key/config/component capabilities; never returns secrets. */
  currentRuntimeHash(tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>): Promise<string>;
  /** Existing quota services on this SAME transaction. hold must persist full reserved
   * amount + durable_generation + workspace_accounting observations; never release it.
   * Success may have pending usage while its CONTENT outcome is known. */
  account(tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>,
    mode: 'settle_or_hold' | 'release_undispatched' | 'hold_unknown'): Promise<WorkspaceWorkItemAccounting>;
  /** Safe structured metadata only; logging failure must not affect a commit. */
  report(event: WorkspaceWorkItemDiagnostic): void;
}) {
  type Track = (context: Readonly<WorkspaceWorkItemContext>) => void;
  async function fresh(tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>) {
    if (!await deps.freshAuthority(tx, context)) fail('WORKSPACE_WORK_ITEM_FORBIDDEN');
    if (await deps.currentSourceHash(tx, context) !== context.source_snapshot_hash) fail('WORKSPACE_WORK_ITEM_SOURCE_CHANGED');
    if (await deps.currentRuntimeHash(tx, context) !== context.runtime_config_hash) fail('WORKSPACE_WORK_ITEM_RUNTIME_CHANGED');
  }
  async function lock(tx: GenerationJobSql, t: Readonly<WorkspaceWorkItemLease>, track: Track, systemRecovery = false) {
    await tx.query("SET LOCAL lock_timeout = '3000ms'");
    const advisory = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`, [`course:${t.tenantId}:${t.courseId}`]);
    if (advisory.rows.length !== 1 || advisory.rows[0].acquired !== true) fail('WORKSPACE_WORK_ITEM_CONFLICT');
    const course = await tx.query(`SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [t.courseId,t.tenantId]);
    if (course.rows.length !== 1) fail('WORKSPACE_WORK_ITEM_NOT_FOUND');
    const ws = await tx.query(`SELECT w.id,w.status,w.source_snapshot_hash,w.correlation_id,w.content_locale
      FROM lesson_author_workspaces w JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id
        AND c.course_id=w.course_id AND c.user_id=w.requested_by AND c.bot_id=w.bot_id AND c.target='lesson_author'
      WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
        AND w.engine='self_built_rag' AND w.contract_version=1 FOR UPDATE OF w`,
    [t.workspaceId,t.tenantId,t.courseId,t.conversationId,t.userId]);
    if (ws.rows.length !== 1) fail('WORKSPACE_WORK_ITEM_NOT_FOUND');
    const run = await tx.query(`SELECT runtime_config_hash,inventory_hash,manifest_hash FROM lesson_author_workspace_runs
      WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 FOR UPDATE`, [t.workspaceId,t.tenantId,t.courseId]);
    if (run.rows.length !== 1) fail('WORKSPACE_WORK_ITEM_NOT_FOUND');
    const item = await tx.query(`SELECT *,clock_timestamp() AS database_now FROM lesson_author_workspace_work_items
      WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5 FOR UPDATE`, keys(t));
    if (item.rows.length !== 1) fail('WORKSPACE_WORK_ITEM_LEASE_LOST');
    const a = item.rows[0], w = ws.rows[0], r = run.rows[0];
    if (a.id !== t.workItemId || a.workspace_id !== t.workspaceId || a.tenant_id !== t.tenantId || a.course_id !== t.courseId || a.lease_token !== t.leaseToken
      || typeof a.node_id !== 'string' || !UUID.test(a.node_id) || typeof a.ai_reservation_id !== 'string' || !UUID.test(a.ai_reservation_id)
      || !['generate_unit','validate_chapter'].includes(String(a.kind)) || !['running',...terminal].includes(String(a.status))
      || !['vi','en'].includes(String(w.content_locale)) || typeof w.correlation_id !== 'string' || !UUID.test(w.correlation_id)
      || [a.contract_hash,a.input_context_hash,w.source_snapshot_hash,r.runtime_config_hash,r.inventory_hash,r.manifest_hash]
        .some(v => typeof v !== 'string' || !HASH.test(v))) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    const context = freeze({ target: t, node_id: a.node_id, kind: a.kind, ordinal: integer(a.ordinal),
      source_snapshot_hash: w.source_snapshot_hash, runtime_config_hash: r.runtime_config_hash, inventory_hash: r.inventory_hash,
      manifest_hash: r.manifest_hash, contract_hash: a.contract_hash, input_context_hash: a.input_context_hash,
      ai_reservation_id: a.ai_reservation_id, reserved_tokens: integer(a.reserved_tokens), max_output_tokens: integer(a.max_output_tokens),
      max_provider_attempts: integer(a.max_provider_attempts), correlation_id: w.correlation_id, content_locale: w.content_locale,
      dispatched: a.dispatch_started_at !== null } as WorkspaceWorkItemContext);
    track(context);
    // Expired system recovery does not grant dispatch/content authority. Revoked
    // actors or changed sources/config must not strand a paid reservation/run.
    // Exact persisted owner + token binding still applies; finish checks DB expiry.
    if (!systemRecovery) await fresh(tx, context);
    return { a, w, context };
  }
  function assertLive(a: Row, w: Row) {
    if (a.status !== 'running' || w.status !== 'drafting' || millis(a.lease_expires_at) <= millis(a.database_now)
      || millis(a.deadline_at) <= millis(a.database_now)) fail('WORKSPACE_WORK_ITEM_LEASE_LOST');
  }
  function receipt(a: Row, replayed: boolean): WorkspaceWorkItemReceipt {
    if (!['reserved','settled','pending_reconciliation'].includes(String(a.accounting_state))) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    return { workspace_id: String(a.workspace_id), work_item_id: String(a.id), node_id: String(a.node_id),
      status: a.status as WorkspaceWorkItemStatus, accounting_state: a.accounting_state as WorkspaceWorkItemReceipt['accounting_state'],
      result_hash: a.result_hash == null ? null : String(a.result_hash), replayed };
  }
  async function requery(tx: GenerationJobSql, t: WorkspaceWorkItemLease) {
    const result = await tx.query(`SELECT *,clock_timestamp() AS database_now FROM lesson_author_workspace_work_items
      WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5`, keys(t));
    if (result.rows.length !== 1 || result.rows[0].id !== t.workItemId || result.rows[0].workspace_id !== t.workspaceId
      || result.rows[0].lease_token !== t.leaseToken) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    return result.rows[0];
  }
  async function accounting(tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>,
    mode: 'settle_or_hold' | 'release_undispatched' | 'hold_unknown') {
    const raw = await deps.account(tx, context, mode);
    if (!raw || !['settled','pending_reconciliation'].includes(raw.state) || typeof raw.usage_complete !== 'boolean'
      || !raw.observed_usage || typeof raw.observed_usage !== 'object' || Array.isArray(raw.observed_usage)
      || (mode === 'hold_unknown' && raw.state !== 'pending_reconciliation')
      || (mode === 'release_undispatched' && raw.state !== 'settled')
      || (context.dispatched && !raw.usage_complete && raw.state !== 'pending_reconciliation')) fail('WORKSPACE_WORK_ITEM_ACCOUNTING_INVALID');
    const copy = freeze(structuredClone(raw));
    for (const [key, value] of Object.entries(copy.observed_usage)) {
      if (key === 'usage_source') {
        if (!['provider','no_generation','mixed_or_unavailable','local_estimate','unavailable'].includes(String(value))) fail('WORKSPACE_WORK_ITEM_ACCOUNTING_INVALID');
      } else if (!['inputTokens','outputTokens','embeddingTokens','totalTokens'].includes(key)
        || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_000_000) fail('WORKSPACE_WORK_ITEM_ACCOUNTING_INVALID');
    }
    if (copy.usage_complete) {
      const counts = ['inputTokens','outputTokens','embeddingTokens','totalTokens'].map(k => copy.observed_usage[k as keyof typeof copy.observed_usage]);
      if (counts.some(n => typeof n !== 'number') || !(copy.observed_usage.usage_source === 'provider'
        || context.kind === 'validate_chapter' && copy.observed_usage.usage_source === 'no_generation' && counts.every(n => n === 0))) fail('WORKSPACE_WORK_ITEM_ACCOUNTING_INVALID');
    }
    // SQL terminal guard also verifies finalized ledger or durable held reservation.
    return copy;
  }
  async function execute<T>(target: WorkspaceWorkItemLease, operation: WorkspaceWorkItemDiagnostic['operation'],
    work: (tx: GenerationJobSql, t: Readonly<WorkspaceWorkItemLease>, track: Track) => Promise<T>, baselineCount = 0) {
    const started = performance.now();
    let correlation: string | null = null, node: string | null = null;
    const track: Track = context => { correlation = context.correlation_id; node = context.node_id; };
    const report = (status: WorkspaceWorkItemDiagnostic['status'], internalCode: string | null) => {
      try { deps.report({ event: 'workspace_work_item_operation', operation,
        workspace_id: typeof target?.workspaceId === 'string' && UUID.test(target.workspaceId) ? target.workspaceId : '',
        work_item_id: typeof target?.workItemId === 'string' && UUID.test(target.workItemId) ? target.workItemId : '',
        correlation_id: correlation, node_id: node, status, internal_failure_code: internalCode,
        baseline_count: baselineCount, duration_ms: Math.max(0,Math.round(performance.now()-started)) }); } catch { /* telemetry is not authority */ }
    };
    try {
      const t = targetCopy(target);
      const result = await deps.db.transaction(tx => work(tx,t,track));
      report(result && typeof result === 'object' && 'replayed' in result && result.replayed === true ? 'REPLAYED' : 'COMMITTED',null);
      return result;
    } catch (e) {
      // Retain safe typed materializer/authority errors in diagnostics before mapping
      // the public transport error. Never log message, stack, SQL, content or usage.
      const record = e && typeof e === 'object' ? e as Record<string, unknown> : {};
      const candidate = record.internal_failure_code ?? record.code;
      const internalCode = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate)
        ? candidate : 'WORKSPACE_WORK_ITEM_UNAVAILABLE';
      report('FAIL',internalCode);
      if (e instanceof WorkspaceWorkItemError) throw e;
      throw new WorkspaceWorkItemError('WORKSPACE_WORK_ITEM_UNAVAILABLE');
    }
  }
  async function unitReadback(tx: GenerationJobSql, context: WorkspaceWorkItemContext, baselines: readonly WorkspaceUnitBaselineWrite[]) {
    const t = context.target;
    const rows = await tx.query(`SELECT n.id,n.contract_hash,n.content_state,n.current_revision,r.content,r.content_hash,r.operation_id
      FROM lesson_author_workspace_nodes n JOIN lesson_author_workspace_revisions r
        ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=0
      WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3
        AND (n.id=$4 OR (n.parent_id=$4 AND n.kind='component')) ORDER BY n.id LIMIT 66`,
    [t.workspaceId,t.tenantId,t.courseId,context.node_id]);
    if (rows.rows.length !== baselines.length || new Set(rows.rows.map(n => n.id)).size !== baselines.length) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    for (const expected of baselines) {
      const actual = rows.rows.find(n => n.id === expected.node_id);
      if (!actual || actual.contract_hash !== expected.contract_hash || actual.content_hash !== expected.content_hash
        || hash(actual.content) !== expected.content_hash || actual.operation_id !== t.workItemId
        || actual.content_state !== 'content_ready' || actual.current_revision === null) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    }
    const events = await tx.query(`SELECT sequence FROM lesson_author_workspace_events WHERE workspace_id=$1
      AND tenant_id=$2 AND course_id=$3 AND operation_id=$4 AND node_id=$5 AND node_revision=0 AND event_kind='unit_ready'`,
    [t.workspaceId,t.tenantId,t.courseId,t.workItemId,context.node_id]);
    if (events.rows.length !== 1 || integer(events.rows[0].sequence) < 1) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    return integer(events.rows[0].sequence);
  }
  return {
    /** Actual immutable AI context loaded under the same lease/authority locks.
     * The caller still builds the authenticated Python request outside this
     * transaction. No provider or accounting side effects are permitted here. */
    async prepareUnit(target: WorkspaceWorkItemLease, allowed: ReadonlySet<CourseComponentType>) {
      const capabilities = new Set(allowed);
      return execute(target, 'prepare_unit', async (tx,t,track) => {
        const { a,w,context } = await lock(tx,t,track); assertLive(a,w);
        if (context.kind !== 'generate_unit' || context.dispatched) fail('WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED');
        const prepared = await loadWorkspaceGenerationContext(tx,{ ...t,nodeId:context.node_id },capabilities);
        if (prepared.input_context_hash !== context.input_context_hash
          || prepared.source_snapshot_hash !== context.source_snapshot_hash || prepared.correlation_id !== context.correlation_id
          || !prepared.targetNodes.some(n=>n.id===context.node_id && n.contract_hash===context.contract_hash))
          fail('WORKSPACE_WORK_ITEM_CONFLICT');
        await fresh(tx,context);
        assertLive(await requery(tx,t),w);
        return { context:prepared, item:context, deadline_at:new Date(millis(a.deadline_at)) };
      });
    },
    async prepareChapter(target: WorkspaceWorkItemLease, allowed: ReadonlySet<CourseComponentType>) {
      const capabilities = new Set(allowed);
      return execute(target, 'prepare_chapter', async (tx,t,track) => {
        const { a,w,context } = await lock(tx,t,track); assertLive(a,w);
        if (context.kind !== 'validate_chapter' || context.dispatched) fail('WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED');
        const prepared = await loadWorkspaceChapterGenerationContext(tx,{ ...t,nodeId:context.node_id },capabilities);
        if (prepared.input_context_hash !== context.input_context_hash
          || prepared.source_snapshot_hash !== context.source_snapshot_hash || prepared.correlation_id !== context.correlation_id
          || !prepared.targetNodes.some(n=>n.id===context.node_id && n.contract_hash===context.contract_hash))
          fail('WORKSPACE_WORK_ITEM_CONFLICT');
        await fresh(tx,context);
        assertLive(await requery(tx,t),w);
        return { context:prepared, item:context, deadline_at:new Date(millis(a.deadline_at)) };
      });
    },
    async renew(target: WorkspaceWorkItemLease) {
      return execute(target, 'renew', async (tx,t,track) => {
        const { a,w,context } = await lock(tx,t,track); assertLive(a,w);
        const updated = await tx.query(`WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS ts)
          UPDATE lesson_author_workspace_work_items SET heartbeat_at=tick.ts,
            lease_expires_at=LEAST(deadline_at,tick.ts+interval '45 seconds') FROM tick
          WHERE ${LIVE} RETURNING id`, keys(t));
        if (updated.rows.length !== 1 || updated.rows[0].id !== t.workItemId) fail('WORKSPACE_WORK_ITEM_LEASE_LOST');
        await fresh(tx,context);
        const current = await requery(tx,t); assertLive(current,w);
        return receipt(current,false);
      });
    },
    async markDispatched(target: WorkspaceWorkItemLease) {
      return execute(target, 'dispatch', async (tx,t,track) => {
        const { a,w,context } = await lock(tx,t,track); assertLive(a,w);
        if (context.dispatched) fail('WORKSPACE_WORK_ITEM_ALREADY_DISPATCHED');
        const marked = await tx.query(`UPDATE lesson_author_workspace_work_items SET dispatch_started_at=clock_timestamp()
          WHERE ${LIVE} AND dispatch_started_at IS NULL RETURNING id`, keys(t));
        if (marked.rows.length !== 1 || marked.rows[0].id !== t.workItemId) fail('WORKSPACE_WORK_ITEM_LEASE_LOST');
        await fresh(tx,context);
        const current = await requery(tx,t); assertLive(current,w);
        if (current.dispatch_started_at == null) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
        // Resolves only after db.transaction COMMIT. Caller must await before HTTP.
        return receipt(current,false);
      });
    },
    async publishUnit(target: WorkspaceWorkItemLease, input: WorkspaceUnitPublication) {
      const candidate = freeze(structuredClone(input));
      if (candidate.validation_contract !== 'workspace-unit-baseline-1' || !HASH.test(candidate.result_hash)
        || !HASH.test(candidate.input_context_hash) || !Array.isArray(candidate.baselines) || candidate.baselines.length < 2
        || candidate.baselines.length > 65 || Buffer.byteLength(JSON.stringify(candidate.baselines),'utf8') > 16*1024*1024
        || new Set(candidate.baselines.map(n => n.node_id)).size !== candidate.baselines.length) fail('WORKSPACE_WORK_ITEM_INVALID');
      for (const n of candidate.baselines) {
        if (!UUID.test(n.node_id) || !HASH.test(n.contract_hash) || !HASH.test(n.content_hash)
          || hash(readWorkspaceContent(n.content)) !== n.content_hash) fail('WORKSPACE_WORK_ITEM_INVALID');
      }
      return execute(target, 'publish_unit', async (tx,t,track) => {
        const { a,w,context } = await lock(tx,t,track);
        if (context.kind !== 'generate_unit' || context.input_context_hash !== candidate.input_context_hash
          || !candidate.baselines.some(n => n.node_id === context.node_id && n.contract_hash === context.contract_hash)) fail('WORKSPACE_WORK_ITEM_CONFLICT');
        if (a.status === 'succeeded') {
          if (a.result_hash !== candidate.result_hash || a.validation_contract !== candidate.validation_contract) fail('WORKSPACE_WORK_ITEM_CONFLICT');
          return { ...receipt(a,true), unit_ready_sequence: await unitReadback(tx,context,candidate.baselines) };
        }
        assertLive(a,w);
        if (!context.dispatched) fail('WORKSPACE_WORK_ITEM_CONFLICT');
        const account = await accounting(tx,context,'settle_or_hold');
        await fresh(tx,context);
        const payload = candidate.baselines.map(n => ({ node_id: n.node_id, content: n.content, content_hash: n.content_hash }));
        const result = await tx.query(`SELECT public.publish_lesson_author_workspace_unit(
          $1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text,$6::text,$7::boolean,$8::jsonb) AS work_item_id`,
        [t.workspaceId,t.workItemId,t.leaseToken,JSON.stringify(payload),candidate.result_hash,account.state,account.usage_complete,JSON.stringify(account.observed_usage)]);
        if (result.rows.length !== 1 || result.rows[0].work_item_id !== t.workItemId) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
        const current = await requery(tx,t);
        if (current.status !== 'succeeded' || current.result_hash !== candidate.result_hash || current.validation_contract !== candidate.validation_contract
          || current.accounting_state !== account.state || current.usage_complete !== account.usage_complete
          || hash(current.observed_usage) !== hash(account.observed_usage)) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
        const sequence = await unitReadback(tx,context,candidate.baselines);
        await fresh(tx,context);
        return { ...receipt(current,false), unit_ready_sequence: sequence };
      },candidate.baselines.length);
    },
    /** Called only after actual full-chapter acceptance over immutable AI baselines. */
    async completeValidation(target: WorkspaceWorkItemLease, input: { input_context_hash: string; result_hash: string }) {
      const candidate = Object.freeze({ ...input });
      if (!HASH.test(candidate.input_context_hash) || !HASH.test(candidate.result_hash)) fail('WORKSPACE_WORK_ITEM_INVALID');
      return execute(target, 'complete_validation', async (tx,t,track) => {
        const { a,w,context } = await lock(tx,t,track);
        if (context.kind !== 'validate_chapter' || context.input_context_hash !== candidate.input_context_hash
          || context.max_output_tokens !== 0 || context.max_provider_attempts !== 0) fail('WORKSPACE_WORK_ITEM_CONFLICT');
        if (a.status === 'succeeded') {
          if (a.result_hash !== candidate.result_hash || a.validation_contract !== 'workspace-chapter-baseline-1') fail('WORKSPACE_WORK_ITEM_CONFLICT');
          return receipt(a,true);
        }
        assertLive(a,w);
        if (!context.dispatched) fail('WORKSPACE_WORK_ITEM_CONFLICT');
        const account = await accounting(tx,context,'settle_or_hold');
        await fresh(tx,context);
        const completed = await tx.query(`UPDATE lesson_author_workspace_work_items SET status='succeeded',result_hash=$6,
          validation_contract='workspace-chapter-baseline-1',accounting_state=$7,usage_complete=$8,
          observed_usage=$9::jsonb,finished_at=clock_timestamp()
          WHERE ${LIVE} AND dispatch_started_at IS NOT NULL RETURNING id`,
        [...keys(t),candidate.result_hash,account.state,account.usage_complete,JSON.stringify(account.observed_usage)]);
        if (completed.rows.length !== 1 || completed.rows[0].id !== t.workItemId) fail('WORKSPACE_WORK_ITEM_LEASE_LOST');
        const current = await requery(tx,t);
        if (current.status !== 'succeeded' || current.result_hash !== candidate.result_hash || current.validation_contract !== 'workspace-chapter-baseline-1'
          || current.accounting_state !== account.state || current.usage_complete !== account.usage_complete
          || hash(current.observed_usage) !== hash(account.observed_usage)) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
        await fresh(tx,context);
        return receipt(current,false);
      });
    },
    /** Known failure only; unknown transport/cancel outcomes use hold mode. No retry. */
    async fail(target: WorkspaceWorkItemLease, failure: { code: string; outcome: 'known_failure' | 'uncertain' | 'canceled' }) {
      const f = Object.freeze({ ...failure });
      if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(f.code) || !['known_failure','uncertain','canceled'].includes(f.outcome)) fail('WORKSPACE_WORK_ITEM_INVALID');
      return execute(target, 'fail', async (tx,t,track) => finish(tx,t,f,track));
    },
    /** SYSTEM MAINTENANCE ONLY; never route this as an actor-controlled mutation.
     * Read-only discovery is caller-owned. Exact stored owner/token + DB expiry is
     * required, but fresh actor/source/runtime may have been revoked. Dispatched
     * recovery ALWAYS holds; no provider, publish, release or requeue is authorized. */
    async recover(target: WorkspaceWorkItemLease) {
      return execute(target, 'recover', async (tx,t,track) => finish(tx,t,{ code: 'WORKSPACE_WORK_ITEM_LEASE_EXPIRED', outcome: 'uncertain' },track,true));
    },
  };

  async function finish(tx: GenerationJobSql, t: Readonly<WorkspaceWorkItemLease>,
    failure: { code: string; outcome: 'known_failure' | 'uncertain' | 'canceled' }, track: Track, recovery = false) {
    const { a,w,context } = await lock(tx,t,track,recovery);
    if (terminal.has(String(a.status))) {
      if (a.status === 'succeeded') fail('WORKSPACE_WORK_ITEM_CONFLICT');
      if (!recovery && a.failure_code !== failure.code) fail('WORKSPACE_WORK_ITEM_CONFLICT');
      return receipt(a,true);
    }
    const expired = millis(a.lease_expires_at) <= millis(a.database_now) || millis(a.deadline_at) <= millis(a.database_now);
    if (recovery && !expired) fail('WORKSPACE_WORK_ITEM_CONFLICT');
    if (!recovery) assertLive(a,w);
    const unknown = context.dispatched && (recovery || failure.outcome !== 'known_failure');
    // SQL reserves outcome_unknown for EXPIRED leases. A live transport uncertainty
    // ends as failed with a mandatory hold; it is still needs_action and never retried.
    const status = recovery ? context.dispatched ? 'outcome_unknown' : 'timed_out'
      : failure.outcome === 'canceled' ? 'canceled' : 'failed';
    const mode = !context.dispatched ? 'release_undispatched' : unknown ? 'hold_unknown' : 'settle_or_hold';
    const account = await accounting(tx,context,mode);
    if (!recovery) await fresh(tx,context);
    const ended = await tx.query(`UPDATE lesson_author_workspace_work_items SET status=$6,failure_code=$7,
      accounting_state=$8,usage_complete=$9,observed_usage=$10::jsonb,finished_at=clock_timestamp()
      WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5 AND status='running'
        AND ${recovery ? '(lease_expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())'
          : 'lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()'} RETURNING id`,
    [...keys(t),status,failure.code,account.state,account.usage_complete,JSON.stringify(account.observed_usage)]);
    if (ended.rows.length !== 1 || ended.rows[0].id !== t.workItemId) fail('WORKSPACE_WORK_ITEM_LEASE_LOST');
    const runStatus = failure.outcome === 'canceled' && !recovery ? 'canceled' : 'needs_action';
    const stopped = await tx.query(`UPDATE lesson_author_workspaces SET status=$4
      WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status IN ('drafting','needs_action') RETURNING id`,
    [t.workspaceId,t.tenantId,t.courseId,runStatus]);
    if (stopped.rows.length !== 1 || stopped.rows[0].id !== t.workspaceId) fail('WORKSPACE_WORK_ITEM_CONFLICT');
    const event = await tx.query(`INSERT INTO lesson_author_workspace_events(workspace_id,tenant_id,course_id,event_kind,node_id,operation_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING sequence`,
    [t.workspaceId,t.tenantId,t.courseId,runStatus === 'canceled' ? 'run_canceled' : 'run_needs_action',context.node_id,t.workItemId]);
    if (event.rows.length !== 1 || integer(event.rows[0].sequence) < 1) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    const current = await requery(tx,t);
    if (current.status !== status || current.failure_code !== failure.code || current.accounting_state !== account.state
      || current.usage_complete !== account.usage_complete || hash(current.observed_usage) !== hash(account.observed_usage)) fail('WORKSPACE_WORK_ITEM_READBACK_INVALID');
    if (!recovery) await fresh(tx,context);
    return receipt(current,false);
  }
}
