// ═══════════════════════════════════════════════════════════════
// AI Chatbot Routes — KB + Bot + Document + Chat management
// ═══════════════════════════════════════════════════════════════

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import { sendError } from '../../utils/response.js';
import * as kbCtrl from './kb.controller.js';
import * as botCtrl from './bot.controller.js';
import * as chatCtrl from './chat.controller.js';
import { getAiOverviewController } from './ai-report.controller.js';

const router = Router();

function getRuntimeChatTarget(req: Request): string {
  const queryTarget = req.query.target;
  if (typeof queryTarget === 'string') return queryTarget;

  const body = req.body as { target?: unknown } | undefined;
  return typeof body?.target === 'string' ? body.target : 'admin';
}

function isLearnerRole(role: string | undefined): boolean {
  return role === 'learner' || role === 'learner_plus';
}

/**
 * Runtime chat is deliberately independent from the ai_chatbot management module.
 * Learners remain confined to the learner deployment; all tenant and bot ownership
 * checks are enforced by tenantContext and chat.service.
 */
function allowRuntimeChatTarget(req: Request, res: Response, next: NextFunction): void {
  if (isLearnerRole(req.user?.role) && getRuntimeChatTarget(req) !== 'learner') {
    sendError(res, 'Bạn chỉ có thể sử dụng chatbot dành cho học viên', 403);
    return;
  }
  next();
}

// Multer — memory storage, 50MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// All routes require auth + tenant context
router.use(authenticate);
router.use(tenantContext);

// ── Knowledge Base CRUD ──
router.get('/kb', checkPermission('ai_chatbot', 'can_view'), kbCtrl.listKbs);
router.get('/reports/overview', checkPermission('ai_chatbot', 'can_view'), getAiOverviewController);
router.get('/kb/:id', checkPermission('ai_chatbot', 'can_view'), kbCtrl.getKb);
router.post('/kb', checkPermission('ai_chatbot', 'can_add'), kbCtrl.createKb);
router.put('/kb/:id', checkPermission('ai_chatbot', 'can_edit'), kbCtrl.updateKb);
router.post('/kb/:kbId/restore', checkPermission('ai_chatbot', 'can_edit'), kbCtrl.restoreKb);
router.delete('/kb/:id', checkPermission('ai_chatbot', 'can_delete'), kbCtrl.deleteKb);

// ── Document CRUD — Files tab ──
router.get('/kb/:kbId/documents', checkPermission('ai_chatbot', 'can_view'), kbCtrl.listDocuments);
router.post('/kb/:kbId/documents', checkPermission('ai_chatbot', 'can_add'), upload.array('files', 20), kbCtrl.uploadDocuments);
router.delete('/kb/:kbId/documents/:docId', checkPermission('ai_chatbot', 'can_delete'), kbCtrl.deleteDocument);
router.post('/kb/:kbId/documents/bulk-delete', checkPermission('ai_chatbot', 'can_delete'), kbCtrl.bulkDeleteDocuments);
router.post('/kb/:kbId/documents/retry', checkPermission('ai_chatbot', 'can_edit'), kbCtrl.retryDocuments);

// ── FAQ — xlsx upload ──
router.get('/kb/:kbId/documents/faq-template', checkPermission('ai_chatbot', 'can_view'), kbCtrl.downloadFaqTemplate);
router.post('/kb/:kbId/documents/faq', checkPermission('ai_chatbot', 'can_add'), upload.single('file'), kbCtrl.uploadFaqDocument);

// ── Articles — rich text ──
router.post('/kb/:kbId/articles', checkPermission('ai_chatbot', 'can_add'), kbCtrl.createArticle);
router.put('/kb/:kbId/articles/:docId', checkPermission('ai_chatbot', 'can_edit'), kbCtrl.updateArticle);
router.get('/kb/:kbId/articles/:docId', checkPermission('ai_chatbot', 'can_view'), kbCtrl.getArticle);

