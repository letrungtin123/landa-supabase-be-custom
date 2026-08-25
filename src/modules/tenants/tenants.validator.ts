// ═══════════════════════════════════════════════════════════════
// Tenants Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { COURSE_COMPONENT_TYPES } from './tenant-course-components.constants.js';

/** Sanitize domain: full URL với protocol (http:// hoặc https://), bỏ trailing slash */
const domainField = z.string().max(255)
  .transform(s => s.trim().replace(/\/+$/, ''))
  .pipe(z.string().regex(/^https?:\/\/[a-z0-9]([a-z0-9.:@-]*[a-z0-9])?$/i, 'Nhập đầy đủ URL. Ví dụ: https://lms.nesso.com.vn'))
  .nullable().optional();

export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tên tenant không được để trống').max(255),
  slug: z.string().min(1, 'Slug không được để trống').max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug chỉ chứa chữ thường, số và dấu gạch ngang'),
  domain_learner: domainField,
  domain_admin: domainField,
  max_users: z.number().int().min(0, 'Giới hạn user phải >= 0').nullable().optional(),
  max_courses: z.number().int().min(0, 'Giới hạn course phải >= 0').nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  domain_learner: domainField,
  domain_admin: domainField,
  max_users: z.number().int().min(0).nullable().optional(),
  max_courses: z.number().int().min(0).nullable().optional(),
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

export const updateTenantCourseComponentPermissionsSchema = z.object({
  allowed_component_types: z.array(z.enum(COURSE_COMPONENT_TYPES)),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type UpdateTenantModulesInput = z.infer<typeof updateTenantModulesSchema>;
export type UpdateTenantCourseComponentPermissionsInput = z.infer<typeof updateTenantCourseComponentPermissionsSchema>;
