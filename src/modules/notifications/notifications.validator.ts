// ═══════════════════════════════════════════════════════════════
// Notifications Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema tạo notification */
export const createNotificationSchema = z.object({
  title: z.string().min(1, 'Tiêu đề là bắt buộc').max(500),
  content: z.string().min(1, 'Nội dung là bắt buộc').max(10000),
  type: z.enum(['info', 'warning', 'success', 'error']).default('info'),
  recipient_ids: z.array(z.string().uuid()).max(1000, 'Tối đa 1000 người nhận').optional(),
  send_to_all: z.boolean().optional(),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
