// ═══════════════════════════════════════════════════════════════
// AI Chatbot Routes — KB + Bot + Document + Chat management
// ═══════════════════════════════════════════════════════════════

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission, hasPermission } from '../../middleware/authorize.js';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { createGenerationJobRepository } from './lesson-author-generation-job.repository.js';
import { createGenerationStatusHandler } from './lesson-author-generation-status.controller.js';
import { createWorkspaceReadHandlers } from './lesson-author-workspace-read.controller.js';
import { createWorkspaceStreamHandler } from './lesson-author-workspace-stream.controller.js';
import { workspaceCommitHub } from './lesson-author-workspace-stream.service.js';
import { createSourceDocumentStreamHandler } from './lesson-author-source-stream.controller.js';
import { sourceDocumentHub } from './lesson-author-source-stream.service.js';
import { createWorkspaceLaunchHandlers } from './lesson-author-workspace-launch.controller.js';
import { createLessonAuthorWorkspace, isLessonAuthorWorkspaceReady } from './lesson-author-workspace-runtime.service.js';
import { createWorkspaceV2LaunchService } from './lesson-author-workspace-v2-launch.service.js';
import { createWorkspaceEditHandlers } from './lesson-author-workspace-edit.controller.js';
import { createWorkspaceApplyHandler } from './lesson-author-workspace-apply.controller.js';
import { createWorkspaceApplyRepository } from './lesson-author-workspace-apply.repository.js';
import { createWorkspaceAcceptance } from './lesson-author-workspace-storyboard.repository.js';
import { createOrchestrationV2AdmissionRepository } from './lesson-author-orchestration-v2-admission.repository.js';
import { createOrchestrationV2AdmissionService } from './lesson-author-orchestration-v2-admission.service.js';
import { loadOrchestrationV2AdmissionRuntime, orchestrationV2IdmAdmissionWarning } from './lesson-author-orchestration-v2-execution.config.js';
import { verifyOrchestrationV2Schema } from './lesson-author-orchestration-v2-schema.repository.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';
import { prepareDurableBlueprint, withLessonAuthorConversationLock } from './chat.service.js';
import { sendError } from '../../utils/response.js';
import * as kbCtrl from './kb.controller.js';
import * as botCtrl from './bot.controller.js';
import * as chatCtrl from './chat.controller.js';
import * as transcriptCtrl from './lesson-author-transcription.controller.js';
import { getAiOverviewController } from './ai-report.controller.js';
import { reportPdfHandlers } from './report-pdf.controller.js';
import { env } from '../../config/env.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { normalizeLessonAuthorUploadAttemptId } from './lesson-author-transcription.logic.js';
import { AppError } from '../../middleware/error-handler.js';
import { appendAuditLog } from '../../middleware/audit-log.js';
import {
  createLessonAuthorActiveRunsHandler,
  createLessonAuthorAuthorGuard,
  createLessonAuthorCourseEditorGuard,
  createLessonAuthorSessionOwnerGuard,
} from './lesson-author-session-access.controller.js';
import { findLessonAuthorSessionOwner } from './lesson-author-session-access.repository.js';
import { parseLessonAuthorSourceUpload, uploadLessonAuthorSourceDocument } from './lesson-author-source-upload.controller.js';
import {
  deleteLessonAuthorSessionController,
  getLessonAuthorSessionDeleteImpactController,
  getLessonAuthorSessionDeletionStatusController,
  listLessonAuthorSessionController,
  renameLessonAuthorSessionController,
} from './lesson-author-session.controller.js';

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

const lessonAuthorVideoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      const destination = path.resolve(env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR, 'uploads');
      try {
        fs.mkdirSync(destination, { recursive: true });
        callback(null, destination);
      } catch (error) {
        callback(error as Error, destination);
      }
    },
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
  }),
  limits: { files: 1, fileSize: env.LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB * 1024 * 1024 },
});

function clearTemporaryLessonAuthorVideo(req: Request): void {
  const filePath = req.file?.path;
  if (filePath) fs.unlink(filePath, () => undefined);
}

