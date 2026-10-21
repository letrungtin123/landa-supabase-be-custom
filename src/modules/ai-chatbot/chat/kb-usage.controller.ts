// HTTP side of the exclusive knowledge base rule (kb-usage.logic.ts).

import type { Request, Response } from 'express';
import { requestUiLocaleOf, sendClientError } from '../../../utils/client-error.js';
import { sendError, sendSuccess } from '../../../utils/response.js';
import { AI_CHATBOT_KB_ALREADY_USED_CODE } from './kb-usage.logic.js';
import { KbUsageClashError, kbUsageGuard } from './kb-usage.service.js';

/**
 * Answers a refused knowledge base usage write: 409 AI_CHATBOT_KB_ALREADY_USED in the sendError shape,
 * the message in the UI language (X-UI-Locale, Vietnamese by default). false for any other error.
 */
export function sendKbUsageClash(req: Request, res: Response, error: unknown): boolean {
  if (!(error instanceof KbUsageClashError)) return false;
  sendError(res, error.localized(requestUiLocaleOf(req)), 409, AI_CHATBOT_KB_ALREADY_USED_CODE);
  return true;
}

/**
 * GET /kb-usage-conflicts: the knowledge bases the tenant already uses in two or more places
 * (`{ conflicts: [{ kb_id, kb_name, used_by }] }`), so the deployment page can ask the admin to reassign.
 */
export async function getKbUsageConflicts(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, { conflicts: await kbUsageGuard.listConflicts(req.user!.tenantId!) });
  } catch (err) { sendClientError(req, res, err, 'Chat'); }
}
