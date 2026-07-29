// ═══════════════════════════════════════════════════════════════
// Reports Routes
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import * as ctrl from './reports.controller.js';

const router = Router();

// All reports require auth + tenant + report_summary permission
router.use(authenticate, tenantContext);

router.get('/summary', checkPermission('report_summary', 'can_view'), ctrl.getSummary);
router.get('/chart', checkPermission('report_summary', 'can_view'), ctrl.getChart);
router.get('/top-courses', checkPermission('report_summary', 'can_view'), ctrl.getTopCourses);
router.get('/course-completion-ranking', checkPermission('report_summary', 'can_view'), ctrl.getCourseCompletionRanking);
router.get('/course-completion-ranking/:courseId/learners', checkPermission('report_summary', 'can_view'), ctrl.getCourseCompletionLearners);
router.get('/learners', checkPermission('report_summary', 'can_view'), ctrl.getLearners);
router.get('/export.xlsx', checkPermission('report_summary', 'can_view'), ctrl.exportExcel);
router.get('/learner-detail', checkPermission('report_summary', 'can_view'), ctrl.getLearnerDetail);
router.get('/user-badges', checkPermission('report_summary', 'can_view'), ctrl.getUserBadges);
router.get('/user-study-time', checkPermission('report_summary', 'can_view'), ctrl.getUserStudyTime);

// Group/subgroup filter cho report (dùng quyền report_summary, không cần quyền groups)
router.get('/groups', checkPermission('report_summary', 'can_view'), ctrl.getReportGroups);
router.get('/groups/:groupId/subgroups', checkPermission('report_summary', 'can_view'), ctrl.getReportSubGroups);
router.get('/groups/:groupId/subgroups/:subgroupId/teams', checkPermission('report_summary', 'can_view'), ctrl.getReportTeams);

// Admin-only: manually refresh materialized view
router.post('/refresh', checkPermission('report_summary', 'can_edit'), ctrl.refreshSummary);

export default router;
