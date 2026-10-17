import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { sendError } from '../../utils/response.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import * as ctrl from './assignments.controller.js';

const router = Router();

const ASSIGNMENT_UPLOAD_LIMITS = {
  fileSize: 25 * 1024 * 1024,
  files: 5,
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: ASSIGNMENT_UPLOAD_LIMITS,
});

// Learner submissions (up to 5 x 25 MB each, many at a deadline) go to the OS
// temp dir instead of the heap and are streamed to Storage; the controller
// removes the temp files when the request ends.
export const ASSIGNMENT_SUBMISSION_TEMP_DIR = path.join(os.tmpdir(), 'landa-assignment-submissions');
export const submissionUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(ASSIGNMENT_SUBMISSION_TEMP_DIR, { recursive: true }, (error) => cb(error ?? null, ASSIGNMENT_SUBMISSION_TEMP_DIR));
    },
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomUUID()}.upload`),
  }),
  limits: ASSIGNMENT_UPLOAD_LIMITS,
});

function blockDemoIframeAssignmentSubmit(req: Request, res: Response, next: NextFunction): void {
  if (isDemoIframeSession(req.user)) {
    sendError(res, 'Phiên demo iframe không thể nộp assignment', 403);
    return;
  }
  next();
}

router.use(authenticate);

// Private assignment files. Authorization is checked per file in the service.
router.get('/files/:fileId', ctrl.downloadFile);

// Learner-facing APIs.
router.get('/learner/courses/:courseId', ctrl.listLearnerCourseAssignments);
router.get('/learner/:assignmentId', ctrl.getLearnerAssignment);
router.post('/learner/:assignmentId/submit', blockDemoIframeAssignmentSubmit, submissionUpload.array('files', 5), ctrl.submitAssignment);

// Admin-facing APIs.
router.use(tenantContext);
router.get('/courses/:courseId', checkPermission('courses', 'can_view'), ctrl.listCourseAssignments);
router.post('/courses/:courseId', checkPermission('courses', 'can_add'), upload.single('attachment_file'), ctrl.createAssignment);
router.post('/courses/:courseId/reorder', checkPermission('courses', 'can_edit'), ctrl.reorderAssignments);
router.get('/courses/:courseId/submissions', checkPermission('courses', 'can_view'), ctrl.listCourseSubmissions);
router.patch('/:assignmentId', checkPermission('courses', 'can_edit'), upload.single('attachment_file'), ctrl.updateAssignment);
router.delete('/:assignmentId', checkPermission('courses', 'can_delete'), ctrl.deleteAssignment);
router.get('/submissions/:submissionId/feedback-history', checkPermission('courses', 'can_view'), ctrl.listSubmissionFeedbackHistory);
router.post('/submissions/:submissionId/feedback', checkPermission('courses', 'can_edit'), upload.array('feedback_files', 5), ctrl.feedbackSubmission);

export default router;
