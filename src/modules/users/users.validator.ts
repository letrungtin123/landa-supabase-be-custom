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
  // Avatars are set only by the avatar upload (server-generated path); null clears it.
  avatar_url: z.null({ invalid_type_error: 'Ảnh đại diện chỉ được thay bằng cách tải ảnh lên' }).optional(),
  role: z.enum(['learner', 'learner_plus', 'staff', 'superuser', 'superadmin']).optional(),
  is_active: z.boolean().optional(),
});

/** Schema gán user vào permission groups */
export const assignGroupsSchema = z.object({
  permission_group_ids: z.array(z.string().uuid()).max(1, 'Mỗi thành viên chỉ được thuộc tối đa một nhóm quyền'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ── Query strings ──
// The query string of GET /api/users, read the way listUsers always read it.
// It never rejects and never coerces: every request accepted before is
// accepted with the same values (a repeated parameter stays a list). Only the
// keys the service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/users */
export const userListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  role: rawQueryValue,
  is_active: rawQueryValue,
  permission_group_id: rawQueryValue,
  include_team_assignments: rawQueryValue,
  current_team_id: rawQueryValue,
});
