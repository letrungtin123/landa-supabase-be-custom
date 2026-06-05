// ═══════════════════════════════════════════════════════════════
// Tenants Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Sanitize domain: strip protocol, port, path, whitespace */
const domainField = z.string().max(255)
  .transform((val) => val.replace(/^https?:\/\//, '').replace(/[:/].*$/, '').trim().toLowerCase())
  .pipe(z.string().regex(/^[a-zA-Z0-9.-]*$/, 'Domain chỉ chứa chữ, số, dấu chấm và gạch ngang'))
  .nullable().optional();

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tên tenant không được để trống').max(255),
  slug: z.string().min(1, 'Slug không được để trống').max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  domain: domainField,
  settings: z.record(z.unknown()).optional(),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  domain: domainField,
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
