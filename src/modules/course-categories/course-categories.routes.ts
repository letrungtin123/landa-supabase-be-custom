import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listController, createController, updateController, deleteController,
  getCoursesController, addCoursesController, removeCourseController,
} from './course-categories.controller.js';

const router = Router();
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('course_categories', 'can_view'), listController);
router.post('/', checkPermission('course_categories', 'can_add'), createController);
router.put('/:id', checkPermission('course_categories', 'can_edit'), updateController);
router.delete('/:id', checkPermission('course_categories', 'can_delete'), deleteController);
router.get('/:id/courses', checkPermission('course_categories', 'can_view'), getCoursesController);
router.post('/:id/courses', checkPermission('course_categories', 'can_edit'), addCoursesController);
router.delete('/:id/courses/:courseId', checkPermission('course_categories', 'can_edit'), removeCourseController);

export default router;
