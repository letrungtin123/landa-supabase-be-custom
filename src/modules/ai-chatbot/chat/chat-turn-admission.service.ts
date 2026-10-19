// Stage 1 of a chat turn, validate: the message, the user's rate limit, the
// conversation is the caller's, then one answer at a time per conversation
// (process lock, then the Redis lock).
// Moved from sendMessageStream (chat.service.ts).

import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/error-handler.js';
import { type DistributedStreamLock } from './chat-stream-lock.js';
import { LESSON_AUTHOR_TARGET, MAX_USER_MESSAGE_LENGTH } from './chat.constants.js';
import type { ChatStreamOptions } from './chat.types.js';
import {
  acquireDistributedStreamLock,
  assertChatConversationOwner,
  checkRateLimit,
  isValidUUID,
  sanitizeGeminiError,
  streamLocks,
} from './chat-turn-runtime.service.js';

export interface AdmittedChatTurn {
  trimmed: string;
  distributedStreamLock: DistributedStreamLock;
}

/** The admitted message and its conversation locks, or null when refused (onError was called). */
export async function admitChatTurn(
  conversationId: string,
  userId: string,
  tenantId: string,
  userContent: string,
  options: ChatStreamOptions,
  onError: (err: Error) => void,
): Promise<AdmittedChatTurn | null> {
  // ── Validation ──
  if (!isValidUUID(conversationId)) { onError(new Error('ID không hợp lệ')); return null; }
  const trimmed = userContent.trim();
  if (!trimmed) { onError(new Error('Tin nhắn không được trống')); return null; }
  if (trimmed.length > MAX_USER_MESSAGE_LENGTH) { onError(new Error(`Tin nhắn tối đa ${MAX_USER_MESSAGE_LENGTH} ký tự`)); return null; }

  // ── Rate limit ──
  try { await checkRateLimit(userId); } catch (err: any) { onError(err); return null; }

  // ── Ownership and target, before the locks: another user's conversation is
  // answered exactly like a missing one (never "already processing") ──
  try {
    await assertChatConversationOwner(conversationId, userId, tenantId, options.target);
  } catch (err) {
    onError(sanitizeGeminiError(err));
    return null;
  }

  // ── Concurrency lock ──
  if (streamLocks.has(conversationId)) {
    onError(new Error('Đang xử lý tin nhắn trước đó. Vui lòng đợi.'));
    return null;
  }
  streamLocks.add(conversationId);
  let distributedStreamLock: DistributedStreamLock | null;
  try { distributedStreamLock = await acquireDistributedStreamLock(conversationId,
    (env.LESSON_AUTHOR_GENERATION_ENABLED || env.LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED) && options.target === LESSON_AUTHOR_TARGET); }
  catch {
    streamLocks.delete(conversationId);
    onError(new AppError('Chưa thể khóa cuộc hội thoại. Vui lòng thử lại sau.', 503, 'CHAT_LOCK_UNAVAILABLE'));
    return null;
  }
  if (!distributedStreamLock) {
    streamLocks.delete(conversationId);
    onError(new Error('Đang xử lý tin nhắn trước đó. Vui lòng đợi.'));
    return null;
  }

  return { trimmed, distributedStreamLock };
}
