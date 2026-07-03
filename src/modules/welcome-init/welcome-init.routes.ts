import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import {
  getWelcomeInitStateController,
  markWelcomeInitSeenController,
} from './welcome-init.controller.js';

const router = Router();

router.use(authenticate);
router.get('/state', getWelcomeInitStateController);
router.post('/seen', markWelcomeInitSeenController);

export default router;