/**
 * Multer errors bypass the controller. Keep this boundary explicit so the
 * client receives a JSON API error and operators can distinguish transport,
 * authorization, multipart, and transcription-service failures.
 */
function parseLessonAuthorVideoUpload(req: Request, res: Response, next: NextFunction): void {
  lessonAuthorVideoUpload.single('video')(req, res, (error?: unknown) => {
    if (!error) {
      console.info('[LessonAuthorTranscription] multipart parsed', {
        client_attempt_id: normalizeLessonAuthorUploadAttemptId(req.get('x-lesson-author-upload-attempt')),
        conversation_id: req.params.conversationId,
        source_size_bytes: req.file?.size ?? null,
        has_video: Boolean(req.file),
      });
      next();
      return;
    }

    clearTemporaryLessonAuthorVideo(req);
    const isSizeLimit = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    const isMultipartError = error instanceof multer.MulterError;
    const code = isSizeLimit
      ? 'VIDEO_FILE_TOO_LARGE'
      : isMultipartError
        ? 'VIDEO_MULTIPART_INVALID'
        : 'VIDEO_UPLOAD_PARSE_FAILED';
    const message = isSizeLimit
      ? `Video vượt quá giới hạn ${env.LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB}MB.`
      : 'Không thể đọc video tải lên.';
    console.warn('[LessonAuthorTranscription] multipart rejected', {
      client_attempt_id: normalizeLessonAuthorUploadAttemptId(req.get('x-lesson-author-upload-attempt')),
      conversation_id: req.params.conversationId,
      error_code: code,
      multer_code: error instanceof multer.MulterError ? error.code : null,
      source_size_bytes: req.file?.size ?? null,
    });
    sendError(res, message, isSizeLimit ? 413 : 400, code);
  });
}

