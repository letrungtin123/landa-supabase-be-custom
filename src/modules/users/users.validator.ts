// ═══════════════════════════════════════════════════════════════
// Users Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createUserSchema = z.object({
  username: z.string().min(3, 'Username tối thiểu 3 ký tự').max(150),
  email: z.string().email('Email không hợp lệ').max(255),
  password: z.string().min(6, 'Password tối thiểu 6 ký tự'),
  full_name: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  role: z.enum(['learner', 'learner_plus', 'staff', 'superuser', 'superadmin']).default('learner'),
  tenant_id: z.string().uuid('Tenant ID không hợp lệ').optional(),
});

export const updateUserSchema = z.object({
  username: z.string().min(3).max(150).optional(),
  email: z.string().email().max(255).optional(),
  password: z.string().min(6).optional(),
  full_name: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  avatar_url: z.string().url().nullable().optional(),
  role: z.enum(['learner', 'learner_plus', 'staff', 'superuser', 'superadmin']).optional(),
  is_active: z.boolean().optional(),
});

/** Schema gán user vào permission groups */
export const assignGroupsSchema = z.object({
  permission_group_ids: z.array(z.string().uuid()),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
