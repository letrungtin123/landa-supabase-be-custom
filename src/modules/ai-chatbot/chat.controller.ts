// ═══════════════════════════════════════════════════════════════
// Chat Controller — HTTP handlers + SSE streaming
// Optimized: UUID validation, tenant isolation, cursor pagination
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as chatService from './chat.service.js';

// ── UUID validation ──
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (!target || !['admin', 'learner'].includes(target)) {
    sendError(res, 'target phải là "admin" hoặc "learner"', 400); return;
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

  if (!['admin', 'learner'].includes(target)) {
    sendError(res, 'target không hợp lệ', 400); return;
  }

  try {
    const deleted = await chatService.unassignBot(tenantId, target);
    if (!deleted) { sendError(res, 'Không có bot nào được gán cho target này', 404); return; }
    sendSuccess(res, { message: 'Đã bỏ gán bot' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

// ── Active Bot for Chat ──

export async function getActiveBot(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    const bot = await chatService.getActiveBot(tenantId, 'admin');
    sendSuccess(res, bot);
  } catch (err: any) { sendError(res, err.message, 400); }
}

// ── Conversations ──

export async function listConversations(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;

  try {
    const activeBot = await chatService.getActiveBot(tenantId, 'admin');
    if (!activeBot) { sendSuccess(res, []); return; }

    const conversations = await chatService.listConversations(userId, activeBot.bot_id, tenantId);
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
    const activeBot = await chatService.getActiveBot(tenantId, 'admin');
    if (!activeBot) { sendError(res, 'Chưa có bot nào được kích hoạt', 400); return; }

    const conversation = await chatService.createConversation(userId, tenantId, activeBot.bot_id, persona_id);
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
  const { content } = req.body ?? {};

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
  );
}