function observeLessonAuthorTranscriptionRequest(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const clientAttemptId = normalizeLessonAuthorUploadAttemptId(req.get('x-lesson-author-upload-attempt'));
  let finished = false;
  console.info('[LessonAuthorTranscription] request received', {
    client_attempt_id: clientAttemptId,
    conversation_id: req.params.conversationId,
    content_length: req.headers['content-length'] ?? null,
    content_type: req.headers['content-type']?.split(';', 1)[0] ?? null,
  });
  res.once('finish', () => {
    finished = true;
    console.info('[LessonAuthorTranscription] request completed', {
      client_attempt_id: clientAttemptId,
      conversation_id: req.params.conversationId,
      status_code: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });
  res.once('close', () => {
    if (finished) return;
    console.warn('[LessonAuthorTranscription] request aborted', {
      client_attempt_id: clientAttemptId,
      conversation_id: req.params.conversationId,
      duration_ms: Date.now() - startedAt,
    });
  });
  next();
}

// All routes require auth + tenant context
router.use(authenticate);
router.use(tenantContext);

// ── AI course design (lesson author) access ──
// Using AI never requires the ai_chatbot module (configuration pages only):
// lesson-author runtime needs the course data permission. Sessions are shared
// per course; only the creator continues one (localized 403 for other editors).
const lessonAuthorAccess = { db: { query }, canEditCourses: (user: NonNullable<Request['user']>) => hasPermission(user, 'courses', 'can_edit') };
const lessonAuthorSessionOwnerOnly = createLessonAuthorSessionOwnerGuard(lessonAuthorAccess);
const lessonAuthorCourseEditor = createLessonAuthorCourseEditorGuard(lessonAuthorAccess, getRuntimeChatTarget);
// Routes not keyed by a conversation: staff+ in a normal session (never learner_plus).
const lessonAuthorAuthor = createLessonAuthorAuthorGuard(lessonAuthorAccess);
const resolveLessonAuthorSessionOwner = async (input: { tenantId: string; courseId: string; conversationId: string }) =>
  (await findLessonAuthorSessionOwner({ query }, input))?.owner_id ?? null;

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
router.post('/lesson-author/jobs/:jobId/apply', checkPermission('courses', 'can_edit'), lessonAuthorAuthor, chatCtrl.applyLessonAuthorJob);

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
router.get('/chat/lesson-author/settings', allowRuntimeChatTarget, checkPermission('courses', 'can_edit'), chatCtrl.getLessonAuthorChatSettings);
router.get('/chat/lesson-author/source-documents', allowRuntimeChatTarget, checkPermission('courses', 'can_edit'), chatCtrl.listLessonAuthorSourceDocuments);
// AI course design source upload: course editors upload into the tenant's
// server-resolved lesson-author knowledge base. KB management uploads above
// keep requiring ai_chatbot rights.
router.post('/chat/lesson-author/source-documents', checkPermission('courses', 'can_edit'), lessonAuthorAuthor, parseLessonAuthorSourceUpload, uploadLessonAuthorSourceDocument);
router.get('/chat/lesson-author/source-documents/:documentId/stream', allowRuntimeChatTarget, createSourceDocumentStreamHandler({
  db: { query },
  canRead: user => hasPermission(user, 'courses', 'can_edit'),
  subscribe: (documentId, listener) => sourceDocumentHub.subscribe(documentId, listener),
  report: event => {
    const line = '[LessonAuthorSourceStream] ' + JSON.stringify(event);
    if (event.event === 'source_stream_failed') console.warn(line); else console.info(line);
  },
}));
router.get('/chat/lesson-author/conversations/:conversationId/chapter-checkpoint', checkPermission('courses','can_edit'), chatCtrl.getChapterCheckpoint);
const orchestrationV2IdmPolicy = {
  enabled: env.LESSON_AUTHOR_IDM_PIPELINE_ENABLED,
  tenant_allowlist: env.LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST,
};
const orchestrationV2IdmWarning = orchestrationV2IdmAdmissionWarning(orchestrationV2IdmPolicy);
if (orchestrationV2IdmWarning) console.warn(orchestrationV2IdmWarning);
const orchestrationV2Admit = createOrchestrationV2AdmissionService({
  config: {
    tenant_concurrency_limit: env.LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY,
    workspace_concurrency_limit: env.LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY,
    routing_shard_count: 4_096,
  },
  verifySchema: () => verifyOrchestrationV2Schema({ query }),
  // IDM rollout is decided only here, at admission; workers derive the pipeline from the stored runtime hash.
  loadRuntime: tenantId => loadOrchestrationV2AdmissionRuntime(tenantId, orchestrationV2IdmPolicy),
  createRepository: user => {
    const authority = createWorkspaceAuthority(user);
    return createOrchestrationV2AdmissionRepository({
      db: { transaction: withDatabaseTransaction },
      canEdit: (tx, target) => authority.canEdit(tx, target),
    });
  },
});
const workspaceV2Launch = createWorkspaceV2LaunchService({
  query, db: { transaction: withDatabaseTransaction }, AppError,
  prepareDurableBlueprint, withLessonAuthorConversationLock, admit: orchestrationV2Admit,
  report: event => console.info('[LessonAuthorOrchestrationV2Admission]', JSON.stringify(event)),
});
const orchestrationV2LaunchEnabled = () => env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED
  && env.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED;
const workspaceLaunch = createWorkspaceLaunchHandlers({ readEnabled:()=>env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED,
  editEnabled:()=>env.LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED,
  executionReady:()=>env.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED
    ? orchestrationV2LaunchEnabled() : isLessonAuthorWorkspaceReady(),
  db:{transaction:withDatabaseTransaction},
  create:(user,input)=>env.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED
    ? workspaceV2Launch(user,input) : createLessonAuthorWorkspace(user,input),
  report:event=>console.info('[LessonAuthorWorkspace]',JSON.stringify(event)) });
router.get('/chat/lesson-author/courses/:courseId/workspaces/latest',workspaceLaunch.latest);
router.get('/chat/lesson-author/courses/:courseId/sessions', checkPermission('courses', 'can_edit'), listLessonAuthorSessionController);
router.get('/chat/lesson-author/courses/:courseId/sessions/active-runs', checkPermission('courses', 'can_edit'), createLessonAuthorActiveRunsHandler(lessonAuthorAccess));
router.patch('/chat/lesson-author/courses/:courseId/sessions/:conversationId', checkPermission('courses', 'can_edit'), renameLessonAuthorSessionController);
router.get('/chat/lesson-author/courses/:courseId/sessions/:conversationId/delete-impact', checkPermission('courses', 'can_edit'), getLessonAuthorSessionDeleteImpactController);
router.delete('/chat/lesson-author/courses/:courseId/sessions/:conversationId', checkPermission('courses', 'can_edit'), deleteLessonAuthorSessionController);
router.get('/chat/lesson-author/courses/:courseId/session-deletions/:jobId', checkPermission('courses', 'can_edit'), getLessonAuthorSessionDeletionStatusController);
router.post('/chat/lesson-author/courses/:courseId/conversations/:conversationId/workspaces',
  lessonAuthorSessionOwnerOnly('conversationId', { courseParam: 'courseId' }), workspaceLaunch.create);
// Additive read-only workspace boundary; never falls back to generation on error.
// V2 admission is internal to the single workspace Create transaction; no second
// browser mutation route exists, so V1 and V2 cannot be launched together.
const workspaceReads = createWorkspaceReadHandlers({
  enabled: () => env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED,
  db: { query },
  canRead: user => hasPermission(user, 'courses', 'can_edit'),
  resolveSessionOwner: resolveLessonAuthorSessionOwner,
  report: record => {
    // Successful polling is intentionally quiet; failures retain safe typed metadata.
    if (record.event === 'workspace_read_failed') console.warn('[LessonAuthorWorkspace] ' + JSON.stringify(record));
  },
});
const workspaceReadPath = '/chat/lesson-author/courses/:courseId/conversations/:conversationId/workspaces/:workspaceId';
router.get(workspaceReadPath, workspaceReads.status);
router.get(`${workspaceReadPath}/events`, workspaceReads.events);
router.get(`${workspaceReadPath}/graph`, workspaceReads.graph);
router.get(`${workspaceReadPath}/nodes/:nodeId`, workspaceReads.detail);
// SSE carries only committed event metadata. Normal GET endpoints remain the
// authorization-bound snapshot/detail recovery path; this route never starts
// generation or performs a write.
router.get(`${workspaceReadPath}/stream`, createWorkspaceStreamHandler({
  enabled: () => env.LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED,
  db: { query },
  canRead: user => hasPermission(user, 'courses', 'can_edit'),
  resolveSessionOwner: resolveLessonAuthorSessionOwner,
  subscribe: (workspaceId, listener) => workspaceCommitHub.subscribe(workspaceId, listener),
  report: record => {
    const line = '[LessonAuthorWorkspaceStream] ' + JSON.stringify(record);
    if (record.event === 'workspace_stream_failed') console.warn(line); else console.info(line);
  },
}));
// Separate default-off edit gate. Use real persisted-context validators and
// transactional authority, never browser-supplied acceptance or Apply receipts.
const workspaceEdits = createWorkspaceEditHandlers({
  enabled: () => env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED && env.LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED,
  db: { transaction: withDatabaseTransaction },
  validate: createWorkspaceAcceptance({
    component: record => console.info('[LessonAuthorWorkspace] ' + JSON.stringify(record)),
    storyboard: record => console.info('[LessonAuthorWorkspace] ' + JSON.stringify(record)),
  }),
  report: record => {
    const line = '[LessonAuthorWorkspace] ' + JSON.stringify(record);
    if (record.event === 'workspace_edit_failed') console.warn(line); else console.info(line);
  },
});
router.post(`${workspaceReadPath}/nodes/:nodeId/save`, lessonAuthorSessionOwnerOnly('conversationId', { courseParam: 'courseId' }), workspaceEdits.save);
router.post(`${workspaceReadPath}/nodes/:nodeId/reset`, lessonAuthorSessionOwnerOnly('conversationId', { courseParam: 'courseId' }), workspaceEdits.reset);
// Apply has a separate hard gate from reads/editing/execution. The repository is
// the only owner of draft course-block writes and the SQL receipt/mapping proof.
const workspaceApplyRepository = createWorkspaceApplyRepository({ db: { transaction: withDatabaseTransaction },
  // Nested withDatabaseTransaction reuses the Apply transaction's client.
  audit: event => withDatabaseTransaction(client => appendAuditLog(client, {
    tenantId: event.tenantId, actorId: event.actorId, actorUsername: event.actorUsername, action: 'UPDATE',
    entityType: 'lesson_author_session', entityId: event.conversationId, entityName: event.sessionTitle || event.courseName,
    event: { code: 'lesson_author.workspace.applied_shared', context: { course_id: event.courseId, course_name: event.courseName,
      related_entity_name: event.ownerName, related_entity_type: 'lesson_author_session_creator', affected_count: event.affectedCount } },
  })) });
const workspaceApply = createWorkspaceApplyHandler({
  enabled: () => env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED && env.LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED
    && env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED && env.LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED,
  apply: (user, target, expectedWorkspaceRevision, options) => workspaceApplyRepository.apply(user, target, expectedWorkspaceRevision, options),
  report: event => console.info('[LessonAuthorWorkspace] ' + JSON.stringify(event)),
});
router.post(`${workspaceReadPath}/nodes/:nodeId/apply`, workspaceApply);
const generationJobRepository = createGenerationJobRepository({ transaction: withDatabaseTransaction });
router.get('/chat/lesson-author/conversations/:conversationId/generation-jobs/:jobId', createGenerationStatusHandler({
  enabled: () => env.LESSON_AUTHOR_GENERATION_STATUS_ENABLED || env.LESSON_AUTHOR_GENERATION_ENABLED,
  canRead: user => hasPermission(user, 'courses', 'can_edit'),
  findOwned: (owner, jobId) => generationJobRepository.findOwned(owner, jobId),
  reportFailure: record => console.warn('[LessonAuthorGeneration] ' + JSON.stringify(record)),
}));
router.post('/chat/lesson-author/conversations/:conversationId/transcriptions', observeLessonAuthorTranscriptionRequest, checkPermission('courses', 'can_edit'), lessonAuthorSessionOwnerOnly('conversationId'), parseLessonAuthorVideoUpload, transcriptCtrl.createLessonAuthorTranscription);
router.get('/chat/lesson-author/conversations/:conversationId/transcriptions/:jobId', checkPermission('courses', 'can_edit'), transcriptCtrl.getLessonAuthorTranscription);
router.get('/chat/lesson-author/conversations/:conversationId/transcriptions/:jobId/download', checkPermission('courses', 'can_edit'), transcriptCtrl.downloadLessonAuthorTranscript);
router.post('/chat/lesson-author/conversations/:conversationId/transcriptions/:jobId/commit', checkPermission('courses', 'can_edit'), lessonAuthorSessionOwnerOnly('conversationId'), transcriptCtrl.commitLessonAuthorTranscript);
router.get('/chat/conversations', allowRuntimeChatTarget, lessonAuthorCourseEditor, chatCtrl.listConversations);
router.post('/chat/conversations', allowRuntimeChatTarget, lessonAuthorCourseEditor, chatCtrl.createConversation);
router.delete('/chat/conversations/:id', allowRuntimeChatTarget, chatCtrl.deleteConversation);
router.get('/chat/conversations/:id/messages', allowRuntimeChatTarget, lessonAuthorCourseEditor, chatCtrl.getMessages);
router.post('/chat/conversations/:id/report-pdf', allowRuntimeChatTarget, checkPermission('report_summary', 'can_view'), reportPdfHandlers.exportReportPdf);
router.post('/chat/conversations/:id/report-pdf/jobs', allowRuntimeChatTarget, checkPermission('report_summary', 'can_view'), reportPdfHandlers.startReportPdfJob);
router.get('/chat/conversations/:id/report-pdf/jobs/:jobId', allowRuntimeChatTarget, checkPermission('report_summary', 'can_view'), reportPdfHandlers.getReportPdfJob);
router.get('/chat/conversations/:id/report-pdf/jobs/:jobId/download', allowRuntimeChatTarget, checkPermission('report_summary', 'can_view'), reportPdfHandlers.downloadReportPdfJob);
router.post('/chat/conversations/:id/messages', allowRuntimeChatTarget, lessonAuthorCourseEditor, lessonAuthorSessionOwnerOnly('id'), chatCtrl.sendMessage);

export default router;
