// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { lessonAuthorSourceSnapshotHash as createLessonAuthorBlueprintSourceSnapshotHash } from '../../lesson-author-source-snapshot.logic.js';
import { resolveLessonAuthorDraftLocale } from '../../lesson-author-intent.logic.js';
import { createHash, randomUUID } from 'crypto';
import { query } from '../../../../config/database.js';
import { generationSnapshotHash } from '../../lesson-author-generation-job.logic.js';
import {
  chapterCheckpointRepository,
  assertChapterCheckpointReady,
  logChapterCheckpoint,
} from '../../lesson-author-chapter-runtime.service.js';
import {
  ChapterCheckpointError,
  assertChapterSnapshot,
  type ChapterUnitPayload,
  type ChapterCheckpointOwner,
} from '../../lesson-author-chapter-checkpoint.logic.js';
import {
  runChapterCheckpoint,
  ChapterWorkflowTimeout,
  chapterExternalFailureCode,
  chapterFailureMessage,
  type ChapterUsageLedger,
} from '../../lesson-author-chapter-runner.logic.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { type LessonAuthorProposal } from '../../../course-authoring/course-authoring.service.js';
import { getTenantAllowedCourseComponentTypeSet } from '../../../tenants/tenant-course-components.service.js';
import {
  isCourseComponentType,
  type CourseComponentType,
} from '../../../tenants/tenant-course-components.constants.js';
import { getTenantAiRuntimeSettings } from '../../ai-settings.service.js';
import {
  finalizeTenantAiTokens,
  releaseTenantAiTokenReservation,
  reserveTenantAiTokens,
} from '../../ai-token-quota.service.js';
import {
  generateRagLessonAuthorCheckpoint,
  RagServiceError,
  type RagLessonAuthorRequest,
} from '../../ai-rag-client.service.js';
import {
  assertLessonAuthorProposalComponentsValid,
  AI_COMPONENT_REGISTRY,
} from '../../lesson-author-component-registry.logic.js';
import { assertLessonAuthorPedagogicalQuality } from '../../lesson-author-pedagogical-validator.logic.js';
import { HISTORY_CONTEXT_LIMIT, HISTORY_MESSAGE_MAX_CHARS } from '../../chat.constants.js';
import type { ConversationContext, ChatStreamOptions, ChatStreamSideEvent } from '../../chat.types.js';
import {
  loadConversationContext,
  isValidUUID,
  getActiveKbAssignmentFresh,
  markRateLimit,
} from '../../chat-turn-runtime.service.js';
import { buildAiTurnTokenBudget, grantedOutputTokenLimit, toRagChatHistory } from '../../chat-turn.logic.js';
import { MAX_PROPOSAL_UNITS, MAX_PROPOSAL_LESSONS } from './constants.js';
import { createLessonAuthorJob } from './job-store.service.js';
import { assertDurableBlueprintActor } from './durable-blueprint.service.js';
import type { BlueprintDraftContext, LessonAuthorOutlineMention } from './types.js';
import {
  validateLessonAuthorOutlineMentions,
  getDraftCourseOutlineForPrompt,
  buildCurrentTurnText,
  formatSourceDocumentsForPrompt,
  toSourceDocumentMetadata,
  toRagSourceDocuments,
  formatOutlineMentionsForPrompt,
} from './context.service.js';
import {
  validateLessonAuthorEditorContext,
  getOutlineMentionContextRows,
  formatMentionContextRowsForPrompt,
  buildTargetLockedProposalInstruction,
} from './targets.service.js';
import { getLessonAuthorOutputSchemaHint } from './generation-schema.logic.js';
import { normalizeLessonAuthorProposal } from './proposal-normalize.logic.js';
import { formatProposalPreview, toLessonAuthorDisplayProposal } from './preview.logic.js';
import {
  loadLessonAuthorBlueprintForDraft,
  blueprintDraftArchitecture,
  formatBlueprintDraftContext,
  lockProposalToBlueprintChapter,
} from './blueprint-store.service.js';

