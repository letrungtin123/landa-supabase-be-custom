// Who may read a tenant's AI usage (GET /api/ai-credits/usage). Owner rule:
// the same as the AI Chatbot module pages (superadmin always; superuser when
// the tenant has ai_chatbot turned on; staff when the module is on and their
// permission group can view ai_chatbot), and never learner_plus or learner,
// whatever their permission group says.
import type { NextFunction, Request, Response } from 'express';
import { checkPermission } from '../../middleware/authorize.js';

export const AI_USAGE_FORBIDDEN_CODE = 'AI_USAGE_FORBIDDEN';

/** [HTTP status, Vietnamese, English] — picked by X-UI-Locale like the permission refusals. */
export const AI_USAGE_FORBIDDEN_ERROR = [
  403,
  'Bạn không có quyền xem mức dùng AI.',
  'You do not have permission to see AI usage.',
] as const;

const LEARNER_ROLES = new Set(['learner', 'learner_plus']);

/** Learners never see billing data, even with an ai_chatbot permission. */
export function refuseLearnersForAiUsage(req: Request, res: Response, next: NextFunction): void {
  if (req.user && LEARNER_ROLES.has(req.user.role)) {
    const [status, vi, en] = AI_USAGE_FORBIDDEN_ERROR;
    const english = req.get?.('X-UI-Locale')?.trim().toLowerCase() === 'en';
    res.status(status).json({ success: false, code: AI_USAGE_FORBIDDEN_CODE, message: english ? en : vi });
    return;
  }
  next();
}

/** Runs after authenticate + tenantContext: learners out, then the AI Chatbot module view rule. */
export const aiUsageAccess = [refuseLearnersForAiUsage, checkPermission('ai_chatbot', 'can_view')] as const;
