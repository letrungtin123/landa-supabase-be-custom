// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { query } from '../../../../config/database.js';
import { type LessonAuthorProposal } from '../../../course-authoring/course-authoring.service.js';
import {
  formatLessonAuthorApprovalMessage,
  LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY,
} from '../../lesson-author-message.logic.js';
import type { LessonAuthorSourceDocument, ChatMessage, ConversationContext } from '../../chat.types.js';
import { isValidUUID } from '../../chat-turn-runtime.service.js';
import { readOptionalNonNegativeInteger } from './component-normalize.logic.js';
import type { LessonAuthorBlueprint, LessonAuthorBlueprintQualityReport, LessonAuthorJobRow } from './types.js';
import { withAuthoritativeCourseTitle } from './context.service.js';
import { localizeLessonAuthorBlueprintQualityReport } from './blueprint-normalize.logic.js';
import {
  readLessonAuthorLocale,
  readStoredLessonAuthorOperationPlan,
  formatProposalPreview,
  toLessonAuthorDisplayProposal,
  formatBlueprintPreview,
} from './preview.logic.js';

interface LessonAuthorMessageJobRow {
  id: string;
  status: string;
  proposal: LessonAuthorProposal;
  error_reason: string | null;
  created_block_ids: string[] | null;
  updated_block_ids: string[] | null;
  source_documents: LessonAuthorSourceDocument[] | null;
  blueprint_id: string | null;
  proposal_locale: string | null;
}

interface LessonAuthorMessageBlueprintRow {
  id: string;
  status: string;
  blueprint: LessonAuthorBlueprint;
  quality_report: LessonAuthorBlueprintQualityReport;
  error_reason: string | null;
}

interface LessonAuthorAppliedBlueprintChapterRow {
  blueprint_id: string;
  chapter_index: string;
}

interface LessonAuthorBlueprintDraftProgressRow {
  status: 'proposed' | 'succeeded';
  chapter_index: string;
}

export async function hydrateLessonAuthorProposalMessages(
  messages: ChatMessage[],
  conversationId: string,
  tenantId: string,
): Promise<ChatMessage[]> {
  const jobIds = Array.from(new Set(messages
    .map((message) => {
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
      const jobId = (metadata as Record<string, unknown>).lesson_author_job_id;
      const kind = (metadata as Record<string, unknown>).kind;
      return (kind === 'lesson_author_proposal' || kind === 'lesson_author_plan_approved')
        && typeof jobId === 'string'
        && isValidUUID(jobId)
        ? jobId
        : null;
    })
    .filter((jobId): jobId is string => Boolean(jobId))));

  if (jobIds.length === 0) return messages;

  const result = await query<LessonAuthorMessageJobRow>(
    LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY,
    [conversationId, tenantId, jobIds],
  );
  const jobsById = new Map(result.rows.map(job => [job.id, job]));

  return messages.map((message) => {
    const metadata = message.metadata && typeof message.metadata === 'object'
      ? { ...message.metadata }
      : {};
    const kind = metadata.kind;
    const jobId = metadata.lesson_author_job_id;
    if (
      (kind !== 'lesson_author_proposal' && kind !== 'lesson_author_plan_approved')
      || typeof jobId !== 'string'
    ) return message;
    const job = jobsById.get(jobId);
    if (!job) return message;
    const blueprintChapterIndex = readOptionalNonNegativeInteger(
      metadata.lesson_author_blueprint_chapter_index,
    );
    const locale = typeof metadata.locale === 'string'
      ? readLessonAuthorLocale(metadata.locale)
      : readLessonAuthorLocale(job.proposal_locale);

    if (kind === 'lesson_author_plan_approved') {
      const operation = readStoredLessonAuthorOperationPlan(job.proposal.operation_plan)?.operation;
      const createdCount = job.created_block_ids?.length ?? 0;
      const updatedCount = job.updated_block_ids?.length ?? 0;
      return {
        ...message,
        content: formatLessonAuthorApprovalMessage(operation, createdCount, updatedCount, locale),
        metadata: {
          ...metadata,
          locale,
          created_count: createdCount,
          updated_count: updatedCount,
          created_block_ids: job.created_block_ids ?? [],
          updated_block_ids: job.updated_block_ids ?? [],
        },
      };
    }

    return {
      ...message,
      content: formatProposalPreview(job.proposal, blueprintChapterIndex ?? 0, locale),
      metadata: {
        ...metadata,
        lesson_author_job_status: job.status,
        lesson_author_proposal: toLessonAuthorDisplayProposal(job.proposal, locale),
        lesson_author_error_reason: job.error_reason,
        lesson_author_created_block_ids: job.created_block_ids ?? [],
        lesson_author_source_documents: job.source_documents ?? [],
        locale,
        ...(job.blueprint_id ? { lesson_author_blueprint_id: job.blueprint_id } : {}),
      },
    };
  });
}

