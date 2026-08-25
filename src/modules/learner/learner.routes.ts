// ═══════════════════════════════════════════════════════════════
// Learner Routes — /api/learner/*
// Authenticated, any role (learner/staff/superuser/superadmin)
// tenant_id lấy từ JWT token (req.user.tenant_id)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import * as ctrl from './learner.controller.js';

const router = Router();

// Tất cả routes yêu cầu xác thực
router.use(authenticate, tenantContext);

// ── Courses ──
router.get('/courses', ctrl.listCourses);
router.get('/courses/:courseId', ctrl.getCourseDetail);
router.get('/courses/:courseId/blocks', ctrl.getCourseBlocks);
router.get('/courses/:courseId/files', ctrl.getCourseFiles);

// ── Course Modals (Welcome / Confirm / Complete) ──
router.get('/courses/:courseId/modal-config', ctrl.getCourseModalConfig);
router.get('/courses/:courseId/modal-state', ctrl.getCourseModalState);
router.patch('/courses/:courseId/modal-state', ctrl.updateCourseModalState);

// ── Section Modals (Khích lệ từng section) ──
router.get('/courses/:courseId/section-modal-configs', ctrl.getSectionModalConfigs);
router.get('/courses/:courseId/section-modal-shown', ctrl.getSectionModalShown);
router.post('/courses/:courseId/section-modal-shown', ctrl.markSectionModalShown);

// ── Library (Kho tài liệu nội bộ) ──
router.get('/library/categories', ctrl.getLibraryCategories);
router.get('/library/documents', ctrl.getLibraryDocuments);

// ── Single Block Detail ──
router.get('/blocks/:blockId', ctrl.getBlockDetail);
router.post('/blocks/:blockId/submit', ctrl.submitBlockAnswer);

// ── Enrollments ──
router.get('/enrollments', ctrl.listEnrollments);
router.post('/enroll', ctrl.enroll);

// ── Block Completion ──
router.post('/complete-blocks', ctrl.completeBlocks);

// ── Progress ──
router.get('/progress-batch', ctrl.getBatchProgress);
router.get('/progress/:courseId', ctrl.getProgress);

// ── Badges ──
router.get('/badges', ctrl.listBadges);
router.get('/badges/active', ctrl.getActiveBadges);
router.post('/badges/evaluate', ctrl.evaluateBadges);
router.post('/badges', ctrl.saveBadge);
router.patch('/badges', ctrl.updateBadge);
router.patch('/badges/:badgeId/shown', ctrl.updateBadgeShown);

// ── Notifications ──
router.get('/notifications', ctrl.listNotifications);
router.get('/notifications/unread-count', ctrl.getUnreadCount);
router.patch('/notifications/read-all', ctrl.markAllRead);
router.patch('/notifications/:id/read', ctrl.markRead);

export default router;
