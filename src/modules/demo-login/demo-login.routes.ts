import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  bootstrapPublicIframeController,
  claimPublicAccountController,
  deleteAccountController,
  getAdminIframeConfigController,
  getAdminConfigController,
  listPublicAccountsController,
  regenerateAdminIframeEmbedController,
  replaceAccountsController,
  searchEligibleIframeLearnersController,
  searchEligibleLearnersController,
  updateAdminIframeConfigController,
  updateAdminConfigController,
} from './demo-login.controller.js';

const router = Router();

router.get('/public/by-domain/:domain/accounts', listPublicAccountsController);
router.post('/public/by-domain/:domain/claim', claimPublicAccountController);
router.post('/public/iframe/:embedId/bootstrap', bootstrapPublicIframeController);

router.use(authenticate, authorize('superadmin'));
router.get('/admin/:tenantId/config', getAdminConfigController);
router.put('/admin/:tenantId/config', updateAdminConfigController);
router.get('/admin/:tenantId/eligible-learners', searchEligibleLearnersController);
router.put('/admin/:tenantId/accounts', replaceAccountsController);
router.delete('/admin/:tenantId/accounts/:publicId', deleteAccountController);
router.get('/admin/:tenantId/iframe', getAdminIframeConfigController);
router.put('/admin/:tenantId/iframe', updateAdminIframeConfigController);
router.post('/admin/:tenantId/iframe/regenerate', regenerateAdminIframeEmbedController);
router.get('/admin/:tenantId/iframe/eligible-learners', searchEligibleIframeLearnersController);

export default router;
