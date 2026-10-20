// Chat types shared by chat.service.ts and the AI ID legacy code (ai-id/legacy/).
import { chapterCheckpointRepository } from '../ai-id/v1/lesson-author-chapter-runtime.service.js';
import type { UserRole } from '../../../types/index.js';
import { type LessonAuthorProposal } from '../../course-authoring/course-authoring.service.js';
import type { LessonAuthorAction } from '../ai-id/v1/lesson-author-action.logic.js';
import type { ReportChatFilterInput } from '../ai-report/report-chat.service.js';
import { type ReportChatSideEvent } from '../ai-report/report-chat-turn.service.js';
import { type LessonAuthorLaunchBrief } from '../ai-id/contracts/lesson-author-launch-brief.logic.js';
import type { OrganizationContextV1 } from '../ai-id/contracts/lesson-author-org-context.contract.js';
import { LESSON_AUTHOR_TARGET } from './chat.constants.js';
import type { ChatTarget } from './chat.constants.js';
import type {
  LessonAuthorOutlineMention,
  LessonAuthorBlueprint,
  LessonAuthorBlueprintQualityReport,
} from '../ai-id/legacy/types.js';

export interface CourseOutlineEntry {
  id: string;
  display_name: string;
  block_type: string;
  parent_id: string | null;
  sort_order: number;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LessonAuthorSourceDocumentInput {
  document_id?: string;
  id?: string;
  kb_id?: string;
  name?: string;
}

export interface LessonAuthorSourceDocument {
  document_id: string;
  kb_id: string;
  name: string;
  type: string;
  status: string;
  updated_at: string;
  source_info: Record<string, unknown> | null;
  gemini_path: string | null;
  content_excerpt: string | null;
}

export interface KbAssignment {
  id: string;
  tenant_id: string;
  target: typeof LESSON_AUTHOR_TARGET;
  kb_id: string;
  kb_name: string;
  kb_description: string | null;
  document_count: number;
  learned_count: number;
  learning_count: number;
  error_count: number;
  store_name: string | null;
  updated_at: string;
}

export interface ConversationContext {
  conversationId: string;
  tenantId: string;
  botId: string;
  target: ChatTarget;
  courseId: string | null;
  botKbId: string | null;
  systemPrompt: string;
  messageCount: number;
  inputFilterConfig: unknown;
}

export interface ChatStreamOptions {
  lessonAuthorAction?: LessonAuthorAction;
  /** Server-created, never read from request body/headers. */
  correlationId?: string;
  target?: ChatTarget;
  courseId?: string;
  mode?: 'chat' | 'draft_lesson' | 'course_blueprint' | 'auto';
  outlineMentions?: LessonAuthorOutlineMention[];
  editorContext?: unknown;
  sourceDocuments?: LessonAuthorSourceDocumentInput[];
  blueprintId?: string;
  blueprintChapterIndex?: number;
  chapterCheckpointKey?: string;
  chapterResume?: { draftId: string; previousAttemptId: string };
  inputMode?: 'text' | 'voice';
  locale?: 'vi' | 'en';
  canAccessReports?: boolean;
  reportActorRole?: UserRole;
  reportFilters?: ReportChatFilterInput;
  /** QLT-6: the validated workspace launch brief; only part of the request identity hash. */
  launchBrief?: LessonAuthorLaunchBrief;
  /** The organization context a V2 workspace Create freezes; only part of the request identity hash. */
  organizationContext?: OrganizationContextV1;
  /** Aborted when the client leaves: the chat answer stops calling the provider. */
  abortSignal?: AbortSignal;
}

export type ChatStreamSideEvent =
  | { type: 'chapter_checkpoint'; checkpoint: Awaited<ReturnType<typeof chapterCheckpointRepository.status>> }
  | { type: 'proposal'; job_id: string; proposal: LessonAuthorProposal }
  | {
    type: 'blueprint';
    blueprint_id: string;
    blueprint: LessonAuthorBlueprint;
    quality_report: LessonAuthorBlueprintQualityReport;
    locale: 'vi' | 'en';
  }
  | { type: 'progress'; stage: string; detail?: string }
  | ReportChatSideEvent;
