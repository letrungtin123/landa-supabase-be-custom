// ═══════════════════════════════════════════════════════════════
// AI Chatbot Routes — KB + Bot + Document + Chat management
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import * as kbCtrl from './kb.controller.js';
import * as botCtrl from './bot.controller.js';
import * as chatCtrl from './chat.controller.js';

const router = Router();

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

// ── Chat — conversations + messages (SSE stream) ──
router.get('/chat/demo-iframe-preview', chatCtrl.getDemoIframePreview);
router.get('/chat/active-bot', checkPermission('ai_chatbot', 'can_view'), chatCtrl.getActiveBot);
router.get('/chat/conversations', checkPermission('ai_chatbot', 'can_view'), chatCtrl.listConversations);
router.post('/chat/conversations', checkPermission('ai_chatbot', 'can_view'), chatCtrl.createConversation);
router.delete('/chat/conversations/:id', checkPermission('ai_chatbot', 'can_view'), chatCtrl.deleteConversation);
router.get('/chat/conversations/:id/messages', checkPermission('ai_chatbot', 'can_view'), chatCtrl.getMessages);
router.post('/chat/conversations/:id/messages', checkPermission('ai_chatbot', 'can_view'), chatCtrl.sendMessage);

export default router;
