// ═══════════════════════════════════════════════════════════════
// Permissions Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createPermGroupSchema = z.object({
  name: z.string().min(1, 'Tên nhóm quyền không được để trống').max(100),
  description: z.string().max(500).optional(),
});

export const updatePermGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

/** Schema cập nhật ma trận permissions (bulk) */
export const updatePermissionsMatrixSchema = z.object({
  permissions: z.array(z.object({
    module_code: z.string().min(1),
    can_view: z.boolean(),
    can_add: z.boolean(),
    can_edit: z.boolean(),
    can_delete: z.boolean(),
  })),
});

export type CreatePermGroupInput = z.infer<typeof createPermGroupSchema>;
export type UpdatePermGroupInput = z.infer<typeof updatePermGroupSchema>;
export type UpdatePermissionsMatrixInput = z.infer<typeof updatePermissionsMatrixSchema>;
