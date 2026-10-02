import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthUser } from '../../types/express.js';
import type { LessonAuthorBlueprint } from './chat.service.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';
import { createWorkspaceInventoryRepository } from './lesson-author-workspace-inventory.repository.js';
import { createWorkspaceAdmissionRepository, type WorkspaceAdmissionTarget } from './lesson-author-workspace-admission.repository.js';
import { createWorkspaceWorkItemRepository, type WorkspaceWorkItemLease } from './lesson-author-workspace-work-item.repository.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { buildWorkspaceBudgetManifest } from './lesson-author-workspace-budget.logic.js';
import { loadWorkspaceGenerationContext, loadWorkspaceChapterGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import { runWorkspaceUnit, type WorkspaceUnitUsage } from './lesson-author-workspace-unit-runner.js';
import { runWorkspaceChapter } from './lesson-author-workspace-chapter-runner.js';
import { workspaceChapterValidationUnits } from './lesson-author-workspace-chapter-validation.logic.js';
import { verifyWorkspaceSchema } from './lesson-author-workspace-schema.repository.js';
import { generationSnapshotHash as hash, type GenerationJobRow } from './lesson-author-generation-job.logic.js';
import type { GenerationJobSql, GenerationJobDatabase } from './lesson-author-generation-job.repository.js';
import { runtimeTenantSql } from '../../config/runtime-tenant-fence.js';

/** Injectable composition seam; production exports below retain their signatures.
 * Importing this module performs no config/connection/service initialization. */
export interface WorkspaceRuntimeDependencies {
  query: typeof import('../../config/database.js').query;
  transaction: GenerationJobDatabase['transaction'];
  env: Pick<typeof import('../../config/env.js').env,'LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED'|'LESSON_AUTHOR_WORKSPACE_READ_ENABLED'|'AI_TOKEN_RESERVATION_SECONDS'>;
  AppError: typeof import('../../middleware/error-handler.js').AppError;
  prepareDurableBlueprint: typeof import('./chat.service.js').prepareDurableBlueprint;
  prepareWorkspaceContentRuntime: typeof import('./chat.service.js').prepareWorkspaceContentRuntime;
  normalizeLessonAuthorProposal: typeof import('./chat.service.js').normalizeLessonAuthorProposal;
  withLessonAuthorConversationLock: typeof import('./chat.service.js').withLessonAuthorConversationLock;
  durableBlueprintRepository: typeof import('./lesson-author-durable-blueprint.service.js').durableBlueprintRepository;
  isDurableBlueprintWorkerReady: typeof import('./lesson-author-durable-blueprint.service.js').isDurableBlueprintWorkerReady;
  workspaceQuotaAccounting: typeof import('./lesson-author-workspace-accounting.service.js').workspaceQuotaAccounting;
  generateRagLessonAuthorCheckpoint: typeof import('./ai-rag-client.service.js').generateRagLessonAuthorCheckpoint;
  reserveTenantAiTokens: typeof import('./ai-token-quota.service.js').reserveTenantAiTokens;
  report(event: object): void;
  timers?: { set(callback:()=>void,ms:number): ReturnType<typeof setTimeout>; clear(timer:ReturnType<typeof setTimeout>):void };
  // Offline replacements may inspect composition callbacks; production uses real implementations.
  adapters?: Partial<{
    createWorkspaceAuthority: typeof createWorkspaceAuthority;
    createWorkspaceInventoryRepository: typeof createWorkspaceInventoryRepository;
    createWorkspaceAdmissionRepository: typeof createWorkspaceAdmissionRepository;
    createWorkspaceWorkItemRepository: typeof createWorkspaceWorkItemRepository;
    loadWorkspaceGenerationContext: typeof loadWorkspaceGenerationContext;
    loadWorkspaceChapterGenerationContext: typeof loadWorkspaceChapterGenerationContext;
    runWorkspaceUnit: typeof runWorkspaceUnit;
    runWorkspaceChapter: typeof runWorkspaceChapter;
    verifyWorkspaceSchema: typeof verifyWorkspaceSchema;
  }>;
}

export function createWorkspaceRuntime(deps:WorkspaceRuntimeDependencies){
const {query,env,AppError,prepareDurableBlueprint,prepareWorkspaceContentRuntime,normalizeLessonAuthorProposal,
  withLessonAuthorConversationLock,durableBlueprintRepository,isDurableBlueprintWorkerReady,workspaceQuotaAccounting,
  reserveTenantAiTokens}=deps;
const adapters={createWorkspaceAuthority,createWorkspaceInventoryRepository,createWorkspaceAdmissionRepository,
  createWorkspaceWorkItemRepository,loadWorkspaceGenerationContext,loadWorkspaceChapterGenerationContext,
  runWorkspaceUnit,runWorkspaceChapter,verifyWorkspaceSchema,...deps.adapters};
const timerApi=deps.timers??{set:setTimeout,clear:clearTimeout};
const transactionScope=new AsyncLocalStorage<boolean>();
const withDatabaseTransaction:GenerationJobDatabase['transaction']=work=>deps.transaction(tx=>transactionScope.run(true,()=>work(tx)));
const generateRagLessonAuthorCheckpoint:WorkspaceRuntimeDependencies['generateRagLessonAuthorCheckpoint']=(...args)=>{
  if(transactionScope.getStore())reject('WORKSPACE_PROVIDER_TRANSACTION_FORBIDDEN');
  return deps.generateRagLessonAuthorCheckpoint(...args);
};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const db={transaction:withDatabaseTransaction};
const log=(event:object)=>{try{deps.report(event);}catch{/* diagnostics never decide commits */}};
function reject(code:string):never{throw new AppError('Workspace operation could not be completed.',409,code);}
function code(error:unknown){const e=error&&typeof error==='object'?error as {code?:unknown;internal_failure_code?:unknown}:{};
  const c=e.internal_failure_code??e.code;
  return typeof c==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(c)?c:'WORKSPACE_RUNTIME_UNAVAILABLE';}
async function authority(tx:GenerationJobSql,target:WorkspaceAdmissionTarget){
  const found=await tx.query(`SELECT role FROM users WHERE id=$1 AND is_active=true FOR SHARE`,[target.userId]);
  const role=found.rows[0]?.role;
  if(found.rows.length!==1||!['staff','superuser','superadmin'].includes(String(role)))reject('WORKSPACE_RUNTIME_FORBIDDEN');
  return adapters.createWorkspaceAuthority({id:target.userId,tenantId:target.tenantId,role:role as AuthUser['role'],username:'',sessionMode:'normal'});
}
async function canEdit(tx:GenerationJobSql,target:WorkspaceAdmissionTarget){return(await authority(tx,target)).canEdit(tx,target);}

/** Always acquire the same prefix as admission/work-item/Apply BEFORE authority,
 * source or settings locks. Nested repositories re-acquire these locks safely. */
async function lockWorkspace(tx:GenerationJobSql,t:WorkspaceAdmissionTarget){
  await tx.query("SET LOCAL lock_timeout = '3000ms'");
  const advisory=await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',[`course:${t.tenantId}:${t.courseId}`]);
  if(advisory.rows.length!==1||advisory.rows[0].acquired!==true)reject('WORKSPACE_RUNTIME_CONFLICT');
  const course=await tx.query('SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE',[t.courseId,t.tenantId]);
  if(course.rows.length!==1)reject('WORKSPACE_RUNTIME_FORBIDDEN');
  const ws=await tx.query(`SELECT w.id,w.status,w.correlation_id FROM lesson_author_workspaces w
    JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.course_id=w.course_id
      AND c.user_id=w.requested_by AND c.bot_id=w.bot_id AND c.target='lesson_author'
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
      AND w.engine='self_built_rag' AND w.contract_version=1 FOR UPDATE OF w`,
  [t.workspaceId,t.tenantId,t.courseId,t.conversationId,t.userId]);
  if(ws.rows.length!==1||!UUID.test(String(ws.rows[0].correlation_id)))reject('WORKSPACE_RUNTIME_FORBIDDEN');
  return ws.rows[0];
}

/** Workspace row lock serializes message idempotency. No new unique index or
 * fake success receipt: key is the actual committed terminal event sequence.
 * All runtime terminal callers invoke this inside the event's outer transaction. */
async function terminalSummary(tx:GenerationJobSql,t:WorkspaceAdmissionTarget){
  const result=await tx.query(`SELECT w.status,w.correlation_id,w.content_locale,e.sequence,e.event_kind
    FROM lesson_author_workspaces w JOIN LATERAL (
      SELECT sequence,event_kind FROM lesson_author_workspace_events WHERE workspace_id=w.id
        AND event_kind=CASE w.status WHEN 'ready' THEN 'run_ready' WHEN 'needs_action' THEN 'run_needs_action' WHEN 'canceled' THEN 'run_canceled' END
      ORDER BY sequence DESC LIMIT 1) e ON true
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5`,
  [t.workspaceId,t.tenantId,t.courseId,t.conversationId,t.userId]);
  const w=result.rows[0];
  if(result.rows.length!==1||!UUID.test(String(w.correlation_id))||!['en','vi'].includes(String(w.content_locale))
    ||!Number.isSafeInteger(Number(w.sequence))||Number(w.sequence)<1)reject('WORKSPACE_RUNTIME_TERMINAL_UNCONFIRMED');
  const metadata={kind:'lesson_author_workspace_terminal',lesson_author_workspace_id:t.workspaceId,workspace_id:t.workspaceId,
    correlation_id:String(w.correlation_id),locale:String(w.content_locale),workspace_status:String(w.status),
    workspace_event_sequence:Number(w.sequence),workspace_event_kind:String(w.event_kind)};
  const content=w.status==='ready'
    ? w.content_locale==='en'?'The storyboard draft is ready for review. Apply the units or chapters you choose; completion does not automatically apply content to the course.'
      :'Bản nháp storyboard đã sẵn sàng để xem lại. Bạn có thể áp dụng từng bài hoặc chương đã chọn; hoàn tất bản nháp không tự áp dụng nội dung vào khóa học.'
    : w.content_locale==='en'?'The storyboard run has stopped and needs your review. Saved work is preserved. Uncertain AI usage remains held for reconciliation; this run will not retry automatically.'
      :'Quá trình tạo storyboard đã dừng và cần bạn xem lại. Nội dung đã lưu được giữ nguyên. Mức sử dụng AI chưa xác định vẫn được giữ để đối soát; hệ thống không tự thử lại.';
  const params=[t.conversationId,t.workspaceId,String(w.correlation_id),String(w.sequence)];
  const find=()=>tx.query(`SELECT id,content,metadata FROM chat_messages WHERE conversation_id=$1::uuid AND role='assistant'
    AND metadata->>'kind'='lesson_author_workspace_terminal' AND metadata->>'workspace_id'=$2::text
    AND metadata->>'correlation_id'=$3::text AND metadata->>'workspace_event_sequence'=$4::text`,params);
  const existing=await find();
  if(existing.rows.length>1)reject('WORKSPACE_RUNTIME_TERMINAL_UNCONFIRMED');
  if(!existing.rows.length){
    const inserted=await tx.query(`INSERT INTO chat_messages(conversation_id,role,content,metadata)
      VALUES($1::uuid,'assistant',$2::text,$3::jsonb) RETURNING id`,[t.conversationId,content,JSON.stringify(metadata)]);
    if(inserted.rows.length!==1||!UUID.test(String(inserted.rows[0].id)))reject('WORKSPACE_RUNTIME_TERMINAL_UNCONFIRMED');
    await tx.query('UPDATE chat_conversations SET updated_at=now() WHERE id=$1 AND tenant_id=$2',[t.conversationId,t.tenantId]);
  }
  const saved=await find();
  if(saved.rows.length!==1||saved.rows[0].content!==content||hash(saved.rows[0].metadata)!==hash(metadata))
    reject('WORKSPACE_RUNTIME_TERMINAL_UNCONFIRMED');
}

/** Private bounded seed: never return through public status/event APIs. */
async function seed(tx:GenerationJobSql,t:WorkspaceAdmissionTarget){
  const result=await tx.query(`SELECT w.bot_id,w.kb_id,w.source_snapshot_hash,w.source_document_ids,w.correlation_id,w.content_locale,
      w.blueprint_id,j.id AS blueprint_job_id,j.user_message_id,
      CASE WHEN octet_length(b.blueprint::text)<=16777216 THEN b.blueprint ELSE NULL END AS blueprint
    FROM lesson_author_workspaces w JOIN lesson_author_blueprints b ON b.id=w.blueprint_id AND b.tenant_id=w.tenant_id
      AND b.course_id=w.course_id AND b.conversation_id=w.conversation_id AND b.requested_by=w.requested_by
      AND b.bot_id=w.bot_id AND b.kb_id=w.kb_id AND b.engine=w.engine AND b.status='proposed' AND b.source_snapshot_hash=w.source_snapshot_hash
    JOIN lesson_author_generation_jobs j ON j.correlation_id=w.correlation_id AND j.tenant_id=w.tenant_id
      AND j.conversation_id=w.conversation_id AND j.requested_by=w.requested_by AND j.course_id=w.course_id
      AND j.bot_id=w.bot_id AND j.kb_id=w.kb_id AND j.status='succeeded' AND j.result_blueprint_id=b.id
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5`,
  [t.workspaceId,t.tenantId,t.courseId,t.conversationId,t.userId]);
  const w=result.rows[0];
  if(result.rows.length!==1||!w.blueprint||!['vi','en'].includes(String(w.content_locale))
    ||![w.bot_id,w.kb_id,w.correlation_id,w.blueprint_id,w.blueprint_job_id,w.user_message_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||!Array.isArray(w.source_document_ids)||!w.source_document_ids.every(v=>typeof v==='string'&&UUID.test(v)))reject('WORKSPACE_RUNTIME_CONTEXT_INVALID');
  return { ...t, botId:String(w.bot_id),kbId:String(w.kb_id),correlationId:String(w.correlation_id),locale:w.content_locale as 'en'|'vi',
    sourceDocumentIds:w.source_document_ids as string[],sourceSnapshotHash:String(w.source_snapshot_hash),blueprint:w.blueprint as LessonAuthorBlueprint,
    blueprintId:String(w.blueprint_id),blueprintJobId:String(w.blueprint_job_id),architectureMessageId:String(w.user_message_id) };
}
async function runtime(tx:GenerationJobSql,t:WorkspaceAdmissionTarget,chapterIndex=0){
  // Freeze all runtime policy/key dependencies for this short DB operation.
  // Secrets are only locked; they are never selected into logs or metadata.
  await tx.query(`SELECT tenant_id FROM tenant_ai_settings WHERE tenant_id=$1 FOR SHARE`,[t.tenantId]);
  await tx.query(`SELECT tenant_id FROM tenant_ai_provider_secrets WHERE tenant_id=$1 FOR SHARE`,[t.tenantId]);
  await tx.query(`SELECT p.id FROM chat_conversations c JOIN bot_personas p ON p.id=c.persona_id
    JOIN system_prompt_templates s ON s.id=p.template_id WHERE c.id=$1 AND c.tenant_id=$2 FOR SHARE OF c,p,s`,[t.conversationId,t.tenantId]);
  const s=await seed(tx,t),a=await authority(tx,t);
  if(!await a.canEdit(tx,t))reject('WORKSPACE_RUNTIME_FORBIDDEN');
  if(await a.currentSourceHash(tx,{target:t,source_snapshot_hash:s.sourceSnapshotHash})!==s.sourceSnapshotHash)reject('WORKSPACE_SOURCE_CHANGED');
  const prepared=await prepareWorkspaceContentRuntime({...s,chapterIndex});
  const allowed=await a.allowedComponents(tx,t);
  if(hash([...allowed].sort())!==hash([...prepared.allowed].sort()))reject('WORKSPACE_RUNTIME_CAPABILITY_CHANGED');
  return{...prepared,seed:s};
}
const unobserved:WorkspaceUnitUsage={usage_complete:false,usage_source:'unavailable',usage:{}};
async function failClaim(lease:WorkspaceWorkItemLease,failure:Parameters<ReturnType<typeof items>['fail']>[1],usage:WorkspaceUnitUsage,embeddingModel?:string){
  return withDatabaseTransaction(async tx=>{
    await lockWorkspace(tx,lease);
    const receipt=await items(usage,embeddingModel).fail(lease,failure);
    await terminalSummary(tx,lease);return receipt;
  });
}
function items(observed:WorkspaceUnitUsage=unobserved,embeddingModel?:string){
  return adapters.createWorkspaceWorkItemRepository({db,
    freshAuthority:(tx,c)=>canEdit(tx,c.target),
    currentSourceHash:async(tx,c)=>(await authority(tx,c.target)).currentSourceHash(tx,c),
    currentRuntimeHash:async(tx,c)=>(await runtime(tx,c.target)).runtimeHash,
    account:workspaceQuotaAccounting(observed,embeddingModel),report:log});
}
function admission(){
  return adapters.createWorkspaceAdmissionRepository({db,
    freshAuthority:(tx,c)=>canEdit(tx,c.target),
    currentSourceHash:async(tx,c)=>(await authority(tx,c.target)).currentSourceHash(tx,c),
    currentRuntimeHash:async(tx,c)=>(await runtime(tx,c.target)).runtimeHash,
    currentInventoryHash:async(tx,c)=>{const r=await runtime(tx,c.target);return buildWorkspaceInventory(r.seed.blueprint,r.allowed).inventory_hash;},
    inputContextHash:async(tx,c,entry)=>{const allowed=await(await authority(tx,c.target)).allowedComponents(tx,c.target);
      const target={...c.target,nodeId:entry.node_id};
      return entry.kind==='generate_unit'?(await adapters.loadWorkspaceGenerationContext(tx,target,allowed)).input_context_hash
        :(await adapters.loadWorkspaceChapterGenerationContext(tx,target,allowed)).input_context_hash;},
    grant:async(tx,c)=>{
      const r=await runtime(tx,c.target);if(r.model!==c.model||r.runtimeHash!==c.runtime_config_hash)reject('WORKSPACE_RUNTIME_CHANGED');
      const e=c.entry,grant=await reserveTenantAiTokens({tenantId:c.target.tenantId,userId:c.target.userId,conversationId:c.target.conversationId,
        target:'lesson_author',engine:'self_built_rag',provider:r.provider,model:c.model,operation:'lesson_author',
        minimumTokens:c.reserved_tokens,maximumTokens:c.reserved_tokens,budget:{inputTokens:e.input_tokens,outputTokens:e.output_tokens,
          embeddingTokens:e.embedding_tokens,maxOutputTokens:e.max_output_tokens,metadata:{...c.budget_metadata,correlation_id:c.correlation_id}}});
      if(grant.reservedTokens!==c.reserved_tokens||grant.isPartialGrant)reject('WORKSPACE_RUNTIME_GRANT_INVALID');
      return{reservation_id:grant.id};
    },report:log});
}

/** Creation is atomic with the EXISTING durable Blueprint enqueue/message/token
 * reservation. Same idempotency identity survives an uncertain POST; no second
 * provider call or independent correlation is generated on replay. */
async function createLessonAuthorWorkspace(user:AuthUser,input:{courseId:string;conversationId:string;operationId:string;sourceDocumentIds:string[];locale:'en'|'vi'}){
  if(!ready||!isDurableBlueprintWorkerReady())throw new AppError('Workspace worker is not ready.',503,'WORKSPACE_EXECUTION_DISABLED');
  if(user.sessionMode!=='normal'||!user.tenantId||!['staff','superuser','superadmin'].includes(user.role)
    ||![user.id,user.tenantId,input.conversationId,input.operationId].every(id=>UUID.test(id))
    ||!input.sourceDocumentIds.length||input.sourceDocumentIds.length>5||new Set(input.sourceDocumentIds).size!==input.sourceDocumentIds.length
    ||input.sourceDocumentIds.some(id=>!UUID.test(id))||!['en','vi'].includes(input.locale))reject('WORKSPACE_CREATE_INPUT_INVALID');
  const tenantId=user.tenantId,content=input.locale==='en'?'Create lesson content from the selected documents.':'Tạo nội dung bài học từ tài liệu đã chọn.';
  return withLessonAuthorConversationLock(input.conversationId,async()=>{
    const prior=await query<GenerationJobRow>(`SELECT * FROM lesson_author_generation_jobs WHERE tenant_id=$1 AND conversation_id=$2 AND requested_by=$3 AND idempotency_key=$4`,
      [tenantId,input.conversationId,user.id,input.operationId]);
    const prepared=await prepareDurableBlueprint(input.conversationId,user.id,tenantId,content,{target:'lesson_author',courseId:input.courseId,
      mode:'course_blueprint',locale:input.locale,sourceDocuments:input.sourceDocumentIds.map(document_id=>({document_id}))},prior.rows[0]);
    if(!prepared)reject('WORKSPACE_ENGINE_UNSUPPORTED');
    if(!prior.rows.length)await prepared.filterInput();
    const root=prior.rows[0]?.correlation_id??randomUUID();
    const result=await withDatabaseTransaction(async tx=>{
      const a=adapters.createWorkspaceAuthority(user),target={tenantId,userId:user.id,conversationId:input.conversationId,courseId:input.courseId,workspaceId:input.operationId};
      // Consistent course→conversation→workspace lock order; no provider I/O.
      const course=await tx.query(`SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`,[input.courseId,tenantId]);
      if(course.rows.length!==1)reject('WORKSPACE_RUNTIME_FORBIDDEN');
      if(!await a.canEdit(tx,target))reject('WORKSPACE_RUNTIME_FORBIDDEN');
      const active=await tx.query(`SELECT id FROM lesson_author_workspaces WHERE tenant_id=$1 AND course_id=$2 AND requested_by=$3
        AND status IN ('queued','designing','drafting') AND idempotency_key<>$4 FOR UPDATE`,[tenantId,input.courseId,user.id,input.operationId]);
      if(active.rows.length)reject('WORKSPACE_ALREADY_ACTIVE');
      const job=await durableBlueprintRepository.enqueue({...prepared.identity,idempotencyKey:input.operationId,correlationId:root},()=>prepared.reserveAndCreateMessage(root));
      const existing=await tx.query(`SELECT id,conversation_id,correlation_id,content_locale,status,request_hash FROM lesson_author_workspaces
        WHERE tenant_id=$1 AND conversation_id=$2 AND requested_by=$3 AND idempotency_key=$4 FOR UPDATE`,[tenantId,input.conversationId,user.id,input.operationId]);
      if(existing.rows.length){const w=existing.rows[0];if(w.correlation_id!==job.job.correlation_id||w.request_hash!==prepared.identity.requestHash)reject('WORKSPACE_CREATE_CONFLICT');
        return{workspace_id:String(w.id),conversation_id:String(w.conversation_id),correlation_id:String(w.correlation_id),content_locale:input.locale,status:String(w.status),replayed:true};}
      // A legacy enqueue cannot later be taken over as a workspace by replay.
      if(!job.created)reject('WORKSPACE_CREATE_CONFLICT');
      const id=randomUUID();
      await tx.query(`INSERT INTO lesson_author_workspaces(id,tenant_id,course_id,conversation_id,requested_by,bot_id,kb_id,
        content_locale,correlation_id,idempotency_key,request_hash,source_snapshot_hash,source_document_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid[])`,[id,tenantId,input.courseId,input.conversationId,user.id,
        prepared.identity.botId,prepared.identity.kbId,input.locale,root,input.operationId,prepared.identity.requestHash,prepared.identity.sourceSnapshotHash,prepared.identity.sourceDocumentIds]);
      // Installed publish_lesson_author_workspace_created trigger emits the
      // unique workspace_created event; a second INSERT would roll back creation.
      await tx.query(`UPDATE lesson_author_workspaces SET status='designing' WHERE id=$1`,[id]);
      await tx.query(`INSERT INTO lesson_author_workspace_events(workspace_id,tenant_id,course_id,event_kind,operation_id)
        VALUES($1,$2,$3,'architecture_started',$4)`,[id,tenantId,input.courseId,input.operationId]);
      await tx.query(`UPDATE chat_messages SET metadata=metadata||$3::jsonb WHERE id=$1 AND conversation_id=$2`,
        [job.job.user_message_id,input.conversationId,JSON.stringify({lesson_author_workspace_id:id})]);
      return{workspace_id:id,conversation_id:input.conversationId,correlation_id:root,content_locale:input.locale,status:'designing',replayed:false};
    });
    if(!result.replayed)prepared.markAccepted();log({event:'workspace_created',...result});return result;
  });
}

async function prepareRun(t:WorkspaceAdmissionTarget){
  return withDatabaseTransaction(async tx=>{
  await lockWorkspace(tx,t);
  const baseline=await runtime(tx,t);
  const inventory=buildWorkspaceInventory(baseline.seed.blueprint,baseline.allowed);
  const nodes=await tx.query(`SELECT id,canonical_path,contract_hash,protected_contract FROM lesson_author_workspace_nodes
    WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 ORDER BY canonical_path LIMIT 8193`,[t.workspaceId,t.tenantId,t.courseId]);
  const byPath=new Map(nodes.rows.map(n=>[String(n.canonical_path),n]));
  if(byPath.size!==inventory.nodes.length||nodes.rows.length!==inventory.nodes.length)reject('WORKSPACE_RUNTIME_INVENTORY_INVALID');
  for(const n of inventory.nodes){const found=byPath.get(n.canonical_path);
    if(!found||found.contract_hash!==n.contract_hash||hash(found.protected_contract)!==n.contract_hash)reject('WORKSPACE_RUNTIME_INVENTORY_INVALID');}
  const chapters=[];
  for(let ci=0;ci<baseline.seed.blueprint.chapters.length;ci++){
    const r=ci===0?baseline:await runtime(tx,t,ci);
    if(r.runtimeHash!==baseline.runtimeHash||hash(r.seed.blueprint)!==hash(baseline.seed.blueprint))reject('WORKSPACE_RUNTIME_CHANGED');
    const chapter=byPath.get(`chapter_${ci+1}`)!;
    const units=baseline.seed.blueprint.chapters[ci].lessons.flatMap((l,li)=>l.units.map((_u,ui)=>{
      const n=byPath.get(`chapter_${ci+1}.lesson_${li+1}.unit_${ui+1}`)!;return{node_id:String(n.id),contract_hash:String(n.contract_hash)};}));
    chapters.push({chapter_node_id:String(chapter.id),chapter_contract_hash:String(chapter.contract_hash),units,...r.budget});
  }
  return admission().admitRun(t,{blueprint_job_id:baseline.seed.blueprintJobId,inventory_hash:inventory.inventory_hash,
    runtime_config_hash:baseline.runtimeHash,model:baseline.model,budget:buildWorkspaceBudgetManifest(chapters)});
  });
}

async function executeClaim(claim:Awaited<ReturnType<ReturnType<typeof admission>['claimNext']>>,signal:AbortSignal){
  const lease=claim.lease,repository=items();
  let embeddingModel:string|undefined;
  if(claim.kind==='generate_unit'){
    const r=await withDatabaseTransaction(async tx=>{
      await lockWorkspace(tx,lease);
      const allowed=await(await authority(tx,lease)).allowedComponents(tx,lease);
      return repository.prepareUnit(lease,allowed);
    });
    return adapters.runWorkspaceUnit({item:r.item,deadline_at:r.deadline_at},{
      prepare:async()=>withDatabaseTransaction(async tx=>{
        await lockWorkspace(tx,lease);
        const allowed=await(await authority(tx,lease)).allowedComponents(tx,lease),prepared=await repository.prepareUnit(lease,allowed);
        const ci=Number(prepared.context.unitPath.split('.')[0].slice('chapter_'.length))-1,rt=await runtime(tx,lease,ci);
        if(rt.runtimeHash!==prepared.item.runtime_config_hash)reject('WORKSPACE_RUNTIME_CHANGED');embeddingModel=rt.embeddingModel;
        const paths=rt.seed.blueprint.chapters[ci].lessons.flatMap((l,li)=>l.units.map((_u,ui)=>`chapter_${ci+1}.lesson_${li+1}.unit_${ui+1}`));
        return{context:prepared.context,request:{...rt.request,max_output_tokens:prepared.item.max_output_tokens,max_attempts:prepared.item.max_provider_attempts,
          checkpoint_version:1 as const,checkpoint_action:'generate_unit' as const,checkpoint_unit_index:paths.indexOf(prepared.context.unitPath),remaining_workflow_budget_ms:480000}};
      }),markDispatched:repository.markDispatched,renew:repository.renew,generate:generateRagLessonAuthorCheckpoint,normalizeProposal:normalizeLessonAuthorProposal,
      publish:async(l,p,u)=>withDatabaseTransaction(async tx=>{
        await lockWorkspace(tx,l);
        if(!await canEdit(tx,l))reject('WORKSPACE_RUNTIME_FORBIDDEN');
        const allowed=await(await authority(tx,l)).allowedComponents(tx,l);
        const current=await adapters.loadWorkspaceGenerationContext(tx,{...l,nodeId:r.item.node_id},allowed);
        if(current.input_context_hash!==p.input_context_hash)reject('WORKSPACE_GENERATION_CONTEXT_CHANGED');
        return items(u,embeddingModel).publishUnit(l,p);
      }),fail:(l,f,u)=>failClaim(l,f,u,embeddingModel),report:log,
    },signal);
  }
  const r=await withDatabaseTransaction(async tx=>{
    await lockWorkspace(tx,lease);
    const allowed=await(await authority(tx,lease)).allowedComponents(tx,lease);return repository.prepareChapter(lease,allowed);
  });
  return adapters.runWorkspaceChapter({item:r.item,deadline_at:r.deadline_at},{
    prepare:async()=>withDatabaseTransaction(async tx=>{
      await lockWorkspace(tx,lease);
      const allowed=await(await authority(tx,lease)).allowedComponents(tx,lease),prepared=await repository.prepareChapter(lease,allowed);
      const rt=await runtime(tx,lease,prepared.context.chapterIndex);embeddingModel=rt.embeddingModel;
      if(rt.runtimeHash!==prepared.item.runtime_config_hash)reject('WORKSPACE_RUNTIME_CHANGED');
      return{context:prepared.context,request:{...rt.request,checkpoint_version:1 as const,checkpoint_action:'validate_chapter' as const,
        checkpoint_units:workspaceChapterValidationUnits(prepared.context),remaining_workflow_budget_ms:480000}};
    }),markDispatched:repository.markDispatched,renew:repository.renew,validate:generateRagLessonAuthorCheckpoint,
    completeValidation:(l,p,u)=>withDatabaseTransaction(async tx=>{
      await lockWorkspace(tx,l);
      if(!await canEdit(tx,l))reject('WORKSPACE_RUNTIME_FORBIDDEN');
      const allowed=await(await authority(tx,l)).allowedComponents(tx,l);
      const current=await adapters.loadWorkspaceChapterGenerationContext(tx,{...l,nodeId:r.item.node_id},allowed);
      if(current.input_context_hash!==p.input_context_hash)reject('WORKSPACE_GENERATION_CONTEXT_CHANGED');
      return items(u,embeddingModel).completeValidation(l,p);
    }),fail:(l,f,u)=>failClaim(l,f,u,embeddingModel),report:log,
  },signal);
}

async function interruptUnclaimed(t:WorkspaceAdmissionTarget,root:string,failure:string){
  const outcome=await withDatabaseTransaction(async tx=>{
    const w=await lockWorkspace(tx,t);
    if(w.correlation_id!==root)reject('WORKSPACE_RUNTIME_CONTEXT_INVALID');
    if(!['designing','drafting'].includes(String(w.status)))return 'already_terminal';
    // A possibly committed claim owns its accounting/terminal outcome. Do not
    // overwrite it; lease recovery must reconcile it first.
    const live=await tx.query(`SELECT id FROM lesson_author_workspace_work_items WHERE workspace_id=$1 AND status='running' LIMIT 1`,[t.workspaceId]);
    if(live.rows.length)return 'reconciliation_required';
    const stopped=await tx.query(`UPDATE lesson_author_workspaces SET status='needs_action' WHERE id=$1 AND status IN ('designing','drafting') RETURNING id`,[t.workspaceId]);
    if(stopped.rows.length!==1||stopped.rows[0].id!==t.workspaceId)reject('WORKSPACE_RUNTIME_TERMINAL_UNCONFIRMED');
    const event=await tx.query(`INSERT INTO lesson_author_workspace_events(workspace_id,tenant_id,course_id,event_kind,operation_id)
      VALUES($1,$2,$3,'run_needs_action',$4) RETURNING sequence`,[t.workspaceId,t.tenantId,t.courseId,randomUUID()]);
    if(event.rows.length!==1||!Number.isSafeInteger(Number(event.rows[0].sequence))||Number(event.rows[0].sequence)<1)
      reject('WORKSPACE_RUNTIME_TERMINAL_UNCONFIRMED');
    await terminalSummary(tx,t);
    return 'needs_action';
  });
  log({event:outcome==='needs_action'?'workspace_run_needs_action':'workspace_runtime_terminal_deferred',
    outcome,workspace_id:t.workspaceId,correlation_id:root,internal_failure_code:failure,
    external_failure_code:'LESSON_AUTHOR_WORKSPACE_FAILED',failure_stage:'workspace_runtime_preflight'});
  return outcome;
}

/** One bounded fair scheduling tick; never holds a DB transaction across Python
 * I/O, never claims an existing/failed ordinal, never uses Apply as sequencing. */
async function tick(signal:AbortSignal){
  if(signal.aborted)return;
  const expiredTenantFence=runtimeTenantSql('a.tenant_id',1);
  const expired=await query(`SELECT a.id,a.lease_token,a.workspace_id,a.tenant_id,a.course_id,w.conversation_id,w.requested_by,w.correlation_id
    FROM lesson_author_workspace_work_items a JOIN lesson_author_workspaces w ON w.id=a.workspace_id
    WHERE a.status='running' AND (a.lease_expires_at<=clock_timestamp() OR a.deadline_at<=clock_timestamp())
      ${expiredTenantFence.clause}
    ORDER BY a.lease_expires_at,a.id LIMIT 1`,expiredTenantFence.params);
  if(signal.aborted)return;
  if(expired.rows[0]){
    const a=expired.rows[0];
    try{
      const lease={workspaceId:String(a.workspace_id),workItemId:String(a.id),leaseToken:String(a.lease_token),
        tenantId:String(a.tenant_id),courseId:String(a.course_id),conversationId:String(a.conversation_id),userId:String(a.requested_by)};
      await withDatabaseTransaction(async tx=>{
        await lockWorkspace(tx,lease);
        const receipt=await items().recover(lease);
        if(['failed','timed_out','outcome_unknown','canceled'].includes(receipt.status))await terminalSummary(tx,lease);
      });
    }
    catch(error){log({event:'workspace_recovery_pending',workspace_id:String(a.workspace_id),work_item_id:String(a.id),
      correlation_id:UUID.test(String(a.correlation_id))?String(a.correlation_id):null,internal_failure_code:code(error),
      failure_stage:'workspace_runtime_recovery',replay_after_dispatch:false});}
    return;
  }
  const candidateTenantFence=runtimeTenantSql('w.tenant_id',1);
  const candidates=await query(`SELECT w.id,w.tenant_id,w.course_id,w.conversation_id,w.requested_by,w.correlation_id,w.status,
      j.status AS architecture_status,j.result_blueprint_id,r.workspace_id AS admitted,
      (SELECT count(*)::integer FROM lesson_author_workspace_work_items a WHERE a.workspace_id=w.id) AS next_ordinal,
      jsonb_array_length(r.budget_manifest->'entries') AS item_count
    FROM lesson_author_workspaces w JOIN lesson_author_generation_jobs j ON j.correlation_id=w.correlation_id AND j.tenant_id=w.tenant_id
      AND j.course_id=w.course_id AND j.conversation_id=w.conversation_id AND j.requested_by=w.requested_by
    LEFT JOIN lesson_author_workspace_runs r ON r.workspace_id=w.id
    WHERE w.status IN ('designing','drafting') AND j.status NOT IN ('queued','running')
      AND NOT EXISTS (SELECT 1 FROM lesson_author_workspace_work_items a WHERE a.workspace_id=w.id AND a.status<>'succeeded')
      ${candidateTenantFence.clause}
    ORDER BY w.updated_at,w.id LIMIT 1`,candidateTenantFence.params);
  if(!candidates.rows[0]||signal.aborted)return;
  const w=candidates.rows[0],t={workspaceId:String(w.id),tenantId:String(w.tenant_id),courseId:String(w.course_id),
    conversationId:String(w.conversation_id),userId:String(w.requested_by)},root=String(w.correlation_id);
  try{
    if(w.architecture_status!=='succeeded'){await interruptUnclaimed(t,root,'WORKSPACE_ARCHITECTURE_FAILED');return;}
    if(w.status==='designing'){
      await withDatabaseTransaction(async tx=>{
        await lockWorkspace(tx,t);
        const a=await authority(tx,t);
        await adapters.createWorkspaceInventoryRepository({db,canEdit:a.canEdit,currentSourceHash:a.currentSourceHash,allowedComponents:a.allowedComponents,report:log})
          .publish({...t,blueprintId:String(w.result_blueprint_id),operationId:randomUUID()});
      });return;
    }
    if(!w.admitted){await prepareRun(t);return;}
    if(Number(w.next_ordinal)===Number(w.item_count)){
      await withDatabaseTransaction(async tx=>{
        await lockWorkspace(tx,t);await admission().completeRun(t);await terminalSummary(tx,t);
      });return;
    }
    signal.throwIfAborted();
    const claim=await admission().claimNext(t,{expectedOrdinal:Number(w.next_ordinal),idempotencyKey:randomUUID()});
    if(signal.aborted){
      log({event:'workspace_claim_recovery_pending',workspace_id:t.workspaceId,work_item_id:claim.lease.workItemId,
        correlation_id:root,internal_failure_code:'WORKSPACE_RUNTIME_SHUTDOWN',failure_stage:'workspace_runtime_claim'});
      return; // persisted undispatched lease is released only by fenced expiry recovery
    }
    const outcome=await executeClaim(claim,signal);
    if(outcome==='reconciliation_required')log({event:'workspace_claim_recovery_pending',workspace_id:t.workspaceId,
      work_item_id:claim.lease.workItemId,correlation_id:root,internal_failure_code:'WORKSPACE_RUNTIME_COMMIT_UNCONFIRMED',failure_stage:'workspace_runtime_execute'});
  }catch(error){
    log({event:'workspace_runtime_failed',correlation_id:root,workspace_id:t.workspaceId,internal_failure_code:code(error),failure_stage:'workspace_runtime_tick'});
    if(!signal.aborted){
      try{await interruptUnclaimed(t,root,code(error));}
      catch(terminalError){log({event:'workspace_runtime_terminal_pending',workspace_id:t.workspaceId,correlation_id:root,
        internal_failure_code:code(terminalError),original_failure_code:code(error),failure_stage:'workspace_runtime_terminal'});}
    }
  }
}

let ready=false,timer:ReturnType<typeof setTimeout>|null=null,stopping:AbortController|null=null,draining:Promise<void>|null=null;
let starting:Promise<void>|null=null,stopInProgress:Promise<void>|null=null;
function isLessonAuthorWorkspaceReady(){return ready;}
async function startLessonAuthorWorkspaceWorker(){
  if(starting)return starting;
  if(!env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED||stopping||stopInProgress)return;
  const controller=new AbortController();stopping=controller;
  starting=(async()=>{
    try{
      if(!env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED||!isDurableBlueprintWorkerReady()||env.AI_TOKEN_RESERVATION_SECONDS<600)
        throw new AppError('Workspace dependencies are unavailable.',503,'WORKSPACE_RUNTIME_NOT_READY');
      const schema=await adapters.verifyWorkspaceSchema({query},true);
      if(schema.status!=='CATALOG_VERIFIED'||schema.execution!==true)reject('WORKSPACE_RUNTIME_NOT_READY');
      if(controller.signal.aborted)return;
      // Recheck dependencies after asynchronous verification; never revive a stopped start.
      if(!env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED||!env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED||!isDurableBlueprintWorkerReady())
        reject('WORKSPACE_RUNTIME_NOT_READY');
      const signal=controller.signal;ready=true;
      const schedule=()=>{
        timer=null;if(signal.aborted)return;
        draining=tick(signal).catch(error=>log({event:'workspace_worker_poll_failed',correlation_id:null,
          internal_failure_code:code(error),failure_stage:'workspace_runtime_poll'}))
          .finally(()=>{if(!signal.aborted)timer=timerApi.set(schedule,1000);});
      };
      timer=timerApi.set(schedule,0);
      log({event:'workspace_worker_ready',correlation_id:null,concurrency_per_process:1,replay_after_dispatch:false,apply_automatic:false,
        schema_status:schema.status,concurrency_verified:schema.concurrency_verified});
    }catch(error){
      ready=false;controller.abort();if(stopping===controller)stopping=null;
      log({event:'workspace_worker_start_failed',correlation_id:null,internal_failure_code:code(error),failure_stage:'workspace_runtime_readiness'});
      throw new AppError('Workspace dependencies are unavailable.',503,code(error));
    }
  })();
  try{await starting;}finally{starting=null;}
}
async function stopLessonAuthorWorkspaceWorker(){
  if(stopInProgress)return stopInProgress;
  ready=false;stopping?.abort();if(timer)timerApi.clear(timer);
  stopInProgress=(async()=>{
    try{await starting;}catch{/* start already reports safe readiness failure */}
    await draining;timer=null;draining=null;stopping=null;
  })();
  try{await stopInProgress;}finally{stopInProgress=null;}
}
return {createLessonAuthorWorkspace,isLessonAuthorWorkspaceReady,startLessonAuthorWorkspaceWorker,stopLessonAuthorWorkspaceWorker};
}

// Lazy service imports keep chat↔durable composition cycles out of module
// initialization, and allow offline tests to import the factory without env/IO.
let production:ReturnType<typeof createWorkspaceRuntime>|null=null;
let loading:Promise<ReturnType<typeof createWorkspaceRuntime>>|null=null;
async function productionRuntime(){
  if(production)return production;
  if(!loading)loading=(async()=>{
    const [database,configuration,errors,chat,durable,accounting,rag,quota]=await Promise.all([
      import('../../config/database.js'),import('../../config/env.js'),import('../../middleware/error-handler.js'),
      import('./chat.service.js'),import('./lesson-author-durable-blueprint.service.js'),
      import('./lesson-author-workspace-accounting.service.js'),import('./ai-rag-client.service.js'),import('./ai-token-quota.service.js'),
    ]);
    production=createWorkspaceRuntime({query:database.query,transaction:work=>database.withDatabaseTransaction(work),
      env:configuration.env,AppError:errors.AppError,prepareDurableBlueprint:chat.prepareDurableBlueprint,
      prepareWorkspaceContentRuntime:chat.prepareWorkspaceContentRuntime,normalizeLessonAuthorProposal:chat.normalizeLessonAuthorProposal,
      withLessonAuthorConversationLock:chat.withLessonAuthorConversationLock,durableBlueprintRepository:durable.durableBlueprintRepository,
      isDurableBlueprintWorkerReady:durable.isDurableBlueprintWorkerReady,workspaceQuotaAccounting:accounting.workspaceQuotaAccounting,
      generateRagLessonAuthorCheckpoint:rag.generateRagLessonAuthorCheckpoint,reserveTenantAiTokens:quota.reserveTenantAiTokens,
      report:event=>console.info('[LessonAuthorWorkspace]',JSON.stringify(event))});
    return production;
  })().catch(error=>{loading=null;throw error;});
  return loading;
}
export function isLessonAuthorWorkspaceReady(){return production?.isLessonAuthorWorkspaceReady()??false;}
export async function createLessonAuthorWorkspace(...args:Parameters<ReturnType<typeof createWorkspaceRuntime>['createLessonAuthorWorkspace']>){
  return(await productionRuntime()).createLessonAuthorWorkspace(...args);
}
export async function startLessonAuthorWorkspaceWorker(){return(await productionRuntime()).startLessonAuthorWorkspaceWorker();}
export async function stopLessonAuthorWorkspaceWorker(){
  // Do not initialize production services just to stop an unstarted worker.
  const runtime=production??(loading?await loading:null);await runtime?.stopLessonAuthorWorkspaceWorker();
}
