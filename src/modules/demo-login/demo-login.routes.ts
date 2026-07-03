import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  claimPublicAccountController,
  deleteAccountController,
  getAdminConfigController,
  listPublicAccountsController,
  replaceAccountsController,
  searchEligibleLearnersController,
  updateAdminConfigController,
} from './demo-login.controller.js';

const router = Router();

router.get('/public/by-domain/:domain/accounts', listPublicAccountsController);
router.post('/public/by-domain/:domain/claim', claimPublicAccountController);

router.use(authenticate, authorize('superadmin'));
router.get('/admin/:tenantId/config', getAdminConfigController);
router.put('/admin/:tenantId/config', updateAdminConfigController);
router.get('/admin/:tenantId/eligible-learners', searchEligibleLearnersController);
router.put('/admin/:tenantId/accounts', replaceAccountsController);
router.delete('/admin/:tenantId/accounts/:publicId', deleteAccountController);

export default router;
