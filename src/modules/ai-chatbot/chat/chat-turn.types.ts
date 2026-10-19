// ═══════════════════════════════════════════════════════════════
// One chat turn (sendMessageStream) as named stages: what each stage
// hands to the next. Stages: validate (chat-turn-admission) → resolve
// context (chat-turn-context, ai-id/legacy/chat-turn-context) → reserve
// (chat-turn-reserve) → build prompt (chat-turn-prompt) → stream provider
// (chat-turn-stream) → persist (chat-turn-persist) → settle
// (chat-turn-settle). The AI Report entry (chat-turn-report) and the AI ID
// V1 answers (ai-id/legacy/chat-turn-*) answer instead of the chat stages.
// ═══════════════════════════════════════════════════════════════

import type { GoogleGenAI } from '@google/genai';
import type { AiUsage, TenantAiRuntimeSettings } from '../ai-platform/ai-engine.types.js';
import type { RagRetrievalDiagnostics } from '../ai-platform/ai-rag-client.service.js';
import type { ChatProviderMeter } from './chat-provider-turn.logic.js';
import type { ChatResponseEmitter } from './chat-response-emitter.logic.js';
import type { ChatStreamOptions, ChatStreamSideEvent, ConversationContext } from './chat.types.js';
import type { LessonAuthorTurnContext } from '../ai-id/legacy/chat-turn-context.service.js';

/** What the error path, the settlement and the lock release need; filled while the turn runs. */
export interface ChatTurnState {
  ctxForError: ConversationContext | null;
  aiReservationId: string | null;
  aiReservationTenantId: string | null;
  aiReservationEmbeddingModel: string | null;
  aiReservationFinalized: boolean;
  lessonAuthorCorrelationId: string | null;
  // Provider calls of the chat answer (section 6), for metering a stopped or failed answer.
  chatProviderMeter: ChatProviderMeter | null;
  chatProviderService: string | null;
}

export type FinalizeAiReservation = (
  usage: AiUsage,
  source: Record<string, unknown>,
  metadata?: Record<string, unknown>,
) => Promise<void>;

/** The validated request and its callbacks. */
export interface ChatTurnRequest {
  conversationId: string;
  userId: string;
  tenantId: string;
  trimmed: string;
  options: ChatStreamOptions;
  onChunk: (text: string) => void;
  onDone: () => void;
  onSideEvent?: (event: ChatStreamSideEvent) => void;
  finalizeAiReservation: FinalizeAiReservation;
}

/** The conversation, the tenant AI settings and the request scope. */
export interface ChatTurnBase extends ChatTurnRequest {
  ctx: ConversationContext;
  lessonAuthorCorrelationId: string | null;
  isVoiceTurn: boolean;
  courseId: string | undefined;
  aiSettings: TenantAiRuntimeSettings;
}

export type ChatTurn = ChatTurnBase & LessonAuthorTurnContext;

/** The bounded history and the reserved token budget of the turn. */
export interface ChatTurnBudget {
  currentTurnText: string;
  historyForTurn: { role: string; parts: { text: string }[] }[];
  requestedLocale: 'vi' | 'en';
  blueprintSystemPrompt: string | null;
  maxOutputTokens: number;
  generationAttempts: number;
}

/** The system prompts and tools of a normal chat answer. */
export interface ChatTurnPrompt {
  history: { role: string; parts: { text: string }[] }[];
  aiClient: GoogleGenAI;
  fileSearchTools: unknown[];
  enrichedPrompt: string;
  ragSystemPrompt: string;
  ragCourseContext: string | null;
  hasCourseContext: boolean;
}

/** The provider answer while it streams, then as it ended. */
export interface ChatTurnAnswer {
  fullResponse: string;
  lastError: Error | null;
  shouldBufferLessonAuthorChat: boolean;
  responseEmitter: ChatResponseEmitter | null;
  appendChatChunk: (text: string) => void;
  chatUsage: Partial<AiUsage> | null;
  // Gemini File Search engine: the provider's usage of every call of this turn (router call,
  // streamed answer, attempts that reached the provider) instead of a text-length estimate.
  geminiTurnUsage: AiUsage | null;
  chatSources: Array<Record<string, unknown>>;
  chatRetrieval: RagRetrievalDiagnostics | null;
  answerSignal: AbortSignal;
  providerMeter: ChatProviderMeter;
}