/** Owned status is read-only. Expired attempts are ended by maintenance, not GET. */
export async function getChapterCheckpointStatus(conversationId: string, userId: string, tenantId: string, draftId?: string) {
  assertChapterCheckpointReady();
  await assertDurableBlueprintActor(userId,tenantId);
  const ctx = await loadConversationContext(conversationId,userId,tenantId,'lesson_author');
  const owner: ChapterCheckpointOwner = {conversationId,userId,tenantId,courseId:ctx.courseId!};
  const row = await query<{id:string}>(`SELECT id FROM lesson_author_chapter_drafts WHERE tenant_id=$1
    AND conversation_id=$2 AND requested_by=$3 AND course_id=$4 AND ($5::uuid IS NULL OR id=$5)
    ORDER BY created_at DESC,id DESC LIMIT 1`,[tenantId,conversationId,userId,ctx.courseId,draftId ?? null]);
  return row.rows[0] ? chapterCheckpointRepository.status(owner,row.rows[0].id) : null;
}

/** Called before legacy token reservation, under the existing conversation lock. */
export async function executeChapterCheckpoint(ctx: ConversationContext, userId: string, content: string,
  options: ChatStreamOptions, initialContext: BlueprintDraftContext | null,
  onChunk: (text:string)=>void, onDone: ()=>void, onSideEvent?: (event:ChatStreamSideEvent)=>void) {
  assertChapterCheckpointReady();
  await assertDurableBlueprintActor(userId,ctx.tenantId);
  // A resume cannot use its stored snapshot to bypass validation of a supplied
  // current editor context. Neither current nor stored context grants ownership.
  await validateLessonAuthorEditorContext(ctx,options.editorContext);
  await validateLessonAuthorOutlineMentions(ctx,options.outlineMentions ?? []);
  const key = options.chapterCheckpointKey;
  if (!key || !isValidUUID(key)) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
  const owner = {tenantId:ctx.tenantId,conversationId:ctx.conversationId,userId,courseId:ctx.courseId!};
  let originalContent = content;
  let originalOptions = options;
  let historyBoundary: string | null = null;
  let context = initialContext;
  const priorId = options.chapterResume?.draftId ?? (await query<{id:string}>(`SELECT id FROM lesson_author_chapter_drafts
    WHERE tenant_id=$1 AND conversation_id=$2 AND requested_by=$3 AND idempotency_key=$4`,
  [ctx.tenantId,ctx.conversationId,userId,key])).rows[0]?.id;
  const prior = priorId ? await chapterCheckpointRepository.load(owner,priorId) : null;
  if (prior) {
    const first = prior.attempts[0];
    if (!first) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    const message = await query<{content:string;metadata:Record<string,unknown>}>(`SELECT content,metadata FROM chat_messages
      WHERE id=$1 AND conversation_id=$2 AND role='user'`,[first.user_message_id,ctx.conversationId]);
    if (!message.rows[0]) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
    originalContent=message.rows[0].content;
    if (!options.chapterResume && content!==originalContent) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
    const metadata=message.rows[0].metadata;
    originalOptions={...options,blueprintId:prior.draft.blueprint_id,blueprintChapterIndex:prior.draft.chapter_index,
      locale:prior.draft.locale as 'vi'|'en',editorContext:metadata.editor_context,
      outlineMentions:Array.isArray(metadata.outline_mentions) ? metadata.outline_mentions as LessonAuthorOutlineMention[]:[]};
    historyBoundary=String(first.user_message_id);
    // Idempotent completed/ended POST never creates a new reservation or AI call.
    const repeated=prior.attempts.find(a=>a.idempotency_key===key);
    if (repeated) {
      if ((repeated.previous_attempt_id ?? null)!==(options.chapterResume?.previousAttemptId ?? null)) {
        throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED');
      }
      const status=await chapterCheckpointRepository.status(owner,prior.draft.id);
      onSideEvent?.({type:'chapter_checkpoint',checkpoint:status});
      onDone(); return;
    }
    context=null;
  } else if (options.chapterResume) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_NOT_FOUND');
  const freshKb=await getActiveKbAssignmentFresh(ctx.tenantId);
  if (!freshKb) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
  ctx.botKbId=freshKb.kb_id;
  const settings=await getTenantAiRuntimeSettings(ctx.tenantId);
  if (settings.activeEngine!=='self_built_rag' || !settings.hasGoogleAiStudioKey) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
  }
  const editor=await validateLessonAuthorEditorContext(ctx,originalOptions.editorContext);
  const mentions=await validateLessonAuthorOutlineMentions(ctx,originalOptions.outlineMentions ?? []);
  if (!context) context=await loadLessonAuthorBlueprintForDraft(ctx,originalOptions.blueprintId!,
    originalOptions.blueprintChapterIndex ?? 0,false,originalOptions.locale ?? 'vi');
  if (context.blueprint.architecture_contract_version!==5) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
  const approved=context;
  const locale=resolveLessonAuthorDraftLocale(originalContent,originalOptions.locale ?? 'vi',approved.outputLocale);
  const course=await getDraftCourseOutlineForPrompt(ctx.courseId!,ctx.tenantId);
  const architecture=blueprintDraftArchitecture(approved);
  const sourceDocuments=approved.sourceDocuments;
  const allowed=await getTenantAllowedCourseComponentTypeSet(ctx.tenantId);
  for(const lesson of architecture.lessons)for(const unit of lesson.units)for(const plan of unit.component_plan){
    if(!isCourseComponentType(plan.type) || !allowed.has(plan.type) || !AI_COMPONENT_REGISTRY[plan.type].ai_generatable) {
      throw new AppError('Thành phần trong chương không được phép tạo bằng AI.',403,'CHAPTER_COMPONENT_NOT_ALLOWED');
    }
  }
  const historyRows=await query<{role:string;content:string}>(`SELECT m.role,m.content FROM chat_messages m
    WHERE m.conversation_id=$1 AND ($2::uuid IS NULL OR (m.created_at,m.id)<
      (SELECT created_at,id FROM chat_messages WHERE id=$2 AND conversation_id=$1))
    ORDER BY m.created_at DESC,m.id DESC LIMIT $3`,[ctx.conversationId,historyBoundary,HISTORY_CONTEXT_LIMIT-1]);
  const history=historyRows.rows.reverse().map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content.slice(0,HISTORY_MESSAGE_MAX_CHARS)}]}));
  const mentionRows=await getOutlineMentionContextRows(ctx,mentions);
  const mentionContext=formatMentionContextRowsForPrompt(mentionRows);
  const scope=[buildTargetLockedProposalInstruction(originalContent,mentions,mentionRows),formatBlueprintDraftContext(approved)].filter(Boolean).join('\n\n');
  const systemPrompt=`${ctx.systemPrompt}\n\nYou are an Instructional Design expert. Build rigorous learner-centered course content from the provided source material. Return only a pending proposal for approval.`;
  const budget=buildAiTurnTokenBudget({engine:'self_built_rag',operation:'lesson_author',promptParts:[ctx.systemPrompt,
    buildCurrentTurnText(originalContent,mentions,mentionContext,sourceDocuments),mentionContext,scope,
    formatSourceDocumentsForPrompt(sourceDocuments),...history.map(m=>m.parts.map(p=>p.text).join('\n'))]});
  const runtimeHash=(runtime:typeof settings,types:Set<CourseComponentType>,prompt:string)=>generationSnapshotHash({
    policy:prompt,history,model:runtime.lessonAuthorModel,embeddingModel:runtime.embeddingModel,
    dimensions:runtime.embeddingDimensions,key:runtime.apiKeyFingerprint,types:[...types].sort(),budget,version:'chapter-checkpoint-1'});
  const snapshot={request_hash:generationSnapshotHash({content:originalContent,locale,editor:editor?.context ?? {},mentions,
    course:ctx.courseId,bot:ctx.botId,kb:ctx.botKbId,blueprint:approved.id,chapter:approved.chapterIndex}),
    blueprint_hash:generationSnapshotHash(architecture),source_snapshot_hash:createLessonAuthorBlueprintSourceSnapshotHash(ctx,ctx.botKbId!,sourceDocuments),
    course_outline_hash:createHash('sha256').update(course.outline).digest('hex'),runtime_config_hash:runtimeHash(settings,allowed,ctx.systemPrompt ?? '')};
  const contracts=architecture.lessons.flatMap((lesson,lesson_index)=>lesson.units.map((unit,unit_index)=>({
    index:0,lesson_index,unit_index,contract_hash:generationSnapshotHash(unit),evidence_hash:generationSnapshotHash({
      primary:unit.source_fact_ids,supporting:unit.supporting_evidence_fact_ids,refs:unit.source_refs,blocks:unit.learning_blocks})
  }))).map((unit,index)=>({...unit,index}));
  if (contracts.length>MAX_PROPOSAL_UNITS || architecture.lessons.length>MAX_PROPOSAL_LESSONS) {
    throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
  }
  if (prior) assertChapterSnapshot(prior.draft,snapshot);
  const correlationId=options.correlationId ?? randomUUID();
  const result=await chapterCheckpointRepository.admit({...owner,...snapshot,botId:ctx.botId,kbId:ctx.botKbId!,
    blueprintId:approved.id,chapterIndex:approved.chapterIndex,idempotencyKey:key,correlationId,locale,
    model:settings.lessonAuthorModel,sourceDocumentIds:sourceDocuments.map(d=>d.document_id),unitContracts:contracts,
    resume:options.chapterResume},async (_tx,draftId,attemptId)=>{
    const remainingUnits=contracts.length-(prior?.units.length ?? 0);
    const attempts=budget.maxGenerationAttempts>1 && budget.maximumTokens>=budget.retryMinimumTokens ? budget.maxGenerationAttempts:1;
    const output=grantedOutputTokenLimit(budget,budget.maximumTokens,attempts);
    // Reserve remaining calls, not completed units. This is admission accounting,
    // not a change to provider model/output/retry settings. Never silently cap a reservation.
    const inputTokens=budget.fixedInputTokens*(remainingUnits*attempts+1);
    const embeddingTokens=budget.embeddingTokens*(remainingUnits+1);
    const outputTokens=output*Math.max(1,remainingUnits)*attempts;
    const total=inputTokens+embeddingTokens+outputTokens;
    if (!Number.isSafeInteger(total) || total>2_000_000) throw new AppError('Chương vượt ngân sách xử lý an toàn.',409,'CHAPTER_BUDGET_CAPACITY_EXCEEDED');
    const reservation=await reserveTenantAiTokens({tenantId:ctx.tenantId,userId,conversationId:ctx.conversationId,
      target:'lesson_author',engine:'self_built_rag',provider:settings.provider,model:settings.lessonAuthorModel,operation:'lesson_author',
      minimumTokens:total,maximumTokens:total,budget:{inputTokens,embeddingTokens,outputTokens,maxOutputTokens:output,
        metadata:{durable_generation:true,chapter_draft_id:draftId,chapter_attempt_id:attemptId,budget_version:3,
          generation_correlation_id:correlationId,remaining_unit_count:remainingUnits}}});
    const saved=await query<{id:string}>(`INSERT INTO chat_messages(conversation_id,role,content,metadata)
      VALUES ($1,'user',$2,$3) RETURNING id`,[ctx.conversationId,content,{locale,correlation_id:correlationId,
      chapter_draft_id:draftId,chapter_attempt_id:attemptId,lesson_author_blueprint_id:approved.id,
      ...(options.lessonAuthorAction ? { lesson_author_action: options.lessonAuthorAction } : {}),
      lesson_author_blueprint_chapter_index:approved.chapterIndex,outline_mentions:mentions,
      ...(editor?{editor_context:editor.context}:{}),source_documents:sourceDocuments.map(toSourceDocumentMetadata)}]);
    await query('UPDATE chat_conversations SET updated_at=now() WHERE id=$1 AND tenant_id=$2',[ctx.conversationId,ctx.tenantId]);
    return {userMessageId:saved.rows[0].id,reservationId:reservation.id,maxOutputTokens:output,maxAttempts:attempts};
  });
  markRateLimit(userId);
  const lease={...owner,draftId:result.draft.id,attemptId:result.attempt.id,leaseToken:result.attempt.lease_token};
  const sendStatus=async()=>onSideEvent?.({type:'chapter_checkpoint',checkpoint:await chapterCheckpointRepository.status(owner,result.draft.id)});
  await sendStatus();
  if (!result.created) {onDone();return;}
  const revalidate=async()=>{
    await assertDurableBlueprintActor(userId,ctx.tenantId);
    const currentCtx=await loadConversationContext(ctx.conversationId,userId,ctx.tenantId,'lesson_author');
    const kb=await getActiveKbAssignmentFresh(ctx.tenantId);
    if (currentCtx.courseId!==ctx.courseId || currentCtx.botId!==ctx.botId || kb?.kb_id!==ctx.botKbId) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
    currentCtx.botKbId=kb.kb_id;
    await validateLessonAuthorEditorContext(currentCtx,originalOptions.editorContext);
    await validateLessonAuthorOutlineMentions(currentCtx,mentions);
    const current=await loadLessonAuthorBlueprintForDraft(currentCtx,approved.id,approved.chapterIndex,false,locale);
    const outline=await getDraftCourseOutlineForPrompt(ctx.courseId!,ctx.tenantId);
    const runtime=await getTenantAiRuntimeSettings(ctx.tenantId);
    if (runtime.activeEngine!=='self_built_rag') throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
    assertChapterSnapshot(result.draft,{...snapshot,blueprint_hash:generationSnapshotHash(blueprintDraftArchitecture(current)),
      source_snapshot_hash:createLessonAuthorBlueprintSourceSnapshotHash(currentCtx,kb.kb_id,current.sourceDocuments),
      course_outline_hash:createHash('sha256').update(outline.outline).digest('hex'),
      runtime_config_hash:runtimeHash(runtime,await getTenantAllowedCourseComponentTypeSet(ctx.tenantId),currentCtx.systemPrompt ?? '')});
    const reservation=await query(`SELECT id FROM ai_token_reservations WHERE id=$1 AND tenant_id=$2 AND user_id=$3
      AND conversation_id=$4 AND model=$5 AND target='lesson_author' AND engine='self_built_rag' AND operation='lesson_author'
      AND status='reserved' AND expires_at>clock_timestamp() AND expires_at>=$6
      AND max_output_tokens=$7 AND budget_metadata->>'durable_generation'='true'
      AND budget_metadata->>'chapter_draft_id'=$8 AND budget_metadata->>'chapter_attempt_id'=$9`,
    [result.attempt.ai_reservation_id,ctx.tenantId,userId,ctx.conversationId,settings.lessonAuthorModel,
      result.attempt.deadline_at,result.attempt.max_output_tokens,result.draft.id,result.attempt.id]);
    if(!reservation.rows.length)throw new AppError('Ngân sách của lần soạn chương không còn hợp lệ.',409,'CHAPTER_RESERVATION_CHANGED');
  };
  const validateUnit=async(payload:ChapterUnitPayload,index:number)=>{
    const contract=contracts[index];
    if (!contract) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    const chapter=approved.blueprint.chapters[approved.chapterIndex];
    const lesson=chapter.lessons[contract.lesson_index];
    const expected=lesson.units[contract.unit_index];
    const mini={...approved,chapterIndex:0,blueprint:{...approved.blueprint,chapters:[{...chapter,lessons:[{...lesson,units:[expected]}]}]}};
    const normalized=normalizeLessonAuthorProposal({chapters:[{title:chapter.title,lessons:[{title:lesson.title,units:[payload]}]}]});
    const locked=lockProposalToBlueprintChapter(normalized,mini);
    assertLessonAuthorProposalComponentsValid(locked,await getTenantAllowedCourseComponentTypeSet(ctx.tenantId));
  };
  const request: RagLessonAuthorRequest & {correlation_id:string}={correlation_id:result.attempt.correlation_id,tenant_id:ctx.tenantId,kb_id:ctx.botKbId!,
    conversation_id:ctx.conversationId,target:'lesson_author',model:settings.lessonAuthorModel,
    max_output_tokens:Number(result.attempt.max_output_tokens),max_attempts:Number(result.attempt.max_provider_attempts),
    embedding_model:settings.embeddingModel,embedding_dimensions:settings.embeddingDimensions,system_prompt:systemPrompt,
    user_message:originalContent,history:toRagChatHistory(history),source_documents:toRagSourceDocuments(sourceDocuments),
    course_context:course.outline,outline_context:[mentions.length?formatOutlineMentionsForPrompt(mentions.slice(0,1)):'',mentionContext].filter(Boolean).join('\n\n'),
    target_scope_instruction:scope,blueprint_architecture:architecture,output_schema_hint:getLessonAuthorOutputSchemaHint(),
    operation:'create',target_type:'chapter',generation_mode:'staged',locale};
  const account=async(ledger:ChapterUsageLedger,hold:boolean)=>{
    if (hold || !ledger.complete) {
      await query(`UPDATE ai_token_reservations SET budget_metadata=budget_metadata || $3::jsonb
        WHERE id=$1 AND tenant_id=$2 AND status='reserved'`,[result.attempt.ai_reservation_id,ctx.tenantId,JSON.stringify({
          checkpoint_accounting:{state:'pending_reconciliation',usage_source:ledger.complete?'provider':'mixed_or_unavailable',
            observed_input_tokens:ledger.inputTokens,observed_output_tokens:ledger.outputTokens,
            observed_embedding_tokens:ledger.embeddingTokens,observed_total_tokens:ledger.totalTokens}})]);
      return 'pending_reconciliation' as const;
    }
    if (!ledger.dispatched) await releaseTenantAiTokenReservation(String(result.attempt.ai_reservation_id),ctx.tenantId);
    else await finalizeTenantAiTokens({reservationId:String(result.attempt.ai_reservation_id),tenantId:ctx.tenantId,
      usage:ledger,embeddingModel:settings.embeddingModel,source:{service:'self_built_rag',usage_source:'provider'},
      metadata:{chapter_draft_id:result.draft.id,chapter_attempt_id:result.attempt.id}});
    return 'settled' as const;
  };
  let finishedProposal:LessonAuthorProposal|null=null;
  let finishedJob:string|null=null;
  let reply='';
  let replyCommitted=false;
  const outcome=await runChapterCheckpoint(result.draft,result.attempt,result.units,{
    revalidate,validateUnit,renew:()=>chapterCheckpointRepository.renew(lease),
    markDispatched:index=>chapterCheckpointRepository.markDispatched(lease,snapshot,index),
    markFinalValidation:()=>chapterCheckpointRepository.markFinalValidation(lease,snapshot),
    generate:async(index,signal,remainingMs)=>{
      const response=await generateRagLessonAuthorCheckpoint({...request,checkpoint_version:1,checkpoint_action:'generate_unit',
        checkpoint_unit_index:index,remaining_workflow_budget_ms:remainingMs},{signal,timeoutMs:remainingMs});
      if (response.status!=='unit_ready') throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
      return response;
    },
    commit:(index,unit)=>chapterCheckpointRepository.commitUnit(lease,snapshot,index,unit,'node-chapter-unit-1',payload=>validateUnit(payload,index)),
    validateChapter:async(units,signal,remainingMs)=>{
      const response=await generateRagLessonAuthorCheckpoint({...request,checkpoint_version:1,checkpoint_action:'validate_chapter',
        checkpoint_units:units,remaining_workflow_budget_ms:remainingMs},{signal,timeoutMs:remainingMs});
      if (response.status!=='ready') throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
      return response;
    },
    publish:async(response,ledger)=>{
      finishedJob=await chapterCheckpointRepository.publish(lease,snapshot,async()=>{
        await revalidate();
        const proposal=lockProposalToBlueprintChapter(normalizeLessonAuthorProposal(response.proposal),approved);
        assertLessonAuthorProposalComponentsValid(proposal,await getTenantAllowedCourseComponentTypeSet(ctx.tenantId));
        const quality=assertLessonAuthorPedagogicalQuality({proposal,blueprint_chapter:approved.blueprint.chapters[approved.chapterIndex]});
        const evidence=response.retrieval;
        finishedProposal={...proposal,source_evidence:{...(proposal.source_evidence ?? {}),
          status:evidence.source_coverage_status ?? 'not_applicable',
          required_count:evidence.source_coverage_required_count ?? 0,
          covered_count:evidence.source_coverage_covered_count ?? 0,
          missing_fact_ids:evidence.source_coverage_missing_fact_ids ?? [],
          hard_locked:evidence.target_source_scope_hard_locked === true,
          pages:evidence.target_source_scope_pages ?? [],
          expected_pages:evidence.target_source_scope_expected_pages ?? [],pedagogical_quality:{
          status:quality.status,scores:quality.scores,duplicate_count:quality.duplicate_count,finding_codes:quality.findings.map(f=>f.code).slice(0,24)}}};
        const jobId=await createLessonAuthorJob(ctx,userId,originalContent,ctx.botKbId,finishedProposal,sourceDocuments,approved.id);
        reply=formatProposalPreview(finishedProposal,approved.chapterIndex,locale);
        await query(`INSERT INTO chat_messages(conversation_id,role,content,metadata) VALUES ($1,'assistant',$2,$3)`,
        [ctx.conversationId,reply,{kind:'lesson_author_proposal',locale,lesson_author_job_id:jobId,lesson_author_job_status:'proposed',
          lesson_author_blueprint_id:approved.id,lesson_author_blueprint_chapter_index:approved.chapterIndex,
          chapter_draft_id:result.draft.id,chapter_attempt_id:result.attempt.id,correlation_id:result.attempt.correlation_id,
          source_documents:sourceDocuments.map(toSourceDocumentMetadata)}]);
        return {jobId,accounting:await account(ledger,false)};
      });
      replyCommitted=true;
      logChapterCheckpoint({event:'chapter_proposal_published',correlation_id:result.attempt.correlation_id,
        conversation_id:ctx.conversationId,draft_id:result.draft.id,attempt_id:result.attempt.id,job_id:finishedJob});
    },
    interrupt:async(failure,timeout,ledger)=>{
      finishedProposal=null;finishedJob=null;
      replyCommitted=false;
      await chapterCheckpointRepository.interrupt(lease,timeout?'timed_out':'failed',failure,async(_tx,_attempt,hold)=>{
        reply=chapterFailureMessage(locale,timeout,failure.externalCode);
        await query(`INSERT INTO chat_messages(conversation_id,role,content,metadata) VALUES ($1,'assistant',$2,$3)`,
        [ctx.conversationId,reply,{kind:timeout?'lesson_author_chapter_interrupted':'lesson_author_generation_failed',locale,
          chapter_draft_id:result.draft.id,chapter_attempt_id:result.attempt.id,correlation_id:result.attempt.correlation_id,
          lesson_author_blueprint_id:approved.id,lesson_author_blueprint_chapter_index:approved.chapterIndex}]);
        return account(ledger,hold);
      });
      replyCommitted=true;
    },
    classify:error=>{
      const candidate=error instanceof RagServiceError?error.diagnostics.internal_failure_code:
        error instanceof ChapterCheckpointError || error instanceof ChapterWorkflowTimeout?error.code:undefined;
      const code=typeof candidate==='string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate)?candidate:'CHAPTER_GENERATION_FAILED';
      const timeout=error instanceof ChapterWorkflowTimeout || /TIMEOUT/.test(code)
        || (error instanceof RagServiceError && /TIMEOUT/.test(error.code ?? ''));
      return {stage:error instanceof RagServiceError?'python_chapter_checkpoint':'node_chapter_checkpoint',internalCode:code,
        externalCode:chapterExternalFailureCode(error instanceof RagServiceError?error.code:undefined,timeout),timeout,leaseLost:code==='CHAPTER_CHECKPOINT_LEASE_LOST'};
    },report:logChapterCheckpoint,
  });
  if (replyCommitted && reply) onChunk(reply);
  if (outcome==='ready' && finishedProposal && finishedJob) onSideEvent?.({type:'proposal',job_id:finishedJob,proposal:toLessonAuthorDisplayProposal(finishedProposal,locale)});
  await sendStatus();
  onDone();
}
