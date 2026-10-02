import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { GENERATION_JOB_LEASE_MS, GENERATION_JOB_DEADLINE_MS, generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { workspaceBudgetForNextItem, type WorkspaceBudgetManifest, type WorkspaceBudgetEntry } from './lesson-author-workspace-budget.logic.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';
import type { WorkspaceWorkItemLease } from './lesson-author-workspace-work-item.repository.js';

export interface WorkspaceAdmissionTarget extends WorkspaceReadOwner { workspaceId: string; }
/** Server preparation only: budget is the output of buildWorkspaceBudgetManifest.
 * No browser budget, policy cap, new retry allowance or quota estimate is invented here. */
export interface WorkspaceRunAdmission {
  blueprint_job_id: string; inventory_hash: string; runtime_config_hash: string; model: string;
  budget: { manifest: WorkspaceBudgetManifest; manifest_hash: string; token_ceiling: number; execution_budget_ms: number };
}
export interface WorkspaceAdmissionContext {
  target: Readonly<WorkspaceAdmissionTarget>; correlation_id: string; blueprint_id: string;
  bot_id: string; kb_id: string; content_locale: 'vi' | 'en'; source_snapshot_hash: string;
  inventory_hash: string; runtime_config_hash: string; manifest_hash: string; model: string;
}
export interface WorkspaceClaimContext extends WorkspaceAdmissionContext {
  entry: Readonly<WorkspaceBudgetEntry>; work_item_id: string; input_context_hash: string;
  /** DB-clock timestamps; reservation must last at least until deadline_at. */
  created_at: string; deadline_at: string; reserved_tokens: number;
  budget_metadata: Readonly<{ durable_generation: true; workspace_id: string; workspace_work_item_id: string }>;
}
export interface WorkspaceAdmissionDiagnostic {
  event: 'workspace_admission_operation'; operation: 'admit_run' | 'claim_next' | 'complete_run';
  workspace_id: string; correlation_id: string | null; work_item_id: string | null;
  status: 'COMMITTED' | 'REPLAYED' | 'FAIL'; internal_failure_code: string | null;
  item_count: number; duration_ms: number;
}
export type WorkspaceAdmissionErrorCode = 'WORKSPACE_ADMISSION_INVALID' | 'WORKSPACE_ADMISSION_NOT_FOUND'
  | 'WORKSPACE_ADMISSION_FORBIDDEN' | 'WORKSPACE_ADMISSION_CONFLICT' | 'WORKSPACE_ADMISSION_SOURCE_CHANGED'
  | 'WORKSPACE_ADMISSION_RUNTIME_CHANGED' | 'WORKSPACE_ADMISSION_INVENTORY_CHANGED'
  | 'WORKSPACE_ADMISSION_GRANT_INVALID' | 'WORKSPACE_ADMISSION_READBACK_INVALID' | 'WORKSPACE_ADMISSION_UNAVAILABLE';
export class WorkspaceAdmissionError extends Error {
  constructor(readonly code: WorkspaceAdmissionErrorCode) { super(code); this.name = 'WorkspaceAdmissionError'; }
}
function fail(code: WorkspaceAdmissionErrorCode): never { throw new WorkspaceAdmissionError(code); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;
function integer(v: unknown): number {
  if (!(typeof v === 'number' || typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v))
    || !Number.isSafeInteger(Number(v)) || Number(v) < 0) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
  return Number(v);
}
function timestamp(v: unknown): number {
  const n = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(n)) fail('WORKSPACE_ADMISSION_READBACK_INVALID'); return n;
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v;
}
function validateBudget(b: WorkspaceRunAdmission['budget']) {
  const m = b?.manifest;
  if (!m || m.version !== 1 || !Array.isArray(m.entries) || !m.entries.length || m.entries.length > 8192
    || Object.keys(m).sort().join(',') !== 'entries,version' || !HASH.test(b.manifest_hash) || hash(m) !== b.manifest_hash
    || Buffer.byteLength(JSON.stringify(m)) > 4 * 1024 * 1024) fail('WORKSPACE_ADMISSION_INVALID');
  const ids = new Set<string>(); let tokens = 0, duration = 0;
  for (const [i,e] of m.entries.entries()) {
    if (Object.keys(e).sort().join(',') !== 'contract_hash,embedding_tokens,execution_budget_ms,input_tokens,kind,max_output_tokens,max_provider_attempts,node_id,ordinal,output_tokens'
      || e.ordinal !== i || !UUID.test(e.node_id) || ids.has(e.node_id) || !HASH.test(e.contract_hash)
      || !['generate_unit','validate_chapter'].includes(e.kind)
      || [e.ordinal,e.input_tokens,e.output_tokens,e.embedding_tokens,e.max_output_tokens,e.max_provider_attempts,e.execution_budget_ms]
        .some(n => !Number.isSafeInteger(n) || n < 0 || n > 2_000_000)
      || e.input_tokens < 1 || e.execution_budget_ms < 1 || e.execution_budget_ms > GENERATION_JOB_DEADLINE_MS
      || (e.kind === 'generate_unit' ? e.max_output_tokens < 1 || e.max_output_tokens > 65536 || e.max_provider_attempts < 1
        || e.max_provider_attempts > 2 || e.output_tokens !== e.max_output_tokens * e.max_provider_attempts
        : e.max_output_tokens !== 0 || e.max_provider_attempts !== 0 || e.output_tokens !== 0)) fail('WORKSPACE_ADMISSION_INVALID');
    ids.add(e.node_id); const amount = e.input_tokens + e.output_tokens + e.embedding_tokens;
    if (amount > 2_000_000) fail('WORKSPACE_ADMISSION_INVALID'); tokens += amount; duration += e.execution_budget_ms;
  }
  if (b.token_ceiling !== tokens || b.execution_budget_ms !== duration) fail('WORKSPACE_ADMISSION_INVALID');
}

