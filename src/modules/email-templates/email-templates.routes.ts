import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import * as ctrl from './email-templates.controller.js';

const router = Router();

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('email_templates', 'can_view'), ctrl.list);
router.post('/:key/preview', checkPermission('email_templates', 'can_view'), ctrl.preview);
router.put('/:key', checkPermission('email_templates', 'can_edit'), ctrl.update);
router.post('/:key/reset', checkPermission('email_templates', 'can_edit'), ctrl.reset);

export default router;
