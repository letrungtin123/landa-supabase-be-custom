// ═══════════════════════════════════════════════════════════════
// Session context: the auth repository over the pool, and what a session
// carries (permissions, managed tenants, tenant modules, role and group
// labels, member groups), read at sign-in, refresh and getMe. Read only.
// Moved unchanged from auth.service.ts, which keeps sign-in, tokens and
// passwords and re-exports the exported names.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import type { PermissionsMap } from '../../types/index.js';
import { getTenantRoleLabels } from '../tenants/tenant-role-labels.service.js';
import { getTenantGroupLabels } from '../tenants/tenant-group-labels.service.js';
import { createAuthRepository, type AuthDb } from './auth.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const poolDb: AuthDb = { query };
export const authRepository = createAuthRepository(poolDb);

function resolveRoleLabelTenantId(
  role: string,
  primaryTenantId: string | null | undefined,
  managedTenants: { id: string; name: string }[],
  selectedTenantId?: string | null,
): string | null {
  if (role === 'superadmin' && selectedTenantId && managedTenants.some(t => t.id === selectedTenantId)) {
    return selectedTenantId;
  }
  return primaryTenantId ?? managedTenants[0]?.id ?? null;
}

export async function getRoleLabelsForTenant(tenantId: string | null | undefined) {
  const [roleLabels, groupLabels] = await Promise.all([
    getTenantRoleLabels(tenantId),
    getTenantGroupLabels(tenantId),
  ]);
  return { role_labels: roleLabels, group_labels: groupLabels };
}

export async function getGroupLabelsForTenant(tenantId: string | null | undefined) {
  return { group_labels: await getTenantGroupLabels(tenantId) };
}

async function getDisplayLabelsForTenant(tenantId: string | null | undefined) {
  const [roleLabels, groupLabels] = await Promise.all([
    getTenantRoleLabels(tenantId),
    getTenantGroupLabels(tenantId),
  ]);
  return { roleLabels, groupLabels };
}

/**
 * Permissions, managed tenants, tenant modules, labels and member groups of
 * a session. Independent reads run at once; modules and labels wait only
 * for the managed tenants that pick their tenant. Same values as reading
 * them one after the other.
 */
export async function resolveSessionContext(
  userId: string,
  role: string,
  tenantId: string | null,
  selectedTenantId?: string | null,
) {
  const [permissions, tenantContext, memberGroups] = await Promise.all([
    resolvePermissions(userId, role, tenantId),
    (async () => {
      // Superuser/superadmin: lấy danh sách tenants được quản lý
      const managedTenants = (role === 'superuser' || role === 'superadmin')
        ? await resolveManagedTenants(userId, tenantId, role)
        : [];
      // Superadmin has no tenant in the JWT. Its UI context defaults to the
      // first managed tenant, so module entitlements must use that same
      // tenant instead of returning every globally-active module.
      const tenantContextId = resolveRoleLabelTenantId(role, tenantId, managedTenants, selectedTenantId);
      const [tenantModules, { roleLabels, groupLabels }] = await Promise.all([
        resolveTenantModules(tenantContextId),
        getDisplayLabelsForTenant(tenantContextId),
      ]);
      return { managedTenants, tenantModules, roleLabels, groupLabels };
    })(),
    // learner_plus: lấy danh sách org groups mà user thuộc về
    role === 'learner_plus' ? resolveMemberGroups(userId) : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  return { permissions, ...tenantContext, memberGroups };
}

export async function getMe(userId: string, selectedTenantId?: string | null) {
  const user = await authRepository.selectMeUser(userId);

  if (!user) {
    throw new AppError('User không tồn tại', 404);
  }

  const permissions = await resolvePermissions(user.id, user.role, user.tenant_id);
  const managedTenants = (user.role === 'superuser' || user.role === 'superadmin')
    ? await resolveManagedTenants(user.id, user.tenant_id, user.role)
    : [];
  const tenantContextId = resolveRoleLabelTenantId(
    user.role,
    user.tenant_id,
    managedTenants,
    selectedTenantId,
  );
  const tenantModules = await resolveTenantModules(tenantContextId);
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(tenantContextId);
  const memberGroups = user.role === 'learner_plus'
    ? await resolveMemberGroups(user.id)
    : [];

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
      avatar_url: user.avatar_url,
      role: user.role,
      tenant_id: user.tenant_id,
      tenant_name: user.tenant_name,
      bio: user.bio || '',
      gender: user.gender || '',
      country: user.country || '',
      language: user.language || '',
      level_of_education: user.level_of_education || '',
      year_of_birth: user.year_of_birth || null,
    },
    permissions,
    tenant_modules: tenantModules,
    managed_tenants: managedTenants,
    role_labels: roleLabels,
    group_labels: groupLabels,
    member_groups: memberGroups,
  };
}

/**
 * Resolve permissions cho user dựa trên role + permission groups.
 * - superadmin/superuser: tất cả modules = full access
 * - staff/learner: UNION tất cả permission_group_modules
 */
async function resolvePermissions(userId: string, role: string, tenantId: string | null): Promise<PermissionsMap> {
  // superadmin & superuser: full permissions trên tất cả modules
  if (role === 'superadmin' || role === 'superuser') {
    const modules = await authRepository.selectActiveModuleCodes();
    const map: PermissionsMap = {};
    for (const m of modules) {
      map[m.code] = { can_view: true, can_add: true, can_edit: true, can_delete: true };
    }
    return map;
  }

  // staff/learner: aggregate từ tất cả permission groups
  const rows = await authRepository.selectPermissionRows(userId, tenantId);

  const map: PermissionsMap = {};
  for (const row of rows) {
    map[row.code] = {
      can_view: row.can_view,
      can_add: row.can_add,
      can_edit: row.can_edit,
      can_delete: row.can_delete,
    };
  }
  return map;
}

/**
 * Lấy danh sách module codes được bật cho tenant.
 * superadmin (tenantId=null): trả tất cả modules.
 */
async function resolveTenantModules(tenantId: string | null): Promise<string[]> {
  if (!tenantId) {
    // superadmin → tất cả modules
    const rows = await authRepository.selectActiveModuleCodes();
    return rows.map(function getCode(r) { return r.code; });
  }

  const rows = await authRepository.selectTenantModuleCodes(tenantId);

  return rows.map(function getCode(r) { return r.code; });
}

/**
 * Lấy danh sách tenants mà user được quản lý.
 * - superadmin: TẤT CẢ tenants active
 * - superuser: CHỈ tenant chính của họ (1 tenant duy nhất)
 */
async function resolveManagedTenants(
  userId: string,
  primaryTenantId: string | null,
  role: string = 'superuser',
): Promise<{ id: string; name: string }[]> {
  // superadmin: trả TẤT CẢ tenants active
  if (role === 'superadmin') {
    return authRepository.selectAllActiveTenants();
  }

  // superuser: CHỈ tenant chính (không multi-tenant)
  if (primaryTenantId) {
    return authRepository.selectActiveTenant(primaryTenantId);
  }

  return [];
}

/**
 * Resolve org groups mà user thuộc về (thông qua team_members → teams → sub_groups → org_groups).
 * Dùng cho learner_plus để giới hạn scope xem báo cáo.
 */
async function resolveMemberGroups(userId: string): Promise<{ id: string; name: string }[]> {
  return authRepository.selectMemberGroups(userId);
}
