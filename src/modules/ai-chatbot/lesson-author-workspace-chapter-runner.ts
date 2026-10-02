import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { projectBlueprintDraftArchitecture } from './lesson-author-blueprint-draft-architecture.logic.js';
import { assertRagChapterCheckpointRequest, readRagChapterCheckpointResponse,
  type RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';
import { workspaceChapterValidationUnits, acceptWorkspaceChapterValidation } from './lesson-author-workspace-chapter-validation.logic.js';
import type { WorkspaceChapterGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { WorkspaceWorkItemContext, WorkspaceWorkItemLease, WorkspaceWorkItemReceipt } from './lesson-author-workspace-work-item.repository.js';
import type { WorkspaceUnitClock, WorkspaceUnitUsage, WorkspaceUnitFailure } from './lesson-author-workspace-unit-runner.js';

export class WorkspaceChapterRunError extends Error {
  constructor(readonly code: 'WORKSPACE_CHAPTER_RUN_INVALID' | 'WORKSPACE_CHAPTER_WORKFLOW_TIMEOUT'
    | 'WORKSPACE_CHAPTER_LEASE_LOST' | 'WORKSPACE_CHAPTER_SHUTDOWN' | 'WORKSPACE_CHAPTER_RECEIPT_INVALID'
    | 'WORKSPACE_CHAPTER_UNEXPECTED_GENERATION_USAGE') { super(code); }
}
export interface WorkspaceChapterExecution { item: Readonly<WorkspaceWorkItemContext>; deadline_at: Date; }
export interface WorkspaceChapterPrepared { context: WorkspaceChapterGenerationContext; request: RagChapterCheckpointRequest; }
export interface WorkspaceChapterCompletion { input_context_hash: string; result_hash: string; validation_contract: 'workspace-chapter-baseline-1'; }
export interface WorkspaceChapterRunnerDependencies {
  /** Repository prepareChapter: fresh locked lease/source/runtime and real immutable-baseline loader. */
  prepare(execution: WorkspaceChapterExecution, signal: AbortSignal): Promise<WorkspaceChapterPrepared>;
  /** Must resolve only after the dispatch transaction commits. */
  markDispatched(lease: WorkspaceWorkItemLease): Promise<WorkspaceWorkItemReceipt>;
  renew(lease: WorkspaceWorkItemLease): Promise<WorkspaceWorkItemReceipt>;
  /** Existing Python validate_chapter endpoint ONLY. One invocation; never a generation fallback. */
  validate(request: RagChapterCheckpointRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  /** Same-tx actual accounting + fresh context/authority + repository completeValidation.
   * No revision or CMS write. Unknown observations retain the entire reservation. */
  completeValidation(lease: WorkspaceWorkItemLease, completion: WorkspaceChapterCompletion, usage: WorkspaceUnitUsage): Promise<WorkspaceWorkItemReceipt>;
  fail(lease: WorkspaceWorkItemLease, failure: WorkspaceUnitFailure, usage: WorkspaceUnitUsage): Promise<WorkspaceWorkItemReceipt>;
  report(event: Record<string, unknown>): void;
  clock?: WorkspaceUnitClock;
}
const realClock: WorkspaceUnitClock = {
  now:()=>Date.now(), timeout:(fn,ms)=>{const t=setTimeout(fn,ms);return()=>clearTimeout(t);},
  interval:(fn,ms)=>{const t=setInterval(fn,ms);return()=>clearInterval(t);},
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, HASH=/^[0-9a-f]{64}$/;
function invalid(): never { throw new WorkspaceChapterRunError('WORKSPACE_CHAPTER_RUN_INVALID'); }
function failureCode(error: unknown) {
  const e=error && typeof error==='object' ? error as { internal_failure_code?: unknown; code?: unknown } : {};
  const code=e.internal_failure_code??e.code;
  return typeof code==='string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'WORKSPACE_CHAPTER_EXECUTION_FAILED';
}
function checkPrepared(p: WorkspaceChapterPrepared,item: WorkspaceWorkItemContext) {
  const c=p.context,r=p.request;
  assertRagChapterCheckpointRequest(r);
  if (r.checkpoint_action!=='validate_chapter' || c.input_context_hash!==item.input_context_hash
    || c.source_snapshot_hash!==item.source_snapshot_hash || c.correlation_id!==item.correlation_id
    || r.correlation_id!==item.correlation_id || r.tenant_id!==item.target.tenantId || r.conversation_id!==item.target.conversationId
    || r.locale!==item.content_locale || !Number.isSafeInteger(c.chapterIndex) || c.chapterIndex<0
    || !c.targetNodes.some(n=>n.id===item.node_id && n.path===`chapter_${c.chapterIndex+1}` && n.contract_hash===item.contract_hash)
    || hash(r.blueprint_architecture)!==hash(projectBlueprintDraftArchitecture(c.blueprint,c.chapterIndex))
    || hash(r.checkpoint_units)!==hash(workspaceChapterValidationUnits(c))) invalid();
}

/** Already-admitted validation item only. Python transport retains the SAME
 * existing content request token/attempt policy prepared by main. Those fields
 * are NOT paid generation authority; persisted admission MUST remain zero
 * output/attempts. This runner never substitutes transport/provider limits. The endpoint's
 * validate_chapter branch makes no Gemini generation call (retrieval may bill).
 * Never rewrites accepted CMS baselines from Python's lossy wire projection.
 * No retries, scheduler, providers, database connection, or timers on import. */
export async function runWorkspaceChapter(execution: WorkspaceChapterExecution, deps: WorkspaceChapterRunnerDependencies,
  shutdown?: AbortSignal): Promise<'chapter_validated' | 'needs_action' | 'reconciliation_required'> {
  const lease=Object.freeze({...execution.item.target}),item=Object.freeze({...structuredClone(execution.item),target:lease});
  const clock=deps.clock??realClock,started=clock.now(),deadline=execution.deadline_at.getTime();
  if (item.kind!=='validate_chapter' || item.dispatched || item.max_output_tokens!==0 || item.max_provider_attempts!==0
    || ![lease.tenantId,lease.userId,lease.workspaceId,lease.workItemId,lease.leaseToken,lease.conversationId,item.node_id,item.correlation_id].every(v=>UUID.test(v))
    || ![item.input_context_hash,item.source_snapshot_hash,item.contract_hash].every(v=>HASH.test(v))
    || !Number.isFinite(deadline) || deadline-started>600_000 || !['en','vi'].includes(item.content_locale)) invalid();
  const end=Math.min(started+480_000,deadline-60_000),controller=new AbortController();
  let stage='workspace_chapter_prepare',mutationUncertain=false,dispatchCommitted=false,responseReceived=false;
  let leaseLost=false,closing=false,renewal:Promise<void>|null=null;
  let usage:WorkspaceUnitUsage={usage_complete:false,usage_source:'unavailable',usage:{}};
  const report=(event:string,extra:Record<string,unknown>={})=>{
    try {deps.report({event,correlation_id:item.correlation_id,workspace_id:lease.workspaceId,work_item_id:lease.workItemId,
      node_id:item.node_id,failure_stage:stage,duration_ms:Math.max(0,clock.now()-started),...extra});}catch{/* diagnostics only */}
  };
  const abort=(code:ConstructorParameters<typeof WorkspaceChapterRunError>[0])=>{
    if(!controller.signal.aborted)controller.abort(new WorkspaceChapterRunError(code));
  };
  const onShutdown=()=>abort('WORKSPACE_CHAPTER_SHUTDOWN');
  shutdown?.addEventListener('abort',onShutdown,{once:true});if(shutdown?.aborted)onShutdown();
  const remaining=()=>{if(clock.now()>=end)abort('WORKSPACE_CHAPTER_WORKFLOW_TIMEOUT');controller.signal.throwIfAborted();return Math.floor(end-clock.now());};
  let rejectAbort!:()=>void;
  const interrupted=new Promise<never>((_,reject)=>{
    rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true});
    if(controller.signal.aborted)rejectAbort();
  });
  void interrupted.catch(()=>undefined);
  const wait=<T>(promise:Promise<T>)=>Promise.race([promise,interrupted]);
  const cancelDeadline=clock.timeout(()=>abort('WORKSPACE_CHAPTER_WORKFLOW_TIMEOUT'),Math.max(0,end-started));
  const cancelHeartbeat=clock.interval(()=>{
    if(closing||renewal||controller.signal.aborted)return;
    renewal=Promise.resolve().then(()=>deps.renew(lease)).then(receipt=>{
      if(receipt.workspace_id!==lease.workspaceId||receipt.work_item_id!==lease.workItemId||receipt.node_id!==item.node_id||receipt.status!=='running')
        throw new WorkspaceChapterRunError('WORKSPACE_CHAPTER_LEASE_LOST');
    }).catch(()=>{leaseLost=true;abort('WORKSPACE_CHAPTER_LEASE_LOST');}).finally(()=>{renewal=null;});
  },15_000);
  async function stopHeartbeat(){closing=true;cancelHeartbeat();if(renewal)await renewal;}
  try {
    remaining();report('workspace_chapter_started',{max_output_tokens:0,max_provider_attempts:0});
    const prepared=structuredClone(await wait(deps.prepare({item,deadline_at:new Date(deadline)},controller.signal)));
    remaining();checkPrepared(prepared,item);
    stage='workspace_chapter_dispatch';mutationUncertain=true;
    const dispatched=await deps.markDispatched(lease);
    if(dispatched.workspace_id!==lease.workspaceId||dispatched.work_item_id!==lease.workItemId||dispatched.node_id!==item.node_id
      ||dispatched.status!=='running'||dispatched.accounting_state!=='reserved'||dispatched.replayed)
      throw new WorkspaceChapterRunError('WORKSPACE_CHAPTER_RECEIPT_INVALID');
    mutationUncertain=false;dispatchCommitted=true;
    remaining();stage='workspace_chapter_python';report('workspace_chapter_dispatch_committed');
    const budget=remaining(),request={...prepared.request,remaining_workflow_budget_ms:budget};
    const raw=await wait(deps.validate(request,{signal:controller.signal,timeoutMs:budget}));
    responseReceived=true;remaining();stage='workspace_chapter_response_validation';
    const response=readRagChapterCheckpointResponse(raw,request);
    if(response.status!=='ready')invalid();
    usage={usage_complete:response.usage_complete,usage_source:response.usage_source,usage:structuredClone(response.usage)};
    if((usage.usage.outputTokens??0)!==0)throw new WorkspaceChapterRunError('WORKSPACE_CHAPTER_UNEXPECTED_GENERATION_USAGE');
    stage='workspace_chapter_node_validation';
    const accepted=acceptWorkspaceChapterValidation(prepared.context,request,raw);
    const completion:WorkspaceChapterCompletion={input_context_hash:accepted.input_context_hash,result_hash:accepted.result_hash,
      validation_contract:accepted.validation_contract};
    report('workspace_chapter_accepted',{unit_count:request.checkpoint_action==='validate_chapter'?request.checkpoint_units.length:0,
      usage_complete:usage.usage_complete,usage_source:usage.usage_source,input_tokens:usage.usage.inputTokens??null,
      output_tokens:usage.usage.outputTokens??null,embedding_tokens:usage.usage.embeddingTokens??null,total_tokens:usage.usage.totalTokens??null});
    remaining();await stopHeartbeat();remaining();stage='workspace_chapter_completion';mutationUncertain=true;
    const receipt=await deps.completeValidation(lease,completion,usage);
    if(receipt.workspace_id!==lease.workspaceId||receipt.work_item_id!==lease.workItemId||receipt.node_id!==item.node_id
      ||receipt.status!=='succeeded'||receipt.result_hash!==completion.result_hash
      ||!['settled','pending_reconciliation'].includes(receipt.accounting_state)
      ||!usage.usage_complete&&receipt.accounting_state!=='pending_reconciliation')
      throw new WorkspaceChapterRunError('WORKSPACE_CHAPTER_RECEIPT_INVALID');
    mutationUncertain=false;report('workspace_chapter_validated',{apply_ready:false});return 'chapter_validated';
  }catch(error){
    await stopHeartbeat();const code=failureCode(error);
    report('workspace_chapter_failed',{internal_failure_code:code,dispatch_committed:dispatchCommitted,response_received:responseReceived,
      usage_complete:usage.usage_complete,usage_source:usage.usage_source});
    if(leaseLost||mutationUncertain||shutdown?.aborted){report('workspace_chapter_reconciliation_required',{internal_failure_code:code});return 'reconciliation_required';}
    try {
      const uncertain=dispatchCommitted&&!responseReceived;
      const receipt=await deps.fail(lease,{code,outcome:uncertain?'uncertain':'known_failure'},usage);
      if(receipt.workspace_id!==lease.workspaceId||receipt.work_item_id!==lease.workItemId||receipt.node_id!==item.node_id
        ||!['failed','timed_out','outcome_unknown','canceled'].includes(receipt.status)
        ||!['settled','pending_reconciliation'].includes(receipt.accounting_state)
        ||dispatchCommitted&&(uncertain||!usage.usage_complete)&&receipt.accounting_state!=='pending_reconciliation')
        throw new WorkspaceChapterRunError('WORKSPACE_CHAPTER_RECEIPT_INVALID');
      return 'needs_action';
    }catch{report('workspace_chapter_reconciliation_required',{internal_failure_code:'WORKSPACE_CHAPTER_TERMINAL_COMMIT_UNCONFIRMED'});return 'reconciliation_required';}
  }finally{
    await stopHeartbeat();cancelDeadline();controller.signal.removeEventListener('abort',rejectAbort);shutdown?.removeEventListener('abort',onShutdown);
  }
}
