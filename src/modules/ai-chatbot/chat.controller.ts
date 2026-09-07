// ═══════════════════════════════════════════════════════════════
// Chat Controller — HTTP handlers + SSE streaming
// Optimized: UUID validation, tenant isolation, cursor pagination
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { auditFromReq } from '../../middleware/audit-log.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import * as chatService from './chat.service.js';
import * as botService from './bot.service.js';
import * as kbService from './kb.service.js';

// ── UUID validation ──
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getRawTarget(req: Request): string | undefined {
  const queryTarget = req.query.target;
  if (typeof queryTarget === 'string') return queryTarget;

  const body = req.body as { target?: unknown } | undefined;
  return typeof body?.target === 'string' ? body.target : undefined;
}

function resolveTarget(req: Request): chatService.ChatTarget {
  const raw = getRawTarget(req) || 'admin';
  return chatService.isChatTarget(raw) ? raw : 'admin';
}

function resolveExplicitTarget(req: Request): chatService.ChatTarget | undefined {
  const raw = getRawTarget(req);
  return raw && chatService.isChatTarget(raw) ? raw : undefined;
}

function resolveCourseId(req: Request): string | undefined {
  const raw = (req.query.courseId as string) || (req.body?.courseId as string);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

type PublicPersonaPreview = Pick<
  botService.BotPersona,
  | 'id'
  | 'bot_id'
  | 'template_id'
  | 'template_name'
  | 'template_description'
  | 'template_avatar_url'
  | 'template_fullbody_url'
  | 'custom_name'
  | 'custom_description'
>;

function toPublicPersonaPreview(persona: botService.BotPersona): PublicPersonaPreview {
  return {
    id: persona.id,
    bot_id: persona.bot_id,
    template_id: persona.template_id,
    template_name: persona.template_name,
    template_description: persona.template_description,
    template_avatar_url: persona.template_avatar_url,
    template_fullbody_url: persona.template_fullbody_url,
    custom_name: persona.custom_name,
    custom_description: persona.custom_description,
  };
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
    const bot = await botService.getBot(bot_id, tenantId);
    await chatService.assignBot(tenantId, target, bot_id);
    auditFromReq(req, 'UPDATE', 'bot_assignment', target, bot?.name || bot_id, `Gán bot cho ${target}`);
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
    const active = await chatService.getActiveBot(tenantId, target);
    const deleted = await chatService.unassignBot(tenantId, target);
    if (!deleted) { sendError(res, 'Không có bot nào được gán cho target này', 404); return; }
    auditFromReq(req, 'DELETE', 'bot_assignment', target, active?.bot_name || target, `Bỏ gán bot khỏi ${target}`);
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
    const kb = await kbService.getKnowledgebase(kb_id, tenantId);
    await chatService.assignLessonAuthorKb(tenantId, kb_id);
    auditFromReq(req, 'UPDATE', 'lesson_author_kb_assignment', tenantId, kb?.name || kb_id, 'Gán KB chuyên gia bài học');
    sendSuccess(res, { message: 'Đã gán KB chuyên gia bài học' });
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function unassignLessonAuthorKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    const activeKb = await chatService.getActiveKbAssignment(tenantId);
    const deleted = await chatService.unassignLessonAuthorKb(tenantId);
    if (!deleted) { sendError(res, 'Chưa có KB active', 404); return; }
    auditFromReq(req, 'DELETE', 'lesson_author_kb_assignment', tenantId, activeKb?.kb_name || tenantId, 'Bỏ gán KB chuyên gia bài học');
    sendSuccess(res, { message: 'Đã bỏ gán KB chuyên gia bài học' });
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
    auditFromReq(req, 'UPDATE', 'lesson_author_job', result.course_id, undefined, `Áp dụng job ${jobId}: tạo ${result.created_count}, cập nhật ${result.updated_count}`);
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

export async function getActiveBotPersonas(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const target = resolveTarget(req);

  if (target !== 'learner') {
    sendError(res, 'Endpoint này chỉ hỗ trợ target learner', 400);
    return;
  }

  try {
    const bot = await chatService.getActiveBot(tenantId, 'learner');
    if (!bot) {
      sendSuccess(res, []);
      return;
    }

    const personas = await botService.listBotPersonas(bot.bot_id, tenantId);
    sendSuccess(res, personas.map(toPublicPersonaPreview));
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function getDemoIframePreview(req: Request, res: Response): Promise<void> {
  const tenantId = req.user?.tenantId;
  const target = resolveTarget(req);

  if (!req.user || req.user.role !== 'learner' || !isDemoIframeSession(req.user) || !tenantId) {
    sendError(res, 'Không có quyền xem preview demo iframe', 403);
    return;
  }

  if (target !== 'learner') {
    sendError(res, 'Demo iframe chỉ hỗ trợ target learner', 400);
    return;
  }

  try {
    const bot = await chatService.getActiveBot(tenantId, 'learner');
    if (!bot) {
      sendSuccess(res, { bot: null, personas: [] });
      return;
    }

    const personas = await botService.listBotPersonas(bot.bot_id, tenantId);
    sendSuccess(res, {
      bot,
      personas: personas.map(toPublicPersonaPreview),
    });
  } catch (err: any) { sendError(res, err.message, 400); }
}

// ── Conversations ──

export async function listConversations(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  if (isDemoIframeSession(req.user)) {
    sendSuccess(res, []);
    return;
  }

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
  if (isDemoIframeSession(req.user)) {
    sendError(res, 'Phiên demo iframe không thể tạo hội thoại', 403);
    return;
  }
  const { persona_id } = req.body ?? {};
  const target = resolveTarget(req);

  if (target !== 'lesson_author' && (!persona_id || typeof persona_id !== 'string' || !UUID_REGEX.test(persona_id))) {
    sendError(res, 'persona_id không hợp lệ', 400); return;
  }

  try {
    const courseId = resolveCourseId(req);
    const activeBot = await chatService.getActiveBot(tenantId, target);
    if (!activeBot) { sendError(res, 'Chưa có bot nào được kích hoạt', 400); return; }

    const conversation = await chatService.createConversation(
      userId,
      tenantId,
      activeBot.bot_id,
      typeof persona_id === 'string' ? persona_id : null,
      target,
      courseId,
    );
    sendSuccess(res, conversation);
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function deleteConversation(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  const { id } = req.params;
  if (isDemoIframeSession(req.user)) {
    sendError(res, 'Phiên demo iframe không thể xóa hội thoại', 403);
    return;
  }

  if (!UUID_REGEX.test(id)) { sendError(res, 'ID không hợp lệ', 400); return; }

  try {
    const deleted = await chatService.deleteConversation(id, userId, tenantId, resolveExplicitTarget(req));
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
  if (isDemoIframeSession(req.user)) {
    sendSuccess(res, { messages: [], has_more: false, next_cursor: null });
    return;
  }

  if (!UUID_REGEX.test(id)) { sendError(res, 'ID không hợp lệ', 400); return; }

  try {
    const result = await chatService.getConversationMessages(id, userId, tenantId, cursor, resolveExplicitTarget(req));
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
  const { content, mode, outline_mentions, source_documents, input_mode } = req.body ?? {};
  const target = resolveTarget(req);
  const courseId = resolveCourseId(req);
  if (isDemoIframeSession(req.user)) {
    sendError(res, 'Phiên demo iframe không thể gửi tin nhắn', 403);
    return;
  }

  if (!UUID_REGEX.test(conversationId)) {
    sendError(res, 'ID không hợp lệ', 400); return;
  }
  if (!content || typeof content !== 'string') {
    sendError(res, 'content không hợp lệ', 400); return;
  }
  if (input_mode !== undefined && input_mode !== 'text' && input_mode !== 'voice') {
    sendError(res, 'input_mode không hợp lệ', 400); return;
  }
  const inputMode = input_mode === 'voice' ? 'voice' : 'text';

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientDisconnected = false;

  // Helper to write SSE event
  const writeSSE = (data: Record<string, unknown>): boolean => {
    if (clientDisconnected || res.writableEnded || res.destroyed) return false;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      clientDisconnected = true;
      return false;
    }
  };

  const endSSE = () => {
    if (clientDisconnected || res.writableEnded || res.destroyed) return;
    try {
      res.end();
    } catch {
      clientDisconnected = true;
    }
  };

  // Handle real response disconnects. req.close can fire after the request body is read on long SSE responses.
  req.on('aborted', () => { clientDisconnected = true; });
  res.on('close', () => {
    if (!res.writableEnded) clientDisconnected = true;
  });

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
      inputMode,
    },
    (text: string) => {
      if (!clientDisconnected) writeSSE({ type: 'chunk', text });
    },
    () => {
      if (!clientDisconnected) {
        writeSSE({ type: 'done' });
        endSSE();
      }
    },
    (err: Error) => {
      if (!clientDisconnected) {
        writeSSE({ type: 'error', message: err.message });
        endSSE();
      }
    },
    (event) => {
      if (!clientDisconnected) writeSSE(event);
    },
  );
}

