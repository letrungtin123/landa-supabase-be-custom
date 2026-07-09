// ═══════════════════════════════════════════════════════════════
// Notifications Routes
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import * as ctrl from './notifications.controller.js';

const router = Router();

router.use(authenticate, tenantContext);

router.get('/smtp-status', checkPermission('courses', 'can_view'), ctrl.smtpStatus);
router.post('/', checkPermission('courses', 'can_edit'), ctrl.send);
router.get('/', checkPermission('courses', 'can_view'), ctrl.list);

export default router;
