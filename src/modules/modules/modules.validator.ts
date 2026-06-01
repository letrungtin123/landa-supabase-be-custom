// ═══════════════════════════════════════════════════════════════
// Modules Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createModuleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Code chỉ chứa chữ thường và underscore'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  sort_order: z.number().int().min(0).optional(),
});

export const updateModuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});

export type CreateModuleInput = z.infer<typeof createModuleSchema>;
export type UpdateModuleInput = z.infer<typeof updateModuleSchema>;
