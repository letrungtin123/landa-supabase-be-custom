import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { ssoExchangeIpLimiter } from '../../middleware/auth-rate-limit.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  deleteConfigController,
  exchangeController,
  getPublicByDomainController,
  listConfigsController,
  updateConfigController,
} from './sso.controller.js';

const router = Router();

router.get('/public/by-domain/:domain', getPublicByDomainController);
// A sign-in: refused exchanges per IP instead of the general per-IP API limit.
router.post('/exchange/:provider', ssoExchangeIpLimiter, exchangeController);

router.use(authenticate, tenantContext, authorize('superadmin'));
router.get('/configs', listConfigsController);
router.put('/configs/:provider', updateConfigController);
router.delete('/configs/:provider', deleteConfigController);

export default router;
