import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { projectBlueprintDraftArchitecture } from './lesson-author-blueprint-draft-architecture.logic.js';
import { assertRagChapterCheckpointRequest, readRagChapterCheckpointResponse,
  type RagChapterCheckpointRequest, type RagChapterUnitResponse } from './lesson-author-chapter-rag-contract.logic.js';
import { acceptWorkspaceGeneratedUnit, type WorkspaceGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { WorkspaceUnitPublication, WorkspaceWorkItemContext, WorkspaceWorkItemLease,
  WorkspaceWorkItemReceipt } from './lesson-author-workspace-work-item.repository.js';

export class WorkspaceUnitRunError extends Error {
  constructor(readonly code: 'WORKSPACE_UNIT_RUN_INVALID' | 'WORKSPACE_UNIT_WORKFLOW_TIMEOUT'
    | 'WORKSPACE_UNIT_LEASE_LOST' | 'WORKSPACE_UNIT_SHUTDOWN' | 'WORKSPACE_UNIT_RECEIPT_INVALID'
    | 'WORKSPACE_UNIT_NORMALIZATION_INVALID' | 'WORKSPACE_UNIT_OBJECTIVE_CONFLICT') { super(code); }
}
export interface WorkspaceUnitExecution {
  /** Internal persisted admission, never a browser-supplied execution grant. */
  item: Readonly<WorkspaceWorkItemContext>;
  deadline_at: Date;
}
export interface WorkspaceUnitPrepared {
  context: WorkspaceGenerationContext;
  request: RagChapterCheckpointRequest;
}
export interface WorkspaceUnitUsage {
  usage_complete: boolean;
  usage_source: RagChapterUnitResponse['usage_source'] | 'unavailable';
  usage: RagChapterUnitResponse['usage'];
}
export interface WorkspaceUnitFailure {
  code: string;
  outcome: 'known_failure' | 'uncertain';
}
export interface WorkspaceUnitRunnerDependencies {
  /** Short read transaction: live lease + fresh authority/source/runtime + the
   * actual revision-0 context loader. Must not call a provider or publish. */
  prepare(execution: WorkspaceUnitExecution, signal: AbortSignal): Promise<WorkspaceUnitPrepared>;
  /** Resolves only AFTER the repository dispatch transaction commits. */
  markDispatched(lease: WorkspaceWorkItemLease): Promise<WorkspaceWorkItemReceipt>;
  renew(lease: WorkspaceWorkItemLease): Promise<WorkspaceWorkItemReceipt>;
  /** Existing authenticated Python checkpoint client; one invocation, no retry. */
  generate(request: RagChapterCheckpointRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  /** Existing normalizeLessonAuthorProposal: Python wire components are NOT CMS
   * component proposals. Must not inject plan ownership/coverage into output. */
  normalizeProposal(raw: unknown): LessonAuthorProposal;
  /** Reload/fence context + repository publication/accounting on one transaction.
   * Usage is an observation, not authority to release an unknown reservation. */
  publish(lease: WorkspaceWorkItemLease, publication: WorkspaceUnitPublication, usage: WorkspaceUnitUsage): Promise<WorkspaceWorkItemReceipt>;
  fail(lease: WorkspaceWorkItemLease, failure: WorkspaceUnitFailure, usage: WorkspaceUnitUsage): Promise<WorkspaceWorkItemReceipt>;
  report(event: Record<string, unknown>): void;
  clock?: WorkspaceUnitClock;
}
export interface WorkspaceUnitClock {
  now(): number;
  timeout(callback: () => void, ms: number): () => void;
  interval(callback: () => void, ms: number): () => void;
}
const realClock: WorkspaceUnitClock = {
  now: () => Date.now(),
  timeout: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  interval: (fn, ms) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
function invalid(): never { throw new WorkspaceUnitRunError('WORKSPACE_UNIT_RUN_INVALID'); }
function failureCode(error: unknown) {
  const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'WORKSPACE_UNIT_EXECUTION_FAILED';
}
function checkPrepared(p: WorkspaceUnitPrepared, item: WorkspaceWorkItemContext) {
  const { context: c, request: r } = p;
  assertRagChapterCheckpointRequest(r);
  if (c.correlation_id !== item.correlation_id || c.source_snapshot_hash !== item.source_snapshot_hash
    || c.input_context_hash !== item.input_context_hash || r.correlation_id !== item.correlation_id
    || r.tenant_id !== item.target.tenantId || r.conversation_id !== item.target.conversationId
    || r.locale !== item.content_locale || r.max_output_tokens !== item.max_output_tokens
    || r.max_attempts !== item.max_provider_attempts || r.checkpoint_action !== 'generate_unit') invalid();
  const match = /^chapter_([1-9][0-9]*)\.lesson_([1-9][0-9]*)\.unit_([1-9][0-9]*)$/.exec(c.unitPath);
  if (!match) invalid();
  const chapter = c.blueprint.chapters[Number(match[1])-1], li = Number(match[2])-1, ui = Number(match[3])-1;
  const unit = chapter?.lessons[li]?.units[ui], bound = c.targetNodes.find(n => n.path === c.unitPath);
  const a = r.blueprint_architecture!;
  if (!unit || !bound || bound.id !== item.node_id || bound.contract_hash !== item.contract_hash
    || hash(a) !== hash(projectBlueprintDraftArchitecture(c.blueprint,Number(match[1])-1))
    || r.checkpoint_unit_index !== chapter.lessons.slice(0,li).reduce((n,l)=>n+l.units.length,0)+ui
    || a.lessons[li].units[ui].title !== unit.title) invalid();
}

function sameIds(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)&&value.length===expected.length&&new Set(value).size===value.length
    &&value.every(v=>typeof v==='string'&&expected.includes(v));
}

/** One ALREADY-admitted unit through the real envelope + Node baseline validators.
 * Not a scheduler/admission API. No globals/timers run on import. No course Apply.
 * DB mutations (dispatch/publication/terminalization) are NEVER raced against
 * cancellation. A lost/uncertain commit must be reconciled, not sent again.
 * Aborting the HTTP wait does not prove Python's synchronous Gemini call stopped.
 */
export async function runWorkspaceUnit(execution: WorkspaceUnitExecution, deps: WorkspaceUnitRunnerDependencies,
  shutdown?: AbortSignal): Promise<'unit_ready' | 'needs_action' | 'reconciliation_required'> {
  const lease = Object.freeze({ ...execution.item.target });
  const item = Object.freeze({ ...structuredClone(execution.item),target:lease });
  const clock = deps.clock ?? realClock, started = clock.now(), deadline = execution.deadline_at.getTime();
  if (item.kind !== 'generate_unit' || item.dispatched || !UUID.test(item.correlation_id)
    || ![lease.tenantId,lease.userId,lease.workspaceId,lease.workItemId,lease.leaseToken,lease.conversationId,item.node_id].every(id=>UUID.test(id))
    || ![item.input_context_hash,item.source_snapshot_hash,item.contract_hash].every(h=>HASH.test(h))
    || !Number.isFinite(deadline) || deadline-started>600_000
    || !Number.isInteger(item.max_output_tokens) || item.max_output_tokens<1 || item.max_output_tokens>65_536
    || ![1,2].includes(item.max_provider_attempts) || !['en','vi'].includes(item.content_locale)) invalid();
  // Existing checkpoint envelope: at most480s; retain >=60s for final DB handling.
  const end = Math.min(started+480_000, deadline-60_000);
  const controller = new AbortController();
  let stage = 'workspace_unit_prepare', mutationUncertain = false, dispatchCommitted = false;
  let leaseLost = false, closing = false, renewal: Promise<void> | null = null;
  let responseReceived = false;
  let usage: WorkspaceUnitUsage = { usage_complete:false, usage_source:'unavailable', usage:{} };
  const report = (event: string, extra: Record<string, unknown> = {}) => {
    try { deps.report({ event, correlation_id:item.correlation_id, workspace_id:lease.workspaceId,
      conversation_id:lease.conversationId, work_item_id:lease.workItemId, node_id:item.node_id,
      failure_stage:stage, duration_ms:Math.max(0,clock.now()-started), ...extra }); } catch { /* diagnostic only */ }
  };
  const abort = (code: ConstructorParameters<typeof WorkspaceUnitRunError>[0]) => {
    if (!controller.signal.aborted) controller.abort(new WorkspaceUnitRunError(code));
  };
  const onShutdown = () => abort('WORKSPACE_UNIT_SHUTDOWN');
  shutdown?.addEventListener('abort',onShutdown,{once:true});
  if (shutdown?.aborted) onShutdown();
  const remaining = () => {
    if (clock.now()>=end) abort('WORKSPACE_UNIT_WORKFLOW_TIMEOUT');
    controller.signal.throwIfAborted();
    return Math.floor(end-clock.now());
  };
  let rejectAbort!: () => void;
  const interrupted = new Promise<never>((_,reject) => {
    rejectAbort=()=>reject(controller.signal.reason);
    controller.signal.addEventListener('abort',rejectAbort,{once:true});
    if(controller.signal.aborted)rejectAbort();
  });
  void interrupted.catch(()=>undefined);
  const wait = <T>(promise: Promise<T>) => Promise.race([promise,interrupted]);
  const cancelDeadline=clock.timeout(()=>abort('WORKSPACE_UNIT_WORKFLOW_TIMEOUT'),Math.max(0,end-started));
  const cancelHeartbeat=clock.interval(()=>{
    if(closing||renewal||controller.signal.aborted)return;
    renewal=Promise.resolve().then(()=>deps.renew(lease)).then(receipt=>{
      if(receipt.workspace_id!==lease.workspaceId||receipt.work_item_id!==lease.workItemId||receipt.status!=='running')
        throw new WorkspaceUnitRunError('WORKSPACE_UNIT_LEASE_LOST');
    }).catch(()=>{leaseLost=true;abort('WORKSPACE_UNIT_LEASE_LOST');}).finally(()=>{renewal=null;});
  },15_000);
  async function stopHeartbeat() { closing=true;cancelHeartbeat();if(renewal)await renewal; }
  try {
    remaining(); report('workspace_unit_started',{max_output_tokens:item.max_output_tokens,max_provider_attempts:item.max_provider_attempts});
    const prepared=structuredClone(await wait(deps.prepare({item,deadline_at:new Date(deadline)},controller.signal)));
    remaining();checkPrepared(prepared,item);
    stage='workspace_unit_dispatch'; mutationUncertain=true;
    const dispatched=await deps.markDispatched(lease);
    if(dispatched.workspace_id!==lease.workspaceId||dispatched.work_item_id!==lease.workItemId
      ||dispatched.node_id!==item.node_id||dispatched.status!=='running'||dispatched.replayed)
      throw new WorkspaceUnitRunError('WORKSPACE_UNIT_RECEIPT_INVALID');
    mutationUncertain=false;dispatchCommitted=true;
    remaining(); stage='workspace_unit_python';report('workspace_unit_dispatch_committed');
    const budget=remaining(), request={...prepared.request,remaining_workflow_budget_ms:budget};
    const raw=await wait(deps.generate(request,{signal:controller.signal,timeoutMs:budget}));
    responseReceived=true; remaining(); stage='workspace_unit_response_validation';
    const response=readRagChapterCheckpointResponse(raw,request);
    if(response.status!=='unit_ready')invalid();
    usage={usage_complete:response.usage_complete,usage_source:response.usage_source,usage:structuredClone(response.usage)};
    report('workspace_unit_python_accepted',{usage_complete:usage.usage_complete,usage_source:usage.usage_source,
      input_tokens:usage.usage.inputTokens??null,output_tokens:usage.usage.outputTokens??null,
      embedding_tokens:usage.usage.embeddingTokens??null,total_tokens:usage.usage.totalTokens??null,
      provider_finish_reason:null,provider_finish_reason_available:false});
    stage='workspace_unit_node_validation';
    const path=/^chapter_([1-9][0-9]*)\.lesson_([1-9][0-9]*)\.unit_([1-9][0-9]*)$/.exec(prepared.context.unitPath)!;
    const chapter=prepared.context.blueprint.chapters[Number(path[1])-1],lesson=chapter.lessons[Number(path[2])-1];
    const planned=lesson.units[Number(path[3])-1];
    if(!sameIds(response.unit.source_fact_ids??[],planned.source_fact_ids??[])
      ||!sameIds(response.unit.supporting_evidence_fact_ids??[],planned.supporting_evidence_fact_ids??[]))invalid();
    let proposal:LessonAuthorProposal;
    try { proposal=deps.normalizeProposal({chapters:[{title:chapter.title,lessons:[{title:lesson.title,units:[response.unit]}]}]}); }
    catch { throw new WorkspaceUnitRunError('WORKSPACE_UNIT_NORMALIZATION_INVALID'); }
    const normalized=proposal.chapters?.[0]?.lessons?.[0]?.units?.[0];
    if(proposal.chapters?.length!==1||proposal.chapters[0].lessons?.length!==1
      ||proposal.chapters[0].lessons[0].units?.length!==1||!normalized||!Array.isArray(normalized.components)
      ||normalized.components.length!==response.unit.components.length)invalid();
    // The legacy normalizer intentionally projects component payload/provenance,
    // but does not retain objective refs. Bind those from the approved instance
    // plan, rejecting any conflicting wire claim first. NEVER inject owned or
    // covered fact IDs here: baseline acceptance must see actual generated facts.
    const rawById=new Map<string,Record<string,unknown>>();
    for(const value of response.unit.components){
      if(!value||typeof value!=='object'||Array.isArray(value))invalid();
      const raw=value as Record<string,unknown>,meta=raw.metadata as Record<string,unknown>|undefined;
      const instance=raw.component_plan_id??meta?.component_plan_id;
      if(typeof instance!=='string'||rawById.has(instance))invalid();rawById.set(instance,raw);
    }
    const components=normalized.components.map(component=>{
      const instance=component.metadata?.component_plan_id,plan=planned.component_plan.find(p=>p.component_plan_id===instance);
      const raw=typeof instance==='string'?rawById.get(instance):undefined;
      if(!plan||!raw)invalid();
      const meta=raw.metadata as Record<string,unknown>|undefined,refs=plan.learning_objective_refs??[];
      for(const value of [raw.learning_objective_refs,meta?.learning_objective_refs,component.metadata?.learning_objective_refs])
        if(value!==undefined&&!sameIds(value,refs))throw new WorkspaceUnitRunError('WORKSPACE_UNIT_OBJECTIVE_CONFLICT');
      return{...component,metadata:{...component.metadata,learning_objective_refs:[...refs]}};
    });
    const accepted=acceptWorkspaceGeneratedUnit(prepared.context,item.input_context_hash,components);
    remaining(); await stopHeartbeat(); remaining();
    stage='workspace_unit_publication';mutationUncertain=true;
    const receipt=await deps.publish(lease,accepted,usage);
    if(receipt.workspace_id!==lease.workspaceId||receipt.work_item_id!==lease.workItemId||receipt.node_id!==item.node_id
      ||receipt.status!=='succeeded'||receipt.result_hash!==accepted.result_hash
      ||!Number.isSafeInteger(receipt.unit_ready_sequence)||(receipt.unit_ready_sequence??0)<1)
      throw new WorkspaceUnitRunError('WORKSPACE_UNIT_RECEIPT_INVALID');
    mutationUncertain=false;
    report('workspace_unit_ready',{unit_ready_sequence:receipt.unit_ready_sequence,baseline_count:accepted.baselines.length,
      chapter_scope_complete:accepted.chapter_scope_complete,apply_ready:false});
    return 'unit_ready';
  } catch(error) {
    await stopHeartbeat();
    const code=failureCode(error);
    report('workspace_unit_failed',{internal_failure_code:code,
      external_failure_code:code==='WORKSPACE_UNIT_WORKFLOW_TIMEOUT'||code==='PROVIDER_ERROR'?'PROVIDER_ERROR':'LESSON_VALIDATION_FAILED',
      dispatch_committed:dispatchCommitted,response_received:responseReceived,usage_complete:usage.usage_complete,
      usage_source:usage.usage_source});
    if(leaseLost||mutationUncertain||shutdown?.aborted) {
      report('workspace_unit_reconciliation_required',{internal_failure_code:code});
      return 'reconciliation_required';
    }
    try {
      const receipt=await deps.fail(lease,{code,outcome:dispatchCommitted&&!responseReceived?'uncertain':'known_failure'},usage);
      if(receipt.workspace_id!==lease.workspaceId||receipt.work_item_id!==lease.workItemId
        ||!['failed','timed_out','outcome_unknown','canceled'].includes(receipt.status))
        throw new WorkspaceUnitRunError('WORKSPACE_UNIT_RECEIPT_INVALID');
      return 'needs_action';
    } catch {
      report('workspace_unit_reconciliation_required',{internal_failure_code:'WORKSPACE_UNIT_TERMINAL_COMMIT_UNCONFIRMED'});
      return 'reconciliation_required';
    }
  } finally {
    await stopHeartbeat();cancelDeadline();
    controller.signal.removeEventListener('abort',rejectAbort);
    shutdown?.removeEventListener('abort',onShutdown);
  }
}
