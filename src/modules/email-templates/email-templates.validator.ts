// ═══════════════════════════════════════════════════════════════
// Email Templates Validator — Zod schema of the template body
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Code of a refused email template body (docs/error-codes.md). */
export const EMAIL_TEMPLATE_INPUT_INVALID_CODE = 'EMAIL_TEMPLATE_INPUT_INVALID';
export const EMAIL_TEMPLATE_INPUT_REQUIRED_MESSAGE = 'Vui lòng nhập tiêu đề, mô tả ngắn và nội dung email.';

/**
 * PUT /api/email-templates/:key: the body must be a JSON object (no JSON body
 * used to fail with a 500). Each field keeps the service's own checks and
 * messages (text, not empty, length, placeholders).
 */
export const emailTemplateBodySchema = z.object(
  {
    subject_template: z.unknown(),
    preheader_template: z.unknown(),
    body_template: z.unknown(),
  },
  { required_error: EMAIL_TEMPLATE_INPUT_REQUIRED_MESSAGE, invalid_type_error: EMAIL_TEMPLATE_INPUT_REQUIRED_MESSAGE },
);
