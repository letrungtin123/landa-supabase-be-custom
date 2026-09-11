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

const permissionMatrixBaseSchema = z.object({
  permissions: z.array(z.object({
    module_code: z.string().trim().min(1).max(100),
    can_view: z.boolean(),
    can_add: z.boolean(),
    can_edit: z.boolean(),
    can_delete: z.boolean(),
  })).max(200, 'Ma trận quyền vượt quá giới hạn'),
});

function validatePermissionMatrix(
  value: z.infer<typeof permissionMatrixBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  value.permissions.forEach((permission, index) => {
    if (permission.module_code === 'permission_groups') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', index, 'module_code'],
        message: 'Không thể cấu hình quyền cho tính năng Nhóm quyền',
      });
    }
    if (seen.has(permission.module_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', index, 'module_code'],
        message: 'Mỗi tính năng chỉ được xuất hiện một lần trong ma trận quyền',
      });
    }
    seen.add(permission.module_code);
  });
}

/** Schema cập nhật ma trận permissions (bulk) */
export const updatePermissionsMatrixSchema = permissionMatrixBaseSchema.superRefine(validatePermissionMatrix);

const permissionGroupMemberIdsSchema = z.array(z.string().uuid()).max(100, 'Chỉ có thể thay đổi tối đa 100 thành viên trong một lần lưu');

export const addPermissionGroupMembersSchema = permissionGroupMemberIdsSchema
  .min(1, 'Cần chọn ít nhất một thành viên')
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Danh sách thành viên thêm bị trùng' });
    }
  });

export const permissionGroupIdentifierSchema = z.string().uuid('Mã nhóm quyền không hợp lệ');

/** Lưu đồng thời ma trận và thành viên, tránh trạng thái chỉ lưu một phần. */
export const savePermGroupConfigurationSchema = z.object({
  permissions: permissionMatrixBaseSchema.shape.permissions,
  add_user_ids: permissionGroupMemberIdsSchema.default([]),
  remove_user_ids: permissionGroupMemberIdsSchema.default([]),
}).superRefine((value, ctx) => {
  validatePermissionMatrix(value, ctx);
  const addIds = new Set(value.add_user_ids);
  const removeIds = new Set(value.remove_user_ids);

  if (addIds.size !== value.add_user_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['add_user_ids'], message: 'Danh sách thành viên thêm bị trùng' });
  }
  if (removeIds.size !== value.remove_user_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remove_user_ids'], message: 'Danh sách thành viên xóa bị trùng' });
  }
  for (const userId of addIds) {
    if (removeIds.has(userId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remove_user_ids'], message: 'Một thành viên không thể vừa được thêm vừa bị xóa trong cùng lần lưu' });
      break;
    }
  }
});

export type CreatePermGroupInput = z.infer<typeof createPermGroupSchema>;
export type UpdatePermGroupInput = z.infer<typeof updatePermGroupSchema>;
export type UpdatePermissionsMatrixInput = z.infer<typeof updatePermissionsMatrixSchema>;
export type SavePermGroupConfigurationInput = z.infer<typeof savePermGroupConfigurationSchema>;
