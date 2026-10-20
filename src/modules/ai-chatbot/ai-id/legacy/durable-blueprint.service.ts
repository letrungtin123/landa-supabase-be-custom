// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { projectBlueprintDraftArchitecture } from '../v1/lesson-author-blueprint-draft-architecture.logic.js';
import { lessonAuthorSourceSnapshotHash as createLessonAuthorBlueprintSourceSnapshotHash } from '../shared/lesson-author-source-snapshot.logic.js';
import { composeV5BlueprintPolicy } from '../v1/lesson-author-prompt-policy.logic.js';
import { createComponentCapabilities, readComponentCapabilities } from '../content/lesson-author-capabilities.logic.js';
import { createHash } from 'crypto';
import { query } from '../../../../config/database.js';
import {
  GenerationJobError,
  generationSnapshotHash,
  hasCompleteGenerationUsage,
  type GenerationJobRow,
} from '../shared/lesson-author-generation-job.logic.js';
import type { PreparedGenerationJob } from '../shared/lesson-author-generation-job.repository.js';
import type { GenerationAdmissionStage } from '../v1/lesson-author-generation-admission.logic.js';
import { env } from '../../../../config/env.js';
import { getRedisClient } from '../../../../config/redis.js';
import { type DistributedStreamLock } from '../../chat/chat-stream-lock.js';
import { AppError } from '../../../../middleware/error-handler.js';
import type { UserRole } from '../../../../types/index.js';
import { getTenantAllowedCourseComponentTypeSet } from '../../../tenants/tenant-course-components.service.js';
import { isCourseComponentType } from '../../../tenants/tenant-course-components.constants.js';
import { getTenantAiRuntimeSettings } from '../../ai-platform/ai-settings.service.js';
import { finalizeTenantAiTokens, normalizeAiUsage, reserveTenantAiTokens } from '../../ai-platform/ai-token-quota.service.js';
import { generateRagLessonAuthorBlueprint, type RagLessonAuthorRequest } from '../../ai-platform/ai-rag-client.service.js';
import { buildLessonAuthorCreationContext, resolveLessonAuthorOutputLocale } from '../shared/lesson-author-intent.logic.js';
import {
  buildNormalizedLessonAuthorCommand,
  isSimpleDeterministicLessonAuthorCommand,
} from '../shared/lesson-author-command.logic.js';
import { AI_COMPONENT_REGISTRY } from '../content/lesson-author-component-registry.logic.js';
import {
  acceptAndPersistLessonAuthorBlueprint,
  blueprintBoundaryCounts,
} from '../v1/lesson-author-blueprint-acceptance.logic.js';
import { runStoredInputFilter } from '../../ai-platform/input-filter/input-filter.service.js';
import { withLaunchBriefIdentity } from '../contracts/lesson-author-launch-brief.logic.js';
import { hasAiIdCoursePermission } from '../shared/lesson-author-ai-id-access.service.js';
import {
  MAX_USER_MESSAGE_LENGTH,
  HISTORY_CONTEXT_LIMIT,
  HISTORY_MESSAGE_MAX_CHARS,
  RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS,
  LESSON_AUTHOR_TARGET,
} from '../../chat/chat.constants.js';
import type { ChatStreamOptions } from '../../chat/chat.types.js';
import {
  streamLocks,
  acquireDistributedStreamLock,
  assertChatConversationOwner,
  checkRateLimit,
  loadConversationContext,
  getActiveKbAssignmentFresh,
  markRateLimit,
  logLessonAuthorFlow,
} from '../../chat/chat-turn-runtime.service.js';
import { buildAiTurnTokenBudget, grantedOutputTokenLimit, toRagChatHistory } from '../../chat/chat-turn.logic.js';
import { asRecord } from './component-normalize.logic.js';
import type { LessonAuthorBlueprint, BlueprintDraftContext } from './types.js';
import {
  validateLessonAuthorOutlineMentions,
  validateLessonAuthorSourceDocuments,
  shouldCarryForwardLessonAuthorSourceDocuments,
  getLatestConversationSourceDocuments,
  getDraftCourseOutlineForPrompt,
  formatSourceDocumentsForPrompt,
  buildCurrentTurnText,
  toSourceDocumentMetadata,
  toRagSourceDocuments,
  withAuthoritativeCourseTitle,
} from './context.service.js';
import {
  validateLessonAuthorEditorContext,
  resolveLessonAuthorOperationPlan,
  getOutlineMentionContextRows,
  formatMentionContextRowsForPrompt,
  buildTargetLockedProposalInstruction,
} from './targets.service.js';
import { getLessonAuthorBlueprintSchemaHint, getLessonAuthorOutputSchemaHint } from './generation-schema.logic.js';
import {
  normalizeLessonAuthorBlueprint,
  buildLessonAuthorBlueprintQualityReport,
} from './blueprint-normalize.logic.js';
import { formatBlueprintPreview } from './preview.logic.js';
import { classifyLessonAuthorIntentV2 } from './intent-classifier.logic.js';
import { createLessonAuthorBlueprint, formatBlueprintDraftContext } from './blueprint-store.service.js';