async function getAppliedBlueprintChapterIndexes(
  conversationId: string,
  tenantId: string,
  blueprintIds: string[],
): Promise<Map<string, number[]>> {
  if (blueprintIds.length === 0) return new Map();

  // Older jobs did not persist the selected chapter directly on the job row.
  // The request message is immutable and is written immediately before its job,
  // so it is the authoritative compatibility source for those records.
  const result = await query<LessonAuthorAppliedBlueprintChapterRow>(
    `SELECT DISTINCT job.blueprint_id::text AS blueprint_id,
            draft_context.chapter_index
     FROM lesson_author_jobs job
     CROSS JOIN LATERAL (
       SELECT draft.metadata ->> 'lesson_author_blueprint_chapter_index' AS chapter_index
       FROM chat_messages draft
       WHERE draft.conversation_id = job.conversation_id
         AND draft.role = 'user'
         AND draft.created_at <= job.created_at
         AND draft.metadata ->> 'lesson_author_blueprint_id' = job.blueprint_id::text
       ORDER BY draft.created_at DESC
       LIMIT 1
     ) AS draft_context
     WHERE job.conversation_id = $1
       AND job.tenant_id = $2
       AND job.status = 'succeeded'
       AND job.blueprint_id = ANY($3::uuid[])
       AND draft_context.chapter_index ~ '^[0-9]+$'`,
    [conversationId, tenantId, blueprintIds],
  );

  const indexesByBlueprintId = new Map<string, number[]>();
  for (const row of result.rows) {
    const chapterIndex = Number(row.chapter_index);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) continue;
    const indexes = indexesByBlueprintId.get(row.blueprint_id) ?? [];
    if (!indexes.includes(chapterIndex)) indexes.push(chapterIndex);
    indexesByBlueprintId.set(row.blueprint_id, indexes);
  }
  for (const indexes of indexesByBlueprintId.values()) indexes.sort((left, right) => left - right);
  return indexesByBlueprintId;
}

export async function getBlueprintChapterDraftProgress(
  ctx: ConversationContext,
  blueprintId: string,
): Promise<{ applied: Set<number>; pending: Set<number> }> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');

  const result = await query<LessonAuthorBlueprintDraftProgressRow>(
    `SELECT DISTINCT job.status,
            draft_context.chapter_index
     FROM lesson_author_jobs job
     CROSS JOIN LATERAL (
       SELECT draft.metadata ->> 'lesson_author_blueprint_chapter_index' AS chapter_index
       FROM chat_messages draft
       WHERE draft.conversation_id = job.conversation_id
         AND draft.role = 'user'
         AND draft.created_at <= job.created_at
         AND draft.metadata ->> 'lesson_author_blueprint_id' = job.blueprint_id::text
       ORDER BY draft.created_at DESC
       LIMIT 1
     ) AS draft_context
     WHERE job.tenant_id = $1
       AND job.course_id = $2
       AND job.blueprint_id = $3::uuid
       AND job.status IN ('proposed', 'succeeded')
       AND draft_context.chapter_index ~ '^[0-9]+$'`,
    [ctx.tenantId, ctx.courseId, blueprintId],
  );

  const applied = new Set<number>();
  const pending = new Set<number>();
  for (const row of result.rows) {
    const chapterIndex = readOptionalNonNegativeInteger(row.chapter_index);
    if (chapterIndex === null) continue;
    if (row.status === 'succeeded') applied.add(chapterIndex);
    if (row.status === 'proposed') pending.add(chapterIndex);
  }
  return { applied, pending };
}

export function formatBlueprintDraftSequenceError(
  locale: 'vi' | 'en',
  expectedChapterIndex: number | null,
  requestedChapterIndex: number,
  isPending: boolean,
): string {
  if (expectedChapterIndex === null) {
    return locale === 'en'
      ? 'Every chapter in this course blueprint has already been applied.'
      : 'Tất cả chương trong Bản thiết kế khóa học này đã được áp dụng.';
  }
  if (isPending) {
    return locale === 'en'
      ? `Review and apply the pending proposal for Chapter ${expectedChapterIndex + 1} before drafting another chapter.`
      : `Hãy duyệt và áp dụng đề xuất đang chờ của Chương ${expectedChapterIndex + 1} trước khi soạn chương khác.`;
  }
  return locale === 'en'
    ? `Draft and apply Chapter ${expectedChapterIndex + 1} before drafting Chapter ${requestedChapterIndex + 1}.`
    : `Hãy soạn và áp dụng Chương ${expectedChapterIndex + 1} trước khi soạn Chương ${requestedChapterIndex + 1}.`;
}

