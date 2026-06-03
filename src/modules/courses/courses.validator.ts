// ═══════════════════════════════════════════════════════════════
// Courses Validator — Zod schemas for input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema tạo course */
export const createCourseSchema = z.object({
  display_name: z.string().min(1, 'display_name là bắt buộc').max(500),
  description: z.string().max(5000).optional(),
  is_active: z.boolean().optional(),
  cover_url: z.string().max(1000).optional(),
});

/** Schema cập nhật course */
export const updateCourseSchema = z.object({
  display_name: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  is_active: z.boolean().optional(),
  cover_url: z.string().max(1000).optional(),
  start_date: z.string().optional(),
  end_date: z.string().nullable().optional(),
}).refine(data => Object.keys(data).length > 0, 'Cần ít nhất 1 field để cập nhật');

/** Schema bulk action */
export const bulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'ids không được rỗng').max(100, 'Tối đa 100 items'),
  action: z.enum(['activate', 'deactivate', 'delete']),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type BulkActionInput = z.infer<typeof bulkActionSchema>;
