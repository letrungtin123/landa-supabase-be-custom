// ═══════════════════════════════════════════════════════════════
// Tenants Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tên tenant không được để trống').max(255),
  slug: z.string().min(1, 'Slug không được để trống').max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  settings: z.record(z.unknown()).optional(),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  is_active: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
});

/** Schema cập nhật ma trận modules cho tenant */
export const updateTenantModulesSchema = z.object({
  modules: z.array(z.object({
    module_id: z.string().uuid(),
    is_enabled: z.boolean(),
  })),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type UpdateTenantModulesInput = z.infer<typeof updateTenantModulesSchema>;