export async function getBlueprintChapterIndexForJob(
  job: Pick<LessonAuthorJobRow, 'conversation_id' | 'blueprint_id' | 'created_at'>,
): Promise<number | null> {
  if (!job.conversation_id || !job.blueprint_id) return null;

  const result = await query<{ chapter_index: string }>(
    `SELECT draft.metadata ->> 'lesson_author_blueprint_chapter_index' AS chapter_index
     FROM chat_messages draft
     WHERE draft.conversation_id = $1
       AND draft.role = 'user'
       AND draft.created_at <= $2
       AND draft.metadata ->> 'lesson_author_blueprint_id' = $3::text
     ORDER BY draft.created_at DESC
     LIMIT 1`,
    [job.conversation_id, job.created_at, job.blueprint_id],
  );
  return readOptionalNonNegativeInteger(result.rows[0]?.chapter_index);
}

export async function hydrateLessonAuthorBlueprintMessages(
  messages: ChatMessage[],
  conversationId: string,
  tenantId: string,
): Promise<ChatMessage[]> {
  const blueprintIds = Array.from(new Set(messages
    .map((message) => {
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
      const blueprintId = (metadata as Record<string, unknown>).lesson_author_blueprint_id;
      const kind = (metadata as Record<string, unknown>).kind;
      return kind === 'lesson_author_blueprint' && typeof blueprintId === 'string' && isValidUUID(blueprintId)
        ? blueprintId
        : null;
    })
    .filter((blueprintId): blueprintId is string => Boolean(blueprintId))));

  if (blueprintIds.length === 0) return messages;

  const result = await query<LessonAuthorMessageBlueprintRow>(
    `SELECT id::text, status, blueprint, quality_report, error_reason
     FROM lesson_author_blueprints
     WHERE conversation_id = $1
       AND tenant_id = $2
       AND id = ANY($3::uuid[])`,
    [conversationId, tenantId, blueprintIds],
  ).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    // Supports a rolling deploy where the backend updates before the additive
    // Blueprint migration. Any other database failure remains visible.
    if (code === '42P01') return null;
    throw error;
  });
  if (!result) return messages;
  const blueprintsById = new Map(result.rows.map(blueprint => [blueprint.id, blueprint]));
  const courseResult = await query<{ display_name: string }>(
    `SELECT COALESCE(course_block.display_name, c.display_name) AS display_name
     FROM chat_conversations cc
     JOIN courses c ON c.id = cc.course_id
     LEFT JOIN LATERAL (
       SELECT cb.display_name
       FROM course_blocks cb
       WHERE cb.course_id = c.id
         AND cb.block_type = 'course'
         AND cb.deleted_at IS NULL
       ORDER BY cb.sort_order ASC, cb.created_at ASC
       LIMIT 1
     ) course_block ON true
     WHERE cc.id = $1
       AND cc.tenant_id = $2
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [conversationId, tenantId],
  );
  const authoritativeCourseTitle = courseResult.rows[0]?.display_name?.trim() ?? '';
  const appliedChapterIndexesByBlueprintId = await getAppliedBlueprintChapterIndexes(
    conversationId,
    tenantId,
    Array.from(blueprintsById.keys()),
  );

  return messages.map((message) => {
    const metadata = message.metadata && typeof message.metadata === 'object'
      ? { ...message.metadata }
      : {};
    const kind = metadata.kind;
    const blueprintId = metadata.lesson_author_blueprint_id;
    if (kind !== 'lesson_author_blueprint' || typeof blueprintId !== 'string') return message;
    const blueprint = blueprintsById.get(blueprintId);
    if (!blueprint) return message;
    const hydratedBlueprint = withAuthoritativeCourseTitle(blueprint.blueprint, authoritativeCourseTitle);
    const locale = readLessonAuthorLocale(metadata.locale);
    const localizedQualityReport = localizeLessonAuthorBlueprintQualityReport(
      blueprint.quality_report,
      hydratedBlueprint,
      locale,
    );

    return {
      ...message,
      content: formatBlueprintPreview(hydratedBlueprint, localizedQualityReport, locale),
      metadata: {
        ...metadata,
        lesson_author_blueprint_status: blueprint.status,
        lesson_author_blueprint: hydratedBlueprint,
        lesson_author_blueprint_quality_report: localizedQualityReport,
        lesson_author_blueprint_error_reason: blueprint.error_reason,
        lesson_author_blueprint_applied_chapter_indexes: appliedChapterIndexesByBlueprintId.get(blueprint.id) ?? [],
      },
    };
  });
}