/**
 * Who may take the conversation lock, checked BEFORE the lock (as the chat
 * stream does since a9eaef3): a conversation the caller may not use gets the
 * same answer whether or not it is busy, never "already active".
 * - `{ userId, tenantId }`: the caller's own lesson-author conversation
 *   (assertChatConversationOwner: the 404 of a missing conversation);
 * - `{ check }`: another rule (session deletion: who may manage the session).
 */
export type LessonAuthorConversationAccess =
  | { userId: string; tenantId: string }
  | { check: () => Promise<void> };

/** Short admission lock shared with old chat; never held during queued generation. */
export async function withLessonAuthorConversationLock<T>(
  conversationId: string, work: () => Promise<T>, access: LessonAuthorConversationAccess,
): Promise<T> {
  if ('check' in access) await access.check();
  else await assertChatConversationOwner(conversationId, access.userId, access.tenantId, LESSON_AUTHOR_TARGET);
  if (streamLocks.has(conversationId)) throw new GenerationJobError('GENERATION_ALREADY_ACTIVE');
  streamLocks.add(conversationId);
  let lock: DistributedStreamLock | null = null;
  try {
    lock = await acquireDistributedStreamLock(conversationId, true);
    if (!lock) throw new GenerationJobError('GENERATION_ALREADY_ACTIVE');
    return await work();
  } finally { streamLocks.delete(conversationId); await lock?.release(); }
}

/** Fresh worker authorization: no JWT/role or provider secret is persisted in jobs.
 * Roles: AI_ID_AUTHOR_ROLES (lesson-author-ai-id-access.logic.ts), re-read from the database. */
export async function assertDurableBlueprintActor(userId: string, tenantId: string): Promise<void> {
  const result = await query<{ role: UserRole }>(`SELECT u.role FROM users u
    JOIN tenants t ON t.id=$2 AND t.is_active=true
    WHERE u.id=$1 AND u.is_active=true AND u.role IN ('staff','superuser','superadmin')
      AND (u.role='superadmin' OR u.tenant_id=$2 OR (u.role='superuser' AND EXISTS
        (SELECT 1 FROM user_tenants ut WHERE ut.user_id=u.id AND ut.tenant_id=$2)))`, [userId, tenantId]);
  const role = result.rows[0]?.role;
  if (!role || !await hasAiIdCoursePermission({ id: userId, tenantId, role })) {
    throw new AppError('Không có quyền tạo khóa học.', 403, 'GENERATION_FORBIDDEN');
  }
}

