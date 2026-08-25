import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import * as controller from './tenant-badges.controller.js';

const router = Router();

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('badge_management', 'can_view'), controller.listBadges);
router.get('/courses', checkPermission('badge_management', 'can_view'), controller.listCourses);
router.put('/:badgeId', checkPermission('badge_management', 'can_edit'), controller.updateBadge);

export default router;
