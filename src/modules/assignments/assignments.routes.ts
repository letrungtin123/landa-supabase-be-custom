import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import * as ctrl from './assignments.controller.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 5,
  },
});

router.use(authenticate);

// Private assignment files. Authorization is checked per file in the service.
router.get('/files/:fileId', ctrl.downloadFile);

// Learner-facing APIs.
router.get('/learner/courses/:courseId', ctrl.listLearnerCourseAssignments);
router.get('/learner/:assignmentId', ctrl.getLearnerAssignment);
router.post('/learner/:assignmentId/submit', upload.array('files', 5), ctrl.submitAssignment);

// Admin-facing APIs.
router.use(tenantContext);
router.get('/courses/:courseId', checkPermission('courses', 'can_view'), ctrl.listCourseAssignments);
router.post('/courses/:courseId', checkPermission('courses', 'can_add'), ctrl.createAssignment);
router.post('/courses/:courseId/reorder', checkPermission('courses', 'can_edit'), ctrl.reorderAssignments);
router.get('/courses/:courseId/submissions', checkPermission('courses', 'can_view'), ctrl.listCourseSubmissions);
router.patch('/:assignmentId', checkPermission('courses', 'can_edit'), ctrl.updateAssignment);
router.delete('/:assignmentId', checkPermission('courses', 'can_delete'), ctrl.deleteAssignment);
router.post('/submissions/:submissionId/feedback', checkPermission('courses', 'can_edit'), upload.array('feedback_files', 5), ctrl.feedbackSubmission);

export default router;