/** Reuses the existing source/editor/routing/budget/acceptance functions. No provider call or write here. */
export async function prepareDurableBlueprint(
  conversationId: string, userId: string, tenantId: string, content: string,
  options: ChatStreamOptions,
  replay?: { source_document_ids: string[]; user_message_id?: string | null },
  admissionStage: (stage: GenerationAdmissionStage) => void = () => {},
) {
  admissionStage('actor_authorization');
  await assertDurableBlueprintActor(userId, tenantId);
  if (!replay) await checkRateLimit(userId);
  admissionStage('conversation_context');
  const ctx = await loadConversationContext(conversationId, userId, tenantId, 'lesson_author');
  if (options.courseId && options.courseId !== ctx.courseId) throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  const freshKb = await getActiveKbAssignmentFresh(tenantId);
  if (!freshKb) throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  ctx.botKbId = freshKb.kb_id;
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > MAX_USER_MESSAGE_LENGTH) throw new AppError('Tin nhắn không hợp lệ.', 400, 'GENERATION_INPUT_INVALID');
  admissionStage('runtime_settings');
  const settings = await getTenantAiRuntimeSettings(tenantId);
  if (settings.activeEngine !== 'self_built_rag' || options.blueprintId || options.mode === 'draft_lesson') return null;
  admissionStage('editor_context');
  const mentions = await validateLessonAuthorOutlineMentions(ctx, options.outlineMentions ?? []);
  const editor = await validateLessonAuthorEditorContext(ctx, options.editorContext);
  admissionStage('intent_routing');
  const creationContext = buildLessonAuthorCreationContext(options, editor?.context);
  const classified = classifyLessonAuthorIntentV2(trimmed, mentions, options.mode ?? 'auto', mentions.length ? 'current' : undefined, creationContext);
  if (classified.intent !== 'course_blueprint') return null;
  const plan = await resolveLessonAuthorOperationPlan(ctx, classified.operationPlan, trimmed, mentions.slice(0, 1));
  const command = buildNormalizedLessonAuthorCommand({ plan, userInstruction: trimmed,
    sourceDocumentIds: (options.sourceDocuments ?? []).flatMap(document => document.document_id ? [document.document_id] : []) });
  if (plan.operation !== 'course_blueprint' || isSimpleDeterministicLessonAuthorCommand(command)) return null;
  if (!settings.hasGoogleAiStudioKey) throw new AppError('Chưa cấu hình API key AI.', 400, 'AI_PROVIDER_KEY_MISSING');
  admissionStage('source_validation');
  let sources = await validateLessonAuthorSourceDocuments(ctx, ctx.botKbId,
    options.sourceDocuments?.length ? options.sourceDocuments : replay?.source_document_ids.map(document_id => ({ document_id })) ?? [],
    { requireGeminiMapping: false });
  if (!sources.length && !replay && shouldCarryForwardLessonAuthorSourceDocuments(trimmed)) {
    const carried = await getLatestConversationSourceDocuments(ctx);
    sources = await validateLessonAuthorSourceDocuments(ctx, ctx.botKbId, carried, { requireGeminiMapping: false });
  }
  if (!sources.length) throw new AppError('Vui lòng chọn tài liệu nguồn đã học.', 400, 'SOURCE_SCOPE_INCOMPLETE');
  admissionStage('course_context');
  const course = await getDraftCourseOutlineForPrompt(ctx.courseId!, tenantId);
  const allowed = await getTenantAllowedCourseComponentTypeSet(tenantId);
  const capabilities = createComponentCapabilities(allowed);
  const mentionRows = await getOutlineMentionContextRows(ctx, mentions);
  const mentionContext = formatMentionContextRowsForPrompt(mentionRows);
  const targetScope = buildTargetLockedProposalInstruction(trimmed, mentions, mentionRows);
  const sourceContext = formatSourceDocumentsForPrompt(sources);
  const currentTurn = buildCurrentTurnText(trimmed, mentions, mentionContext, sources);
  // Exclude the persisted current turn on restart, without storing prompt copies.
  admissionStage('history_context');
  const historyRows = await query<{ role: string; content: string }>(`SELECT m.role,m.content FROM chat_messages m
    WHERE m.conversation_id=$1 AND ($2::uuid IS NULL OR
      (m.created_at,m.id) < (SELECT created_at,id FROM chat_messages WHERE id=$2 AND conversation_id=$1))
    ORDER BY m.created_at DESC,m.id DESC LIMIT $3`, [conversationId, replay?.user_message_id ?? null, HISTORY_CONTEXT_LIMIT - 1]);
  const history = historyRows.rows.reverse().map(m => ({ role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content.slice(0, HISTORY_MESSAGE_MAX_CHARS) }] }));
  const locale = resolveLessonAuthorOutputLocale(trimmed, options.locale ?? 'vi');
  const policy = composeV5BlueprintPolicy(locale, ctx.systemPrompt ?? '');
  const budget = buildAiTurnTokenBudget({ engine: 'self_built_rag', operation: 'lesson_author', isCourseBlueprint: true,
    promptParts: [policy.prompt, currentTurn, mentionContext, targetScope, sourceContext,
      ...history.map(m => m.parts.map(p => p.text).join('\n'))] });
  admissionStage('snapshot_preparation');
  const hash = generationSnapshotHash;
  const identity: Omit<PreparedGenerationJob, 'idempotencyKey' | 'correlationId'> = {
    tenantId, userId, conversationId, courseId: ctx.courseId!, botId: ctx.botId, kbId: ctx.botKbId,
    // QLT-6: the same workspace operation with a different launch brief is a different request.
    requestHash: hash(withLaunchBriefIdentity({ content: trimmed, locale, editor: editor?.context ?? {}, mentions,
      sources: sources.map(s => s.document_id), course: ctx.courseId, bot: ctx.botId, kb: ctx.botKbId },
    options.launchBrief)),
    sourceSnapshotHash: createLessonAuthorBlueprintSourceSnapshotHash(ctx, ctx.botKbId, sources),
    courseOutlineHash: createHash('sha256').update(course.outline).digest('hex'),
    runtimeConfigHash: hash({ policy: policy.prompt, history, model: settings.lessonAuthorModel,
      embeddingModel: settings.embeddingModel, dimensions: settings.embeddingDimensions, capabilities, budget }),
    locale, model: settings.lessonAuthorModel, sourceDocumentIds: sources.map(s => s.document_id),
    editorContext: editor?.context ?? null,
  };
  return {
    identity,
    embeddingModel: settings.embeddingModel,
    markAccepted() { markRateLimit(userId); },
    async filterInput() {
      await checkRateLimit(userId);
      const outcome = await runStoredInputFilter({ message: trimmed, sessionId: conversationId,
        tenantId, botId: ctx.botId, rawConfig: ctx.inputFilterConfig, redisClient: getRedisClient() });
      if (outcome.blocked) throw new AppError('Yêu cầu không được bộ lọc đầu vào chấp nhận.', 400, 'GENERATION_INPUT_REJECTED');
    },
    async reserveAndCreateMessage(correlationId: string) {
      admissionStage('quota_reservation');
      if (env.AI_TOKEN_RESERVATION_SECONDS < 600) throw new AppError('Cấu hình thời hạn quota chưa phù hợp.', 503, 'GENERATION_RESERVATION_LIFETIME_INVALID');
      const reserved = await reserveTenantAiTokens({ tenantId, userId, conversationId, target: 'lesson_author',
        engine: 'self_built_rag', provider: settings.provider, model: settings.lessonAuthorModel, operation: 'lesson_author',
        minimumTokens: budget.minimumTokens, maximumTokens: budget.maximumTokens,
        budget: { inputTokens: budget.fixedInputTokens, outputTokens: budget.targetOutputTokens,
          embeddingTokens: budget.embeddingTokens, maxOutputTokens: budget.targetOutputTokens,
          metadata: { budget_version: 2, operation: 'lesson_author', engine: 'self_built_rag',
            durable_generation: true, generation_correlation_id: correlationId } } });
      const attempts = budget.maxGenerationAttempts > 1 && reserved.reservedTokens >= budget.retryMinimumTokens ? budget.maxGenerationAttempts : 1;
      admissionStage('user_message_write');
      const saved = await query<{ id: string }>(`INSERT INTO chat_messages (conversation_id,role,content,metadata)
        VALUES ($1,'user',$2,$3) RETURNING id`, [conversationId, trimmed, {
        source_documents: sources.map(toSourceDocumentMetadata), outline_mentions: mentions,
        ...(editor ? { editor_context: editor.context } : {}), locale, correlation_id: correlationId,
        ...(options.inputMode === 'voice' ? { input_mode: 'voice' } : {}),
        ...(options.lessonAuthorAction ? { lesson_author_action: options.lessonAuthorAction } : {}),
      }]);
      admissionStage('conversation_update');
      await query(`UPDATE chat_conversations SET updated_at=now(), title=CASE WHEN $3 THEN $4 ELSE title END
        WHERE id=$1 AND tenant_id=$2`, [conversationId, tenantId, ctx.messageCount === 0,
        trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '')]);
      return { userMessageId: saved.rows[0].id, reservationId: reserved.id,
        maxAttempts: attempts, maxOutputTokens: grantedOutputTokenLimit(budget, reserved.reservedTokens, attempts) };
    },
    async generate(job: GenerationJobRow, signal: AbortSignal, timeoutMs: number) {
      return generateRagLessonAuthorBlueprint({ component_capabilities: capabilities,
        correlation_id: job.correlation_id, course_id: ctx.courseId!, tenant_id: tenantId, kb_id: ctx.botKbId!,
        conversation_id: conversationId, target: 'lesson_author', model: job.model,
        max_output_tokens: Math.min(job.max_output_tokens, RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS),
        max_attempts: job.max_attempts, embedding_model: settings.embeddingModel, embedding_dimensions: settings.embeddingDimensions,
        system_prompt: policy.prompt, user_message: trimmed, history: toRagChatHistory(history),
        source_documents: toRagSourceDocuments(sources), course_context: course.outline, outline_context: mentionContext,
        blueprint_schema_hint: getLessonAuthorBlueprintSchemaHint(), locale,
      }, { signal, timeoutMs });
    },
    async persist(job: GenerationJobRow, response: Awaited<ReturnType<typeof generateRagLessonAuthorBlueprint>>) {
      const log = (event: string, metadata: Record<string, unknown>) => logLessonAuthorFlow(event, {
        ...metadata, correlation_id: job.correlation_id, conversation_id: conversationId, job_id: job.id });
      const raw = asRecord(response.blueprint);
      if (JSON.stringify(readComponentCapabilities(raw.component_capabilities)) !== JSON.stringify(capabilities)) {
        throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
      }
      const blueprint = withAuthoritativeCourseTitle(normalizeLessonAuthorBlueprint({ ...raw,
        ...(response.source_map !== undefined ? { source_map: response.source_map } : {}) }, {
        requireContentArchitecture: true, requirePhaseOneContract: true, allowedComponentTypes: allowed,
        onComponentDecision: d => log('blueprint_component_selection', { ...d }),
        onBoundary: (stage, value) => log('blueprint_contract_boundary', { stage, ...blueprintBoundaryCounts(value) }),
      }), course.courseName);
      return acceptAndPersistLessonAuthorBlueprint(blueprint, blueprint.source_map,
        d => log('blueprint_node_validation', { ...d }), async validation => {
          const report = buildLessonAuthorBlueprintQualityReport(blueprint, sources.length, response.retrieval ?? null, locale, validation);
          const blueprintId = await createLessonAuthorBlueprint(ctx, userId, trimmed, ctx.botKbId!, blueprint, report,
            course.outline, sources, 'self_built_rag', job.model, false);
          const assistant = await query<{ id: string }>(`INSERT INTO chat_messages (conversation_id,role,content,metadata)
            VALUES ($1,'assistant',$2,$3) RETURNING id`, [conversationId, formatBlueprintPreview(blueprint, report, locale), {
            lesson_author_blueprint_id: blueprintId, kind: 'lesson_author_blueprint', locale,
            lesson_author_blueprint_status: 'proposed', source_documents: sources.map(toSourceDocumentMetadata),
            generation_job_id: job.id, correlation_id: job.correlation_id,
          }]);
          if (hasCompleteGenerationUsage(response.usage)) await finalizeTenantAiTokens({ reservationId: job.ai_reservation_id!, tenantId,
            usage: normalizeAiUsage(response.usage), embeddingModel: settings.embeddingModel,
            source: { service: 'self_built_rag', operation: 'lesson_author', usage_source: 'rag_response' },
            metadata: { generation_job_id: job.id, lesson_author_blueprint_id: blueprintId } });
          else log('generation_usage_pending_reconciliation', { usage_source: 'unavailable' });
          await query('UPDATE chat_conversations SET updated_at=now() WHERE id=$1 AND tenant_id=$2', [conversationId, tenantId]);
          return { blueprintId, assistantMessageId: assistant.rows[0].id };
        });
    },
  };
}

