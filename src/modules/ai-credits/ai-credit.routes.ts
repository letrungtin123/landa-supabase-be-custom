import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import * as controller from './ai-credit.controller.js';

const router = Router();

// Tenant admins: the AI usage page of their tenant (a superadmin sees the tenant chosen in the switcher).
router.get('/usage', authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'), controller.getUsage);

// Superadmin: plans, plan per tenant, top-ups, FX, overview and reconciliation (platform billing).
const admin = Router();
admin.use(authenticate, authorize('superadmin'));
admin.get('/plans', controller.listPlans);
admin.post('/plans', controller.createPlan);
admin.put('/plans/:planId', controller.updatePlan);
admin.get('/fx', controller.listFx);
admin.put('/fx/:month', controller.setFx);
admin.get('/overview', controller.overview);
admin.get('/tenants/:tenantId/usage', controller.tenantUsage);
admin.get('/tenants/:tenantId/plan', controller.tenantPlan);
admin.put('/tenants/:tenantId/plan', controller.setTenantPlan);
admin.post('/tenants/:tenantId/topups', controller.addTopup);
admin.put('/tenants/:tenantId/months/:month/reconciliation', controller.reconcile);
router.use('/admin', admin);

export default router;
