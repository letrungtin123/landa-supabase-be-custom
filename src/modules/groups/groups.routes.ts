// ═══════════════════════════════════════════════════════════════
// Groups Routes — /api/groups/*
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listOrgGroupsController, createOrgGroupController, updateOrgGroupController, deleteOrgGroupController,
  listSubGroupsController, createSubGroupController, getSubGroupDetailController, updateSubGroupController, deleteSubGroupController,
  listTeamsController, createTeamController, getTeamDetailController, updateTeamController, deleteTeamController,
  addTeamMembersController, removeTeamMemberController,
  assignTeamCoursesController, revokeTeamCourseController,
  assignTeamDocCategoriesController, revokeTeamDocCategoryController,
  assignTeamCourseCategoriesController, revokeTeamCourseCategoryController,
  groupAuditLogsController,
} from './groups.controller.js';

const router = Router();
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

// Org Groups
router.get('/', checkPermission('groups', 'can_view'), listOrgGroupsController);
router.post('/', checkPermission('groups', 'can_add'), createOrgGroupController);
router.patch('/:id', checkPermission('groups', 'can_edit'), updateOrgGroupController);
router.delete('/:id', checkPermission('groups', 'can_delete'), deleteOrgGroupController);

// Sub Groups
router.get('/:groupId/subgroups', checkPermission('groups', 'can_view'), listSubGroupsController);
router.post('/:groupId/subgroups', checkPermission('groups', 'can_add'), createSubGroupController);
router.get('/subgroups/:id', checkPermission('groups', 'can_view'), getSubGroupDetailController);
router.patch('/subgroups/:id', checkPermission('groups', 'can_edit'), updateSubGroupController);
router.delete('/subgroups/:id', checkPermission('groups', 'can_delete'), deleteSubGroupController);

// Teams
router.get('/subgroups/:subgroupId/teams', checkPermission('groups', 'can_view'), listTeamsController);
router.post('/subgroups/:subgroupId/teams', checkPermission('groups', 'can_add'), createTeamController);
router.get('/teams/:id', checkPermission('groups', 'can_view'), getTeamDetailController);
router.patch('/teams/:id', checkPermission('groups', 'can_edit'), updateTeamController);
router.delete('/teams/:id', checkPermission('groups', 'can_delete'), deleteTeamController);

// Team Members
router.post('/teams/:teamId/members', checkPermission('groups', 'can_edit'), addTeamMembersController);
router.delete('/teams/:teamId/members/:userId', checkPermission('groups', 'can_edit'), removeTeamMemberController);

// Team Courses
router.post('/teams/:teamId/courses', checkPermission('groups', 'can_edit'), assignTeamCoursesController);
router.delete('/teams/:teamId/courses/:courseId', checkPermission('groups', 'can_edit'), revokeTeamCourseController);

// Team Doc Categories
router.post('/teams/:teamId/categories', checkPermission('groups', 'can_edit'), assignTeamDocCategoriesController);
router.delete('/teams/:teamId/categories/:categoryId', checkPermission('groups', 'can_edit'), revokeTeamDocCategoryController);

// Team Course Categories
router.post('/teams/:teamId/course-categories', checkPermission('groups', 'can_edit'), assignTeamCourseCategoriesController);
router.delete('/teams/:teamId/course-categories/:categoryId', checkPermission('groups', 'can_edit'), revokeTeamCourseCategoryController);

// Group Audit Logs
router.get('/audit-logs', checkPermission('groups', 'can_view'), groupAuditLogsController);

export default router;