/** New workspace path only. Reuses the existing source, prompt/schema, budget
 * and locale authorities without requiring an earlier chapter to be Applied.
 * No writes, reservation, rate-limit charge or provider call occur here.
 * Caller must load the accepted Blueprint and fresh source/actor fences from
 * its private workspace transaction; never expose this request through HTTP.
 */
export async function prepareWorkspaceContentRuntime(input: {
  tenantId: string; userId: string; conversationId: string; courseId: string;
  botId: string; kbId: string; correlationId: string; sourceSnapshotHash: string;
  sourceDocumentIds: string[]; locale: 'vi' | 'en'; blueprint: LessonAuthorBlueprint;
  chapterIndex: number; architectureMessageId: string;
}) {
  await assertDurableBlueprintActor(input.userId,input.tenantId);
  const ctx = await loadConversationContext(input.conversationId,input.userId,input.tenantId,'lesson_author');
  const kb = await getActiveKbAssignmentFresh(input.tenantId);
  if (ctx.courseId !== input.courseId || ctx.botId !== input.botId || kb?.kb_id !== input.kbId
    || input.blueprint.architecture_contract_version !== 5 || input.blueprint.content_contract_version !== 1
    || !input.blueprint.chapters[input.chapterIndex]) throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  ctx.botKbId = kb.kb_id;
  const settings = await getTenantAiRuntimeSettings(input.tenantId, { requireExisting:true });
  if (settings.activeEngine !== 'self_built_rag' || !settings.hasGoogleAiStudioKey)
    throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  const sources = await validateLessonAuthorSourceDocuments(ctx,kb.kb_id,input.sourceDocumentIds.map(document_id=>({document_id})),{requireGeminiMapping:false});
  if (sources.length !== input.sourceDocumentIds.length
    || createLessonAuthorBlueprintSourceSnapshotHash(ctx,kb.kb_id,sources) !== input.sourceSnapshotHash)
    throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  const allowed = await getTenantAllowedCourseComponentTypeSet(input.tenantId);
  const architecture = projectBlueprintDraftArchitecture(input.blueprint,input.chapterIndex);
  for (const lesson of architecture.lessons) for (const unit of lesson.units) for (const plan of unit.component_plan) {
    if (!isCourseComponentType(plan.type) || !allowed.has(plan.type) || !AI_COMPONENT_REGISTRY[plan.type].ai_generatable)
      throw new AppError('Thành phần trong chương không được phép tạo bằng AI.',403,'CHAPTER_COMPONENT_NOT_ALLOWED');
  }
  // Freeze history BEFORE the creation action. Later Save/Apply/conversation
  // messages must not change inputs or trigger regeneration of accepted units.
  const message = await query(`SELECT id FROM chat_messages WHERE id=$1 AND conversation_id=$2 AND role='user'`,
    [input.architectureMessageId,input.conversationId]);
  if (message.rows.length !== 1) throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  const historyRows = await query<{role:string;content:string}>(`SELECT m.role,m.content FROM chat_messages m
    WHERE m.conversation_id=$1 AND (m.created_at,m.id)<(SELECT created_at,id FROM chat_messages WHERE id=$2 AND conversation_id=$1)
    ORDER BY m.created_at DESC,m.id DESC LIMIT $3`,[input.conversationId,input.architectureMessageId,HISTORY_CONTEXT_LIMIT-1]);
  const history = historyRows.rows.reverse().map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content.slice(0,HISTORY_MESSAGE_MAX_CHARS)}]}));
  const chapter = input.blueprint.chapters[input.chapterIndex];
  const content = input.locale==='en' ? `Draft the approved chapter: ${chapter.title}` : `Soạn nội dung chương đã duyệt: ${chapter.title}`;
  const approved: BlueprintDraftContext = {
    id: '', blueprint: input.blueprint, chapterIndex: input.chapterIndex, outputLocale: input.locale,
    sourceDocuments: sources,
  };
  const scope = formatBlueprintDraftContext(approved);
  const systemPrompt = `${ctx.systemPrompt}\n\nYou are an Instructional Design expert. Build rigorous learner-centered course content from the provided source material. Return only a pending proposal for approval.`;
  const schema = getLessonAuthorOutputSchemaHint();
  const budget = buildAiTurnTokenBudget({engine:'self_built_rag',operation:'lesson_author',promptParts:[ctx.systemPrompt,
    buildCurrentTurnText(content,[], '',sources),scope,formatSourceDocumentsForPrompt(sources),...history.map(m=>m.parts.map(p=>p.text).join('\n'))]});
  const attempts = budget.maxGenerationAttempts>1 && budget.maximumTokens>=budget.retryMinimumTokens ? budget.maxGenerationAttempts : 1;
  const output = grantedOutputTokenLimit(budget,budget.maximumTokens,attempts);
  const runtimeHash = generationSnapshotHash({ version:'workspace-content-runtime-1',policy:systemPrompt,schema,history,
    model:settings.lessonAuthorModel,embeddingModel:settings.embeddingModel,dimensions:settings.embeddingDimensions,
    key:settings.apiKeyFingerprint,types:[...allowed].sort(),locale:input.locale });
  const request: RagLessonAuthorRequest & {correlation_id:string} = {
    correlation_id:input.correlationId,tenant_id:input.tenantId,kb_id:input.kbId,conversation_id:input.conversationId,
    target:'lesson_author',model:settings.lessonAuthorModel,max_output_tokens:output,max_attempts:attempts,
    embedding_model:settings.embeddingModel,embedding_dimensions:settings.embeddingDimensions,system_prompt:systemPrompt,
    user_message:content,history:toRagChatHistory(history),source_documents:toRagSourceDocuments(sources),
    // Approved workspace architecture is generation authority. Current course
    // draft may change through our own Apply and is not a generation dependency.
    course_context:JSON.stringify({title:input.blueprint.title,chapters:input.blueprint.chapters.map(c=>({title:c.title,objective:c.objective}))}),
    outline_context:'',target_scope_instruction:scope,blueprint_architecture:architecture,output_schema_hint:schema,
    operation:'create',target_type:'chapter',generation_mode:'staged',locale:input.locale,
  };
  return { request, runtimeHash, allowed, model:settings.lessonAuthorModel,provider:settings.provider,embeddingModel:settings.embeddingModel,
    budget:{fixed_input_tokens:budget.fixedInputTokens,embedding_tokens:budget.embeddingTokens,output_tokens:output,max_provider_attempts:attempts} };
}
