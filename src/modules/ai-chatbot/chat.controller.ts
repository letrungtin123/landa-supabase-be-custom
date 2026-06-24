// ═══════════════════════════════════════════════════════════════
// Chat Controller — HTTP handlers + SSE streaming
// Optimized: UUID validation, tenant isolation, cursor pagination
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as chatService from './chat.service.js';

// ── UUID validation ──
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveTarget(req: Request): chatService.ChatTarget {
  const raw = (req.query.target as string) || (req.body?.target as string) || 'admin';
  return chatService.isChatTarget(raw) ? raw : 'admin';
}

function resolveCourseId(req: Request): string | undefined {
  const raw = (req.query.courseId as string) || (req.body?.courseId as string);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

// ── Bot Assignments ──

export async function getAssignments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    const assignments = await chatService.getAssignments(tenantId);
    sendSuccess(res, assignments);
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function assignBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { target, bot_id } = req.body ?? {};

  if (!target || typeof target !== 'string' || !chatService.isChatTarget(target)) {
    sendError(res, 'target phải là "admin", "learner" hoặc "lesson_author"', 400); return;
  }
  if (!bot_id || typeof bot_id !== 'string' || !UUID_REGEX.test(bot_id)) {
    sendError(res, 'bot_id không hợp lệ', 400); return;
  }

  try {
    await chatService.assignBot(tenantId, target, bot_id);
    sendSuccess(res, { message: 'Đã gán bot' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function unassignBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { target } = req.params;

  if (!chatService.isChatTarget(target)) {
    sendError(res, 'target không hợp lệ', 400); return;
  }

  try {
    const deleted = await chatService.unassignBot(tenantId, target);
    if (!deleted) { sendError(res, 'Không có bot nào được gán cho target này', 404); return; }
    sendSuccess(res, { message: 'Đã bỏ gán bot' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

// ── Active Bot for Chat ──

export async function getLessonAuthorSettings(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    const settings = await chatService.getLessonAuthorSettings(tenantId);
    sendSuccess(res, settings);
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function assignLessonAuthorKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { kb_id } = req.body ?? {};

  if (!kb_id || typeof kb_id !== 'string' || !UUID_REGEX.test(kb_id)) {
    sendError(res, 'kb_id không hợp lệ', 400); return;
  }

  try {
    await chatService.assignLessonAuthorKb(tenantId, kb_id);
    sendSuccess(res, { message: 'Đã gán KB chuyên gia bài học' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function unassignLessonAuthorKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    const deleted = await chatService.unassignLessonAuthorKb(tenantId);
    if (!deleted) { sendError(res, 'Chưa có KB active', 404); return; }
    sendSuccess(res, { message: 'Đã bỏ gán KB chuyên gia bài học' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function assignLessonAuthorPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { bot_id, persona_id } = req.body ?? {};

  if (!bot_id || typeof bot_id !== 'string' || !UUID_REGEX.test(bot_id)) {
    sendError(res, 'bot_id không hợp lệ', 400); return;
  }
  if (!persona_id || typeof persona_id !== 'string' || !UUID_REGEX.test(persona_id)) {
    sendError(res, 'persona_id không hợp lệ', 400); return;
  }

  try {
    await chatService.assignLessonAuthorPersona(tenantId, bot_id, persona_id);
    sendSuccess(res, { message: 'Đã gán mascot chuyên gia bài học' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function unassignLessonAuthorPersona(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    const deleted = await chatService.unassignLessonAuthorPersona(tenantId);
    if (!deleted) { sendError(res, 'Chưa có mascot active', 404); return; }
    sendSuccess(res, { message: 'Đã bỏ gán mascot chuyên gia bài học' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function applyLessonAuthorJob(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const userId = req.user!.id;
  const { jobId } = req.params;

  if (!UUID_REGEX.test(jobId)) {
    sendError(res, 'jobId không hợp lệ', 400); return;
  }

  try {
    const result = await chatService.applyLessonAuthorJob(jobId, userId, tenantId);
    sendSuccess(res, result);
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function getActiveBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const target = resolveTarget(req);
  try {
    const bot = await chatService.getActiveBot(tenantId, target);
    sendSuccess(res, bot);
  } catch (err: any) { sendError(res, err.message, 400); }
}

// ── Conversations ──

export async function listConversations(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;

  try {
    const target = resolveTarget(req);
    const courseId = resolveCourseId(req);
    const activeBot = await chatService.getActiveBot(tenantId, target);
    if (!activeBot) { sendSuccess(res, []); return; }

    const conversations = await chatService.listConversations(userId, activeBot.bot_id, tenantId, target, courseId);
    sendSuccess(res, conversations);
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function createConversation(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  const { persona_id } = req.body ?? {};

  if (!persona_id || typeof persona_id !== 'string' || !UUID_REGEX.test(persona_id)) {
    sendError(res, 'persona_id không hợp lệ', 400); return;
  }

  try {
    const target = resolveTarget(req);
    const courseId = resolveCourseId(req);
    const activeBot = await chatService.getActiveBot(tenantId, target);
    if (!activeBot) { sendError(res, 'Chưa có bot nào được kích hoạt', 400); return; }

    const conversation = await chatService.createConversation(userId, tenantId, activeBot.bot_id, persona_id, target, courseId);
    sendSuccess(res, conversation);
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function deleteConversation(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) { sendError(res, 'ID không hợp lệ', 400); return; }

  try {
    const deleted = await chatService.deleteConversation(id, userId, tenantId);
    if (!deleted) { sendError(res, 'Cuộc hội thoại không tồn tại', 404); return; }
    sendSuccess(res, { message: 'Đã xoá' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

// ── Messages — cursor-based pagination ──

export async function getMessages(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  const { id } = req.params;
  const cursor = req.query.cursor as string | undefined;

  if (!UUID_REGEX.test(id)) { sendError(res, 'ID không hợp lệ', 400); return; }

  try {
    const result = await chatService.getConversationMessages(id, userId, tenantId, cursor);
    sendSuccess(res, result);
  } catch (err: any) { sendError(res, err.message, 400); }
}

/**
 * POST /conversations/:id/messages — SSE streaming
 * Sends user message, streams Gemini response as Server-Sent Events.
 *
 * SSE format:
 *   data: {"type":"chunk","text":"..."}
 *   data: {"type":"done"}
 *   data: {"type":"error","message":"..."}
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  const { id: conversationId } = req.params;
  const { content, mode, outline_mentions, source_documents } = req.body ?? {};
  const target = resolveTarget(req);
  const courseId = resolveCourseId(req);

  if (!UUID_REGEX.test(conversationId)) {
    sendError(res, 'ID không hợp lệ', 400); return;
  }
  if (!content || typeof content !== 'string') {
    sendError(res, 'content không hợp lệ', 400); return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Helper to write SSE event
  const writeSSE = (data: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Handle client disconnect
  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });

  await chatService.sendMessageStream(
    conversationId,
    userId,
    tenantId,
    content,
    {
      target,
      courseId,
      mode: mode === 'draft_lesson'
        ? 'draft_lesson'
        : mode === 'chat'
          ? 'chat'
          : target === 'lesson_author'
            ? 'auto'
            : 'chat',
      outlineMentions: Array.isArray(outline_mentions) ? outline_mentions : [],
      sourceDocuments: Array.isArray(source_documents) ? source_documents : [],
    },
    (text: string) => {
      if (!clientDisconnected) writeSSE({ type: 'chunk', text });
    },
    () => {
      if (!clientDisconnected) {
        writeSSE({ type: 'done' });
        res.end();
      }
    },
    (err: Error) => {
      if (!clientDisconnected) {
        writeSSE({ type: 'error', message: err.message });
        res.end();
      }
    },
    (event) => {
      if (!clientDisconnected) writeSSE(event);
    },
  );
}
