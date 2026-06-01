// ═══════════════════════════════════════════════════════════════
// Enrollments Routes
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import * as ctrl from './enrollments.controller.js';

const router = Router();

// All routes require auth + tenant
router.use(authenticate, tenantContext);

// Enroll / Unenroll
router.post('/', checkPermission('enrollments', 'can_edit'), ctrl.enroll);
router.delete('/', checkPermission('enrollments', 'can_edit'), ctrl.unenroll);

// Progress
router.patch('/progress', checkPermission('enrollments', 'can_edit'), ctrl.updateProgress);

// Study session (learner can self-report)
router.post('/study-session', ctrl.recordStudySession);

// Queries
router.get('/user/:userId', checkPermission('enrollments', 'can_view'), ctrl.getUserEnrollments);
router.get('/course/:courseId', checkPermission('enrollments', 'can_view'), ctrl.getCourseEnrollments);

export default router;