/** Injected server-only transaction boundary. Callbacks MUST use this transaction,
 * lock fresh authority/source/runtime dependencies, and never invoke providers.
 * Main must check installed schema readiness before wiring this repository.
 * No recovery or requeue: an existing ordinal, including expired/failed/unknown,
 * cannot be claimed again. Lifecycle/reconciliation belongs to work-item repository. */
export function createWorkspaceAdmissionRepository(deps: {
  db: GenerationJobDatabase;
  freshAuthority(tx: GenerationJobSql, context: Readonly<WorkspaceAdmissionContext>): Promise<boolean>;
  currentSourceHash(tx: GenerationJobSql, context: Readonly<WorkspaceAdmissionContext>): Promise<string>;
  currentRuntimeHash(tx: GenerationJobSql, context: Readonly<WorkspaceAdmissionContext>): Promise<string>;
  /** Recompute the published immutable inventory fingerprint, not current author revision hashes. */
  currentInventoryHash(tx: GenerationJobSql, context: Readonly<WorkspaceAdmissionContext>): Promise<string>;
  /** Exact materializable hierarchy context from the real main-owned loader on this transaction. */
  inputContextHash(tx: GenerationJobSql, context: Readonly<WorkspaceAdmissionContext>, entry: Readonly<WorkspaceBudgetEntry>): Promise<string>;
  /** Existing quota admission on SAME tx: exact frozen envelope, no partial grants.
   * Set lesson_author target/operation, self_built_rag engine, model and owner from context.
   * Persist durable metadata BEFORE returning. This repository re-reads the actual row. */
  grant(tx: GenerationJobSql, context: Readonly<WorkspaceClaimContext>): Promise<{ reservation_id: string }>;
  report(event: WorkspaceAdmissionDiagnostic): void;
}) {
  type Tracking = { correlation: string | null; item: string | null; count: number };
  const scope = (t: WorkspaceAdmissionTarget) => [t.workspaceId,t.tenantId,t.courseId];
  async function fresh(tx: GenerationJobSql, c: Readonly<WorkspaceAdmissionContext>) {
    if (!await deps.freshAuthority(tx,c)) fail('WORKSPACE_ADMISSION_FORBIDDEN');
    if (await deps.currentSourceHash(tx,c) !== c.source_snapshot_hash) fail('WORKSPACE_ADMISSION_SOURCE_CHANGED');
    if (await deps.currentRuntimeHash(tx,c) !== c.runtime_config_hash) fail('WORKSPACE_ADMISSION_RUNTIME_CHANGED');
    if (await deps.currentInventoryHash(tx,c) !== c.inventory_hash) fail('WORKSPACE_ADMISSION_INVENTORY_CHANGED');
  }
  async function execute<T extends { replayed: boolean }>(input: WorkspaceAdmissionTarget, operation: WorkspaceAdmissionDiagnostic['operation'],
    work: (tx: GenerationJobSql, t: Readonly<WorkspaceAdmissionTarget>, track: Tracking) => Promise<T>): Promise<T> {
    const t = Object.freeze({ ...input }), started = performance.now();
    const track: Tracking = { correlation: null, item: null, count: 0 };
    const report = (status: WorkspaceAdmissionDiagnostic['status'], internal_failure_code: string | null) => {
      try { deps.report({ event:'workspace_admission_operation', operation, workspace_id: UUID.test(t.workspaceId) ? t.workspaceId : '',
        correlation_id:track.correlation,work_item_id:track.item,status,internal_failure_code,item_count:track.count,
        duration_ms:Math.round(performance.now()-started) }); } catch { /* telemetry cannot undo a commit */ }
    };
    try {
      if (![t.workspaceId,t.tenantId,t.userId,t.conversationId].every(v => typeof v === 'string' && UUID.test(v))
        || typeof t.courseId !== 'string' || !t.courseId || t.courseId.length > 255) fail('WORKSPACE_ADMISSION_INVALID');
      const result = await deps.db.transaction(tx => work(tx,t,track));
      report(result.replayed ? 'REPLAYED' : 'COMMITTED',null); return result;
    } catch (error) {
      const safe = error instanceof WorkspaceAdmissionError ? error : new WorkspaceAdmissionError('WORKSPACE_ADMISSION_UNAVAILABLE');
      const detail = error && typeof error === 'object' ? error as { internal_failure_code?: unknown; code?: unknown } : {};
      const code = detail.internal_failure_code ?? detail.code;
      report('FAIL',typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,99}$/.test(code) ? code : safe.code); throw safe;
    }
  }
  async function lock(tx: GenerationJobSql, t: WorkspaceAdmissionTarget, track: Tracking) {
    await tx.query("SET LOCAL lock_timeout = '3000ms'");
    const advisory = await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',[`course:${t.tenantId}:${t.courseId}`]);
    if (advisory.rows.length !== 1 || advisory.rows[0].acquired !== true) fail('WORKSPACE_ADMISSION_CONFLICT');
    const course = await tx.query('SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE',[t.courseId,t.tenantId]);
    if (course.rows.length !== 1) fail('WORKSPACE_ADMISSION_NOT_FOUND');
    const ws = await tx.query(`SELECT w.id,w.status,w.blueprint_id,w.bot_id,w.kb_id,w.source_snapshot_hash,w.correlation_id,w.content_locale
      FROM lesson_author_workspaces w JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id
        AND c.course_id=w.course_id AND c.user_id=w.requested_by AND c.bot_id=w.bot_id AND c.target='lesson_author'
      WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
        AND w.engine='self_built_rag' AND w.contract_version=1 FOR UPDATE OF w`,[...scope(t),t.conversationId,t.userId]);
    if (ws.rows.length !== 1) fail('WORKSPACE_ADMISSION_NOT_FOUND');
    const w = ws.rows[0];
    if (w.id !== t.workspaceId || ![w.blueprint_id,w.bot_id,w.kb_id,w.correlation_id].every(v => typeof v === 'string' && UUID.test(v))
      || typeof w.source_snapshot_hash !== 'string' || !HASH.test(w.source_snapshot_hash)
      || !['vi','en'].includes(String(w.content_locale))) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
    track.correlation = String(w.correlation_id);
    return w;
  }
  function context(t: WorkspaceAdmissionTarget,w: Row,r: Row): Readonly<WorkspaceAdmissionContext> {
    const inventoryHash=r.inventory_hash, runtimeHash=r.runtime_config_hash, manifestHash=r.manifest_hash;
    const sourceHash=w.source_snapshot_hash, locale=w.content_locale;
    if (typeof inventoryHash !== 'string' || !HASH.test(inventoryHash) || typeof runtimeHash !== 'string' || !HASH.test(runtimeHash)
      || typeof manifestHash !== 'string' || !HASH.test(manifestHash) || typeof sourceHash !== 'string' || !HASH.test(sourceHash)
      || (locale !== 'vi' && locale !== 'en')
      || typeof r.model !== 'string' || !r.model.trim() || r.model.length > 128) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
    return freeze({ target:t,correlation_id:String(w.correlation_id),blueprint_id:String(w.blueprint_id),bot_id:String(w.bot_id),kb_id:String(w.kb_id),
      content_locale:locale,source_snapshot_hash:sourceHash,inventory_hash:inventoryHash,
      runtime_config_hash:runtimeHash,manifest_hash:manifestHash,model:r.model });
  }
  async function run(tx: GenerationJobSql,t: WorkspaceAdmissionTarget) {
    const rows = await tx.query('SELECT * FROM lesson_author_workspace_runs WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 FOR UPDATE',scope(t));
    if (rows.rows.length > 1) fail('WORKSPACE_ADMISSION_READBACK_INVALID'); return rows.rows[0];
  }
  function budget(r: Row): WorkspaceRunAdmission['budget'] {
    const b = {manifest:r.budget_manifest as WorkspaceBudgetManifest,manifest_hash:String(r.manifest_hash),
      token_ceiling:integer(r.token_ceiling),execution_budget_ms:integer(r.execution_budget_ms)}; validateBudget(b); return b;
  }
  async function items(tx: GenerationJobSql,t: WorkspaceAdmissionTarget,manifest: WorkspaceBudgetManifest) {
    const result = await tx.query(`SELECT id,node_id,ordinal,kind,contract_hash,status,dispatch_started_at,result_hash,validation_contract,accounting_state
      FROM lesson_author_workspace_work_items WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 ORDER BY ordinal LIMIT 8193 FOR UPDATE`,scope(t));
    if (result.rows.length > manifest.entries.length) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
    for (const [i,a] of result.rows.entries()) {
      const e = manifest.entries[i];
      if (integer(a.ordinal) !== i || a.node_id !== e.node_id || a.kind !== e.kind || a.contract_hash !== e.contract_hash)
        fail('WORKSPACE_ADMISSION_READBACK_INVALID');
      if (a.status !== 'succeeded') fail('WORKSPACE_ADMISSION_CONFLICT');
      if (a.dispatch_started_at == null || !HASH.test(String(a.result_hash)) || !['settled','pending_reconciliation'].includes(String(a.accounting_state))
        || a.validation_contract !== (e.kind === 'generate_unit' ? 'workspace-unit-baseline-1' : 'workspace-chapter-baseline-1'))
        fail('WORKSPACE_ADMISSION_READBACK_INVALID');
    }
    return result.rows;
  }
  return {
    admitRun(input: WorkspaceAdmissionTarget, prepared: WorkspaceRunAdmission) {
      return execute(input,'admit_run',async (tx,t,track) => {
        const p = freeze(structuredClone(prepared)); validateBudget(p.budget);
        if (!UUID.test(p.blueprint_job_id)) fail('WORKSPACE_ADMISSION_INVALID');
        const w = await lock(tx,t,track), c = context(t,w,{...p,manifest_hash:p.budget.manifest_hash});
        await fresh(tx,c); const existing = await run(tx,t); track.count=p.budget.manifest.entries.length;
        if (existing) {
          budget(existing);
          if (existing.blueprint_job_id !== p.blueprint_job_id || existing.inventory_hash !== p.inventory_hash
            || existing.runtime_config_hash !== p.runtime_config_hash || existing.model !== p.model
            || existing.manifest_hash !== p.budget.manifest_hash || hash(existing.budget_manifest) !== p.budget.manifest_hash
            || integer(existing.token_ceiling) !== p.budget.token_ceiling || integer(existing.execution_budget_ms) !== p.budget.execution_budget_ms)
            fail('WORKSPACE_ADMISSION_CONFLICT');
          return {workspace_id:t.workspaceId,manifest_hash:p.budget.manifest_hash,token_ceiling:p.budget.token_ceiling,
            total_authorized_tokens:integer(existing.total_authorized_tokens),replayed:true};
        }
        if (w.status !== 'drafting') fail('WORKSPACE_ADMISSION_CONFLICT');
        const architecture = await tx.query(`SELECT r.estimated_tokens FROM lesson_author_generation_jobs j
          JOIN ai_token_reservations r ON r.id=j.ai_reservation_id AND r.tenant_id=j.tenant_id
          WHERE j.id=$1 AND j.tenant_id=$2 AND j.course_id=$3 AND j.conversation_id=$4 AND j.requested_by=$5
            AND j.bot_id=$6 AND j.kb_id=$7 AND j.status='succeeded' AND j.result_blueprint_id=$8
            AND j.source_snapshot_hash=$9 AND j.locale=$10 AND r.budget_metadata->>'durable_generation'='true' FOR SHARE OF j,r`,
        [p.blueprint_job_id,t.tenantId,t.courseId,t.conversationId,t.userId,c.bot_id,c.kb_id,c.blueprint_id,c.source_snapshot_hash,c.content_locale]);
        if (architecture.rows.length !== 1 || integer(architecture.rows[0].estimated_tokens) < 1) fail('WORKSPACE_ADMISSION_CONFLICT');
        const architectureTokens=integer(architecture.rows[0].estimated_tokens), total=architectureTokens+p.budget.token_ceiling;
        if (!Number.isSafeInteger(total)) fail('WORKSPACE_ADMISSION_INVALID');
        await tx.query(`INSERT INTO lesson_author_workspace_runs(workspace_id,tenant_id,course_id,blueprint_job_id,blueprint_budget_tokens,
          inventory_hash,manifest_hash,runtime_config_hash,model,budget_manifest,token_ceiling,total_authorized_tokens,execution_budget_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [...scope(t),p.blueprint_job_id,architectureTokens,p.inventory_hash,p.budget.manifest_hash,p.runtime_config_hash,p.model,
          JSON.stringify(p.budget.manifest),p.budget.token_ceiling,total,p.budget.execution_budget_ms]);
        const saved = await run(tx,t);
        if (!saved || saved.blueprint_job_id !== p.blueprint_job_id || saved.inventory_hash !== p.inventory_hash
          || saved.runtime_config_hash !== p.runtime_config_hash || saved.model !== p.model || saved.manifest_hash !== p.budget.manifest_hash
          || hash(saved.budget_manifest) !== p.budget.manifest_hash || integer(saved.blueprint_budget_tokens) !== architectureTokens
          || integer(saved.total_authorized_tokens) !== total || budget(saved).token_ceiling !== p.budget.token_ceiling)
          fail('WORKSPACE_ADMISSION_READBACK_INVALID');
        await fresh(tx,c);
        return {workspace_id:t.workspaceId,manifest_hash:p.budget.manifest_hash,token_ceiling:p.budget.token_ceiling,total_authorized_tokens:total,replayed:false};
      });
    },
    claimNext(input: WorkspaceAdmissionTarget, request: { expectedOrdinal: number; idempotencyKey: string }) {
      const requestCopy={...request};
      return execute(input,'claim_next',async (tx,t,track) => {
        if (!Number.isSafeInteger(requestCopy.expectedOrdinal) || requestCopy.expectedOrdinal < 0 || requestCopy.expectedOrdinal > 8191
          || !UUID.test(requestCopy.idempotencyKey)) fail('WORKSPACE_ADMISSION_INVALID');
        const w=await lock(tx,t,track), r=await run(tx,t);
        if (!r) fail('WORKSPACE_ADMISSION_NOT_FOUND');
        const c=context(t,w,r); await fresh(tx,c);
        if (w.status !== 'drafting') fail('WORKSPACE_ADMISSION_CONFLICT');
        const b=budget(r), prior=await items(tx,t,b.manifest); track.count=prior.length;
        if (prior.length !== requestCopy.expectedOrdinal || prior.length >= b.manifest.entries.length) fail('WORKSPACE_ADMISSION_CONFLICT');
        const duplicate=await tx.query('SELECT id FROM lesson_author_workspace_work_items WHERE workspace_id=$1 AND idempotency_key=$2',
          [t.workspaceId,requestCopy.idempotencyKey]);
        if (duplicate.rows.length) fail('WORKSPACE_ADMISSION_CONFLICT');
        const entry=freeze(workspaceBudgetForNextItem(b.manifest,b.manifest_hash,prior.map(a=>integer(a.ordinal)),null));
        const inputHash=await deps.inputContextHash(tx,c,entry);
        if (typeof inputHash !== 'string' || !HASH.test(inputHash)) fail('WORKSPACE_ADMISSION_INVALID');
        const id=randomUUID(), leaseToken=randomUUID(); track.item=id;
        // Existing quota expiry is now()+600s (transaction start), not wall clock.
        // Anchor the work deadline to the SAME tick; time spent admitting consumes
        // the envelope. Heartbeat/live checks below still use clock_timestamp().
        const tick=await tx.query('SELECT now() AS database_now');
        if (tick.rows.length !== 1) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
        const created=timestamp(tick.rows[0].database_now), deadline=created+entry.execution_budget_ms;
        const grantContext=freeze({...c,entry,work_item_id:id,input_context_hash:inputHash,created_at:new Date(created).toISOString(),
          deadline_at:new Date(deadline).toISOString(),reserved_tokens:entry.input_tokens+entry.output_tokens+entry.embedding_tokens,
          budget_metadata:{durable_generation:true as const,workspace_id:t.workspaceId,workspace_work_item_id:id}});
        const grant=await deps.grant(tx,grantContext);
        if (!grant || !UUID.test(grant.reservation_id)) fail('WORKSPACE_ADMISSION_GRANT_INVALID');
        const reservation=await tx.query('SELECT *,clock_timestamp() AS database_now FROM ai_token_reservations WHERE id=$1 FOR SHARE',[grant.reservation_id]);
        const q=reservation.rows[0], metadata=q?.budget_metadata as Row | undefined;
        if (reservation.rows.length !== 1 || q.id !== grant.reservation_id || q.tenant_id !== t.tenantId || q.user_id !== t.userId
          || q.conversation_id !== t.conversationId || q.target !== 'lesson_author' || q.operation !== 'lesson_author'
          || q.engine !== 'self_built_rag' || q.model !== c.model || q.status !== 'reserved'
          || metadata?.durable_generation !== true || metadata?.workspace_id !== t.workspaceId || metadata?.workspace_work_item_id !== id
          || integer(q.estimated_tokens) !== grantContext.reserved_tokens || integer(q.budget_input_tokens) !== entry.input_tokens
          || integer(q.budget_output_tokens) !== entry.output_tokens || integer(q.budget_embedding_tokens) !== entry.embedding_tokens
          || integer(q.max_output_tokens) !== entry.max_output_tokens || timestamp(q.expires_at) < deadline
          || timestamp(q.database_now) >= deadline) fail('WORKSPACE_ADMISSION_GRANT_INVALID');
        await fresh(tx,c);
        if (await deps.inputContextHash(tx,c,entry) !== inputHash) fail('WORKSPACE_ADMISSION_CONFLICT');
        await tx.query(`WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
          INSERT INTO lesson_author_workspace_work_items(id,workspace_id,tenant_id,course_id,node_id,ordinal,kind,contract_hash,input_context_hash,
            idempotency_key,ai_reservation_id,reserved_tokens,max_output_tokens,max_provider_attempts,lease_token,created_at,heartbeat_at,lease_expires_at,deadline_at)
          SELECT $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::uuid,$6::integer,$7::varchar,$8::varchar,$9::varchar,
            $10::uuid,$11::uuid,$12::bigint,$13::integer,$14::smallint,$15::uuid,$16::timestamptz,tick.at,
            LEAST(tick.at+($18::bigint*interval '1 millisecond'),$17::timestamptz),$17::timestamptz FROM tick`,
        [id,...scope(t),entry.node_id,entry.ordinal,entry.kind,entry.contract_hash,inputHash,requestCopy.idempotencyKey,grant.reservation_id,
          grantContext.reserved_tokens,entry.max_output_tokens,entry.max_provider_attempts,leaseToken,grantContext.created_at,grantContext.deadline_at,GENERATION_JOB_LEASE_MS]);
        const saved=await tx.query('SELECT *,clock_timestamp() AS database_now FROM lesson_author_workspace_work_items WHERE id=$1 AND workspace_id=$2',[id,t.workspaceId]);
        const a=saved.rows[0];
        if (saved.rows.length !== 1 || a.id !== id || a.workspace_id !== t.workspaceId || a.tenant_id !== t.tenantId || a.course_id !== t.courseId
          || a.lease_token !== leaseToken || a.node_id !== entry.node_id || integer(a.ordinal) !== entry.ordinal || a.kind !== entry.kind
          || a.contract_hash !== entry.contract_hash || a.input_context_hash !== inputHash || a.idempotency_key !== requestCopy.idempotencyKey
          || a.ai_reservation_id !== grant.reservation_id || integer(a.reserved_tokens) !== grantContext.reserved_tokens
          || integer(a.max_output_tokens) !== entry.max_output_tokens || integer(a.max_provider_attempts) !== entry.max_provider_attempts
          || a.status !== 'running' || a.dispatch_started_at !== null || a.accounting_state !== 'reserved'
          || timestamp(a.created_at) !== created || timestamp(a.deadline_at) !== deadline
          || timestamp(a.lease_expires_at) <= timestamp(a.database_now) || timestamp(a.deadline_at) <= timestamp(a.database_now))
          fail('WORKSPACE_ADMISSION_READBACK_INVALID');
        const lease: WorkspaceWorkItemLease={...t,workItemId:id,leaseToken};
        return {lease,node_id:entry.node_id,ordinal:entry.ordinal,kind:entry.kind,input_context_hash:inputHash,
          reservation_id:grant.reservation_id,deadline_at:grantContext.deadline_at,replayed:false};
      });
    },
    completeRun(input: WorkspaceAdmissionTarget) {
      return execute(input,'complete_run',async (tx,t,track) => {
        const w=await lock(tx,t,track), r=await run(tx,t);
        if (!r) fail('WORKSPACE_ADMISSION_NOT_FOUND');
        const c=context(t,w,r); await fresh(tx,c);
        if (!['drafting','ready'].includes(String(w.status))) fail('WORKSPACE_ADMISSION_CONFLICT');
        const b=budget(r), prior=await items(tx,t,b.manifest); track.count=prior.length;
        if (prior.length !== b.manifest.entries.length) fail('WORKSPACE_ADMISSION_CONFLICT');
        const missing=await tx.query(`SELECT id FROM lesson_author_workspace_nodes WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3
          AND (content_state<>'content_ready' OR current_revision IS NULL) LIMIT 1`,scope(t));
        if (missing.rows.length) fail('WORKSPACE_ADMISSION_CONFLICT');
        const events=await tx.query("SELECT sequence FROM lesson_author_workspace_events WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND event_kind='run_ready'",scope(t));
        if (w.status === 'ready') {
          if (events.rows.length !== 1 || integer(events.rows[0].sequence) < 1) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
          return {workspace_id:t.workspaceId,run_ready_sequence:integer(events.rows[0].sequence),replayed:true};
        }
        if (events.rows.length) fail('WORKSPACE_ADMISSION_CONFLICT');
        await fresh(tx,c);
        const updated=await tx.query("UPDATE lesson_author_workspaces SET status='ready' WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status='drafting' RETURNING id",scope(t));
        if (updated.rows.length !== 1) fail('WORKSPACE_ADMISSION_CONFLICT');
        const event=await tx.query(`INSERT INTO lesson_author_workspace_events(workspace_id,tenant_id,course_id,event_kind,operation_id)
          VALUES($1::uuid,$2::uuid,$3::varchar,'run_ready',$1::uuid) RETURNING sequence`,scope(t));
        if (event.rows.length !== 1 || integer(event.rows[0].sequence) < 1) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
        const readback=await tx.query(`SELECT w.status,w.event_head,e.sequence FROM lesson_author_workspaces w
          JOIN lesson_author_workspace_events e ON e.workspace_id=w.id AND e.sequence=w.event_head
          WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND e.event_kind='run_ready' AND e.operation_id=w.id`,scope(t));
        if (readback.rows.length !== 1 || readback.rows[0].status !== 'ready'
          || integer(readback.rows[0].event_head) !== integer(event.rows[0].sequence)
          || integer(readback.rows[0].sequence) !== integer(event.rows[0].sequence)) fail('WORKSPACE_ADMISSION_READBACK_INVALID');
        // Deferred installed run/event guards are commit authority. No fake validation receipts.
        return {workspace_id:t.workspaceId,run_ready_sequence:integer(event.rows[0].sequence),replayed:false};
      });
    },
  };
}
