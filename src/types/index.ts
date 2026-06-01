// ═══════════════════════════════════════════════════════════════
// Shared Types — Dùng chung toàn bộ app
// ═══════════════════════════════════════════════════════════════

/** Các role hợp lệ trong hệ thống */
export type UserRole = 'learner' | 'staff' | 'superuser' | 'superadmin';

/** Actions phân quyền trên mỗi module */
export type PermissionAction = 'can_view' | 'can_add' | 'can_edit' | 'can_delete';

/** Ma trận quyền: module_code → { can_view, can_add, can_edit, can_delete } */
export type PermissionsMap = Record<string, {
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}>;

/** Pagination params chuẩn */
export interface PaginationParams {
  page: number;
  pageSize: number;
  search?: string;
}

/** Response phân trang chuẩn */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
