// Chat turn limits shared by chat.service.ts and the AI ID legacy code (ai-id/legacy/).


export const HISTORY_CONTEXT_LIMIT = 20;         // Last N messages sent to a provider
export const HISTORY_MESSAGE_MAX_CHARS = 1_800;
export const RAG_HISTORY_CONTEXT_LIMIT = 12;
export const RAG_HISTORY_MESSAGE_MAX_CHARS = 1_800;
export const MAX_USER_MESSAGE_LENGTH = 5000;
export const RATE_LIMIT_MS = 3_000;              // 1 message per 3 seconds per user
export const CHAT_TARGETS = ['admin', 'learner', 'lesson_author'] as const;
export const LESSON_AUTHOR_TARGET = 'lesson_author' as const;
export const RAG_CHAT_MIN_OUTPUT_TOKENS = 256;
export const RAG_CHAT_MAX_OUTPUT_TOKENS = 2048;
export const RAG_LESSON_AUTHOR_MIN_OUTPUT_TOKENS = 1024;
// Staged proposal generation emits one bounded request per unit. Preserve
// the provider window for source-complete units; tenant token reservation is
// the capacity control and may still grant a smaller budget when necessary.
export const RAG_LESSON_AUTHOR_MAX_OUTPUT_TOKENS = 65_536;
export const RAG_LESSON_AUTHOR_BLUEPRINT_MIN_OUTPUT_TOKENS = 2048;
// Course blueprints are the authoritative design artifact used to generate
// the full course. Allow the provider's complete output budget instead of
// truncating a source-backed architecture at an arbitrary server limit.
export const RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS = 65_536;
export const RAG_RETRIEVAL_CONTEXT_TOKEN_BUDGET = 8000;
export const BLUEPRINT_MAX_GENERATION_ATTEMPTS = 2;
export const LESSON_AUTHOR_MAX_GENERATION_ATTEMPTS = 2;
export const BLUEPRINT_RETRY_PROMPT_TOKEN_BUDGET = 128;
export type ChatTarget = typeof CHAT_TARGETS[number];
