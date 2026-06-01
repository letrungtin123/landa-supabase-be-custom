// ═══════════════════════════════════════════════════════════════
// Learner Routes — /api/learner/*
// Authenticated, any role (learner/staff/superuser/superadmin)
// tenant_id lấy từ JWT token (req.user.tenant_id)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as ctrl from './learner.controller.js';

const router = Router();

// Tất cả routes yêu cầu xác thực
router.use(authenticate);

// ── Courses ──
router.get('/courses', ctrl.listCourses);
router.get('/courses/:courseId', ctrl.getCourseDetail);
router.get('/courses/:courseId/blocks', ctrl.getCourseBlocks);

// ── Enrollments ──
router.get('/enrollments', ctrl.listEnrollments);
router.post('/enroll', ctrl.enroll);

// ── Block Completion ──
router.post('/complete-blocks', ctrl.completeBlocks);

// ── Progress ──
router.get('/progress/:courseId', ctrl.getProgress);

// ── Badges ──
router.get('/badges', ctrl.listBadges);
router.post('/badges', ctrl.saveBadge);
router.patch('/badges', ctrl.updateBadge);

// ── Notifications ──
router.get('/notifications', ctrl.listNotifications);
router.get('/notifications/unread-count', ctrl.getUnreadCount);
router.patch('/notifications/:id/read', ctrl.markRead);
router.patch('/notifications/read-all', ctrl.markAllRead);

export default router;