// ── Bot Assignments (active bot for admin/learner FE) — MUST be before /bots/:id ──
router.get('/bots/assignments', checkPermission('ai_chatbot', 'can_view'), chatCtrl.getAssignments);
router.put('/bots/assignments', checkPermission('ai_chatbot', 'can_edit'), chatCtrl.assignBot);
router.delete('/bots/assignments/:target', checkPermission('ai_chatbot', 'can_edit'), chatCtrl.unassignBot);

// ── Bot CRUD ──
router.get('/lesson-author/settings', checkPermission('ai_chatbot', 'can_view'), chatCtrl.getLessonAuthorSettings);
router.put('/lesson-author/kb-assignment', checkPermission('ai_chatbot', 'can_edit'), chatCtrl.assignLessonAuthorKb);
router.delete('/lesson-author/kb-assignment', checkPermission('ai_chatbot', 'can_edit'), chatCtrl.unassignLessonAuthorKb);
router.post('/lesson-author/jobs/:jobId/apply', checkPermission('courses', 'can_edit'), chatCtrl.applyLessonAuthorJob);

router.get('/bots', checkPermission('ai_chatbot', 'can_view'), botCtrl.listBots);
router.get('/bots/:id', checkPermission('ai_chatbot', 'can_view'), botCtrl.getBot);
router.post('/bots', checkPermission('ai_chatbot', 'can_add'), botCtrl.createBot);
router.put('/bots/:id', checkPermission('ai_chatbot', 'can_edit'), botCtrl.updateBot);
router.delete('/bots/:id', checkPermission('ai_chatbot', 'can_delete'), botCtrl.deleteBot);
router.post('/bots/:id/avatar', checkPermission('ai_chatbot', 'can_edit'), upload.single('avatar'), botCtrl.uploadAvatar);
router.get('/bots/:id/input-filter', checkPermission('ai_chatbot', 'can_view'), botCtrl.getInputFilterConfig);
router.put('/bots/:id/input-filter', checkPermission('ai_chatbot', 'can_edit'), botCtrl.updateInputFilterConfig);

// ── Bot Personas ──
router.get('/bots/:id/personas', checkPermission('ai_chatbot', 'can_view'), botCtrl.listPersonas);
router.post('/bots/:id/personas', checkPermission('ai_chatbot', 'can_edit'), botCtrl.addPersona);
router.put('/bots/:id/personas/:personaId', checkPermission('ai_chatbot', 'can_edit'), botCtrl.updatePersona);
router.post('/bots/:id/personas/:personaId/reset', checkPermission('ai_chatbot', 'can_edit'), botCtrl.resetPersona);
router.delete('/bots/:id/personas/:personaId', checkPermission('ai_chatbot', 'can_delete'), botCtrl.removePersona);

// ── Chat runtime — bot deployment, not the management module, controls access.
// Every handler still requires authentication + an active tenant context. The service
// additionally binds the conversation to its current tenant bot assignment.
router.get('/chat/demo-iframe-preview', chatCtrl.getDemoIframePreview);
router.get('/chat/active-bot', allowRuntimeChatTarget, chatCtrl.getActiveBot);
router.get('/chat/active-bot/personas', allowRuntimeChatTarget, chatCtrl.getActiveBotPersonas);
router.get('/chat/lesson-author/settings', allowRuntimeChatTarget, chatCtrl.getLessonAuthorChatSettings);
router.get('/chat/lesson-author/source-documents', allowRuntimeChatTarget, chatCtrl.listLessonAuthorSourceDocuments);
router.get('/chat/conversations', allowRuntimeChatTarget, chatCtrl.listConversations);
router.post('/chat/conversations', allowRuntimeChatTarget, chatCtrl.createConversation);
router.delete('/chat/conversations/:id', allowRuntimeChatTarget, chatCtrl.deleteConversation);
router.get('/chat/conversations/:id/messages', allowRuntimeChatTarget, chatCtrl.getMessages);
router.post('/chat/conversations/:id/messages', allowRuntimeChatTarget, chatCtrl.sendMessage);

export default router;
