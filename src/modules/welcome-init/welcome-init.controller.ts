import type { NextFunction, Request, Response } from 'express';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as welcomeInitService from './welcome-init.service.js';

export async function getWelcomeInitStateController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    const result = await welcomeInitService.getWelcomeInitState(
      req.user.id,
      req.user.sessionMode === 'demo_iframe',
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function markWelcomeInitSeenController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    const result = await welcomeInitService.markWelcomeInitSeen(
      req.user.id,
      req.user.tenantId || null,
      req.user.sessionMode === 'demo_iframe',
    );
    sendSuccess(res, result, 'Đã ghi nhận welcome_init');
  } catch (err) {
    next(err);
  }
}
