export const AI_ENGINES = ['gemini_file_search', 'self_built_rag'] as const;
export type AiEngine = typeof AI_ENGINES[number];

export const AI_PROVIDER_GOOGLE = 'google_ai_studio' as const;
export type AiProvider = typeof AI_PROVIDER_GOOGLE;

export const CHAT_TARGETS = ['admin', 'learner', 'lesson_author'] as const;
export type AiChatTarget = typeof CHAT_TARGETS[number];

export const AI_OPERATIONS = ['chat', 'lesson_author', 'indexing'] as const;
export type AiOperation = typeof AI_OPERATIONS[number];

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  totalTokens: number;
}

export interface TenantAiRuntimeSettings {
  tenantId: string;
  activeEngine: AiEngine;
  provider: AiProvider;
  monthlyTokenLimit: string | null;
  tokenTimezone: string;
  chatModel: string;
  lessonAuthorModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  transitionState: 'idle' | 'queued' | 'running' | 'failed';
  activeTransitionJobId: string | null;
  hasGoogleAiStudioKey: boolean;
  apiKeyFingerprint: string | null;
}
