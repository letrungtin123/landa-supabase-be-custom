// ═══════════════════════════════════════════════════════════════
// Auth Service — Business logic: login, refresh, logout, getMe
// Tối ưu: chỉ query cần thiết, index trên username/email/token_hash
// ═══════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { comparePassword } from '../../utils/password.js';
import { signAccessToken, parseExpiresIn } from '../../utils/jwt.js';
import { AppError } from '../../middleware/error-handler.js';
import { looksLikeEmailIdentifier, normalizeEmail } from '../../utils/email.js';
import type { PermissionsMap } from '../../types/index.js';
import { isLearnerRole } from '../../types/index.js';
import { getTenantRoleLabels } from '../tenants/tenant-role-labels.service.js';
import { getTenantGroupLabels } from '../tenants/tenant-group-labels.service.js';
import {
  isActiveDemoIframeAccount,
  normalizeSessionMode,
  revokeNormalSessionsForDemoIframeAccount,
  type DemoIframeSessionMode,
} from '../demo-login/demo-iframe.service.js';

/** Hash refresh token bằng SHA-256 trước khi lưu DB */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Grace period cho race condition detection.
 * Khi FE gửi 2+ refresh requests gần nhau (do visibilitychange, timer, 401 interceptor),
 * request thứ 2 thấy token đã revoked (bởi request 1).
 * Nếu revoked trong vòng GRACE_MS → race condition, chỉ reject request đó.
 * Nếu revoked trước GRACE_MS → khả năng token theft, nuclear revoke ALL.
 */
const RACE_CONDITION_GRACE_MS = 10_000; // 10 giây
const NORMAL_SESSION_MODE: DemoIframeSessionMode = 'normal';

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

const LOGIN_USER_SELECT = `
  SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
         u.role, u.is_active, u.tenant_id,
         u.password_hash,
         t.name AS tenant_name, t.is_active AS tenant_active
  FROM users u
  LEFT JOIN tenants t ON t.id = u.tenant_id
`;

async function findLoginUser(identifierInput: string) {
  const identifier = identifierInput.trim();
  if (!identifier) {
    throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
  }

  if (looksLikeEmailIdentifier(identifier)) {
    const normalizedEmail = normalizeEmail(identifier);
    const emailResult = await query(
      `${LOGIN_USER_SELECT}
       WHERE btrim(u.email) <> ''
         AND lower(btrim(u.email)) = $1
       LIMIT 1`,
      [normalizedEmail],
    );
    if (emailResult.rowCount! > 0) return emailResult;
  }

  return query(
    `${LOGIN_USER_SELECT}
     WHERE u.username = $1
     LIMIT 1`,
    [identifier],
  );
}

/**
 * Đăng nhập — verify password, tạo token pair.
 * Trả về access_token, refresh_token, user info, permissions.
 */
export async function login(username: string, password: string, clientApp?: 'admin' | 'learner', origin?: string) {
  const userResult = await findLoginUser(username);

  if (userResult.rowCount === 0) {
    throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
  }

  const user = userResult.rows[0];

  // Kiểm tra tài khoản active
  if (!user.is_active) {
    throw new AppError('Tài khoản đã bị vô hiệu hóa', 403);
  }

  // Verify password trước — tránh leak info qua timing
  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
  }

  // ── Kiểm tra user có thuộc tenant của domain đang login không ──
  // Chỉ superadmin mới được login ở bất kỳ domain nào.
  // Các role khác phải login đúng domain của tenant mình.
  if (origin && user.role !== 'superadmin') {
    const tenantFromDomain = await resolveTenantByOrigin(origin);
    if (tenantFromDomain && tenantFromDomain.id !== user.tenant_id) {
      throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
    }
  }

  if (clientApp === 'admin' && user.role === 'learner') {
    throw new AppError('Tài khoản learner chỉ được truy cập trang học viên', 403);
  }

  // learner_plus login admin: phải có ít nhất 1 permission group
  if (clientApp === 'admin' && user.role === 'learner_plus') {
    const pgCheck = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM user_permission_groups WHERE user_id = $1`,
      [user.id],
    );
    if (parseInt(pgCheck.rows[0].count) === 0) {
      throw new AppError('Tài khoản chưa được gán nhóm quyền để truy cập trang quản trị', 403);
    }
  }

  // learner/learner_plus: phải có tenant_id hợp lệ + tenant active
  if (isLearnerRole(user.role)) {
    if (!user.tenant_id) {
      throw new AppError('Tài khoản chưa được gán vào tổ chức', 403);
    }
    if (!user.tenant_active) {
      throw new AppError('Tổ chức đã bị vô hiệu hóa', 403);
    }
  }

  // superuser: check user_tenants có ít nhất 1 tenant active
  if (user.role === 'superuser') {
    const managedCheck = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM user_tenants ut
       JOIN tenants t ON t.id = ut.tenant_id
       WHERE ut.user_id = $1 AND t.is_active = true`,
      [user.id],
    );
    const hasManagedTenants = parseInt(managedCheck.rows[0].count) > 0;
    const hasPrimaryTenant = !!user.tenant_id && !!user.tenant_active;

    if (!hasManagedTenants && !hasPrimaryTenant) {
      throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
    }
  } else if (user.role === 'staff') {
    // staff: phải có tenant_id hợp lệ + tenant active
    if (!user.tenant_id) {
      throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
    }
    if (!user.tenant_active) {
      throw new AppError('Tài khoản hoặc mật khẩu không đúng', 401);
    }
  }

  // Tạo token pair
  if (user.role === 'learner' && await isActiveDemoIframeAccount(user.id)) {
    throw new AppError('Tài khoản đang được khóa cho demo iframe', 403);
  }

  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenant_id,
    role: user.role,
    username: user.username,
    session_mode: NORMAL_SESSION_MODE,
  });

  const refreshToken = uuidv4();
  const refreshHash = hashToken(refreshToken);
  const refreshExpiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN));

  // Lưu refresh token hash vào DB
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode) VALUES ($1, $2, $3, $4)`,
    [user.id, refreshHash, refreshExpiresAt, NORMAL_SESSION_MODE],
  );

  // Cập nhật last_login_at
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  // Lấy permissions
  const permissions = await resolvePermissions(user.id, user.role, user.tenant_id);

  // Lấy tenant modules (những module tenant được bật)
  const tenantModules = await resolveTenantModules(user.tenant_id);

  // Superuser/superadmin: lấy danh sách tenants được quản lý
  const managedTenants = (user.role === 'superuser' || user.role === 'superadmin')
    ? await resolveManagedTenants(user.id, user.tenant_id, user.role)
    : [];
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(
    resolveRoleLabelTenantId(user.role, user.tenant_id, managedTenants),
  );

  // learner_plus: lấy danh sách org groups mà user thuộc về
  const memberGroups = user.role === 'learner_plus'
    ? await resolveMemberGroups(user.id)
    : [];

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
    session_mode: NORMAL_SESSION_MODE,
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
 * Refresh token — rotate: cấp token mới, revoke token cũ.
 */
export async function refresh(refreshToken: string, selectedTenantId?: string) {
  const tokenHash = hashToken(refreshToken);

  // Tìm và validate refresh token (1 query JOIN user)
  const result = await query(
    `SELECT rt.id AS rt_id, rt.user_id, rt.revoked, rt.expires_at, rt.revoked_at,
            COALESCE(rt.session_mode, 'normal') AS session_mode,
            u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            t.name AS tenant_name, t.is_active AS tenant_active
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE rt.token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );

  if (result.rowCount === 0) {
    throw new AppError('Refresh token không hợp lệ', 401);
  }

  const row = result.rows[0];

  // ── Kiểm tra token đã bị revoke — Grace period cho race condition ──
  if (row.revoked) {
    const revokedAt = row.revoked_at ? new Date(row.revoked_at).getTime() : 0;
    const elapsed = Date.now() - revokedAt;

    if (!row.revoked_at || elapsed > RACE_CONDITION_GRACE_MS) {
      // Token bị reuse SAU grace period → khả năng token theft
      // Nuclear revoke: hủy TẤT CẢ tokens active của user → force re-login
      await query(
        'UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked = false',
        [row.user_id],
      );
      throw new AppError('Phiên đăng nhập đã bị thu hồi — vui lòng đăng nhập lại', 401);
    }

    // Token bị reuse TRONG grace period → race condition từ FE
    // Chỉ reject request này, KHÔNG revoke tokens khác
    throw new AppError('Refresh token đã được sử dụng', 401);
  }

  // Kiểm tra hết hạn
  if (new Date(row.expires_at) < new Date()) {
    throw new AppError('Refresh token đã hết hạn', 401);
  }

  // Kiểm tra user + tenant active
  if (!row.is_active) {
    throw new AppError('Tài khoản đã bị vô hiệu hóa', 403);
  }
  if (row.role !== 'superadmin' && row.tenant_id && !row.tenant_active) {
    throw new AppError('Tổ chức đã bị vô hiệu hóa', 403);
  }

  // Revoke token cũ — ghi timestamp để grace period detection
  const sessionMode = normalizeSessionMode(row.session_mode);
  const isActiveIframeLearner = row.role === 'learner'
    ? await isActiveDemoIframeAccount(row.user_id)
    : false;
  if (isActiveIframeLearner && sessionMode !== 'demo_iframe') {
    await query('UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [row.rt_id]);
    throw new AppError('Tài khoản đang được khóa cho demo iframe', 403);
  }
  if (sessionMode === 'demo_iframe' && !isActiveIframeLearner) {
    await query('UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [row.rt_id]);
    throw new AppError('Phiên demo iframe không còn khả dụng', 401);
  }

  await query('UPDATE refresh_tokens SET revoked = true, revoked_at = now() WHERE id = $1', [row.rt_id]);

  // Tạo token pair mới (rotation)
  const newAccessToken = signAccessToken({
    sub: row.user_id,
    tid: row.tenant_id,
    role: row.role,
    username: row.username,
    session_mode: sessionMode,
  });

  const newRefreshToken = uuidv4();
  const newRefreshHash = hashToken(newRefreshToken);
  const newRefreshExpiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN));

  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode) VALUES ($1, $2, $3, $4)',
    [row.user_id, newRefreshHash, newRefreshExpiresAt, sessionMode],
  );

  // Lấy permissions + tenant modules mới
  const permissions = await resolvePermissions(row.user_id, row.role, row.tenant_id);
  const tenantModules = await resolveTenantModules(row.tenant_id);
  const managedTenants = (row.role === 'superuser' || row.role === 'superadmin')
    ? await resolveManagedTenants(row.user_id, row.tenant_id, row.role)
    : [];
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(
    resolveRoleLabelTenantId(
      row.role,
      row.tenant_id,
      managedTenants,
      selectedTenantId,
    ),
  );
  const memberGroups = row.role === 'learner_plus'
    ? await resolveMemberGroups(row.user_id)
    : [];

  return {
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_in: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
    session_mode: sessionMode,
    user: {
      id: row.user_id,
      username: row.username,
      email: row.email,
      full_name: row.full_name,
      phone: row.phone,
      avatar_url: row.avatar_url,
      role: row.role,
      tenant_id: row.tenant_id,
      tenant_name: row.tenant_name,
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
 * Logout — revoke refresh token.
 */
export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  await query('UPDATE refresh_tokens SET revoked = true, revoked_at = now() WHERE token_hash = $1', [tokenHash]);
}

/**
 * Lấy thông tin user hiện tại + permissions.
 */
export async function issueSessionForUserId(
  userId: string,
  options?: { sessionMode?: DemoIframeSessionMode; updateLastLogin?: boolean },
) {
  const sessionMode = options?.sessionMode ?? NORMAL_SESSION_MODE;
  const userResult = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            t.name AS tenant_name, t.is_active AS tenant_active
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [userId],
  );

  if (userResult.rowCount === 0) throw new AppError('User không tồn tại', 404);
  const user = userResult.rows[0];
  if (!user.is_active) throw new AppError('Tài khoản đã bị vô hiệu hóa', 403);
  if (user.role !== 'superadmin' && user.tenant_id && !user.tenant_active) {
    throw new AppError('Tổ chức đã bị vô hiệu hóa', 403);
  }

  if (sessionMode !== 'demo_iframe' && user.role === 'learner' && await isActiveDemoIframeAccount(user.id)) {
    throw new AppError('Tài khoản đang được khóa cho demo iframe', 403);
  }
  if (sessionMode === 'demo_iframe') {
    if (user.role !== 'learner') {
      throw new AppError('Demo iframe chỉ hỗ trợ tài khoản learner', 403);
    }
    await revokeNormalSessionsForDemoIframeAccount(user.id);
  }

  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenant_id,
    role: user.role,
    username: user.username,
    session_mode: sessionMode,
  });

  const refreshToken = uuidv4();
  const refreshHash = hashToken(refreshToken);
  const refreshExpiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN));

  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode) VALUES ($1, $2, $3, $4)',
    [user.id, refreshHash, refreshExpiresAt, sessionMode],
  );
  if (options?.updateLastLogin !== false) {
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  }

  const permissions = await resolvePermissions(user.id, user.role, user.tenant_id);
  const tenantModules = await resolveTenantModules(user.tenant_id);
  const managedTenants = (user.role === 'superuser' || user.role === 'superadmin')
    ? await resolveManagedTenants(user.id, user.tenant_id, user.role)
    : [];
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(
    resolveRoleLabelTenantId(user.role, user.tenant_id, managedTenants),
  );
  const memberGroups = user.role === 'learner_plus'
    ? await resolveMemberGroups(user.id)
    : [];

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
    session_mode: sessionMode,
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
    },
    permissions,
    tenant_modules: tenantModules,
    managed_tenants: managedTenants,
    role_labels: roleLabels,
    group_labels: groupLabels,
    member_groups: memberGroups,
  };
}

export async function getMe(userId: string, selectedTenantId?: string | null) {
  const result = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.tenant_id, u.bio, u.gender, u.country, u.language,
            u.level_of_education, u.year_of_birth,
            t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [userId],
  );

  if (result.rowCount === 0) {
    throw new AppError('User không tồn tại', 404);
  }

  const user = result.rows[0];
  const permissions = await resolvePermissions(user.id, user.role, user.tenant_id);
  const tenantModules = await resolveTenantModules(user.tenant_id);
  const managedTenants = (user.role === 'superuser' || user.role === 'superadmin')
    ? await resolveManagedTenants(user.id, user.tenant_id, user.role)
    : [];
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(
    resolveRoleLabelTenantId(
      user.role,
      user.tenant_id,
      managedTenants,
      selectedTenantId,
    ),
  );
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
    const modules = await query<{ code: string }>('SELECT code FROM modules WHERE is_active = true ORDER BY sort_order');
    const map: PermissionsMap = {};
    for (const m of modules.rows) {
      map[m.code] = { can_view: true, can_add: true, can_edit: true, can_delete: true };
    }
    return map;
  }

  // staff/learner: aggregate từ tất cả permission groups
  const result = await query<{ code: string; can_view: boolean; can_add: boolean; can_edit: boolean; can_delete: boolean }>(
    `SELECT m.code,
            bool_or(pgm.can_view) AS can_view,
            bool_or(pgm.can_add) AS can_add,
            bool_or(pgm.can_edit) AS can_edit,
            bool_or(pgm.can_delete) AS can_delete
     FROM user_permission_groups upg
     JOIN permission_group_modules pgm ON pgm.permission_group_id = upg.permission_group_id
     JOIN modules m ON m.id = pgm.module_id
     JOIN permission_groups pg ON pg.id = upg.permission_group_id
     WHERE upg.user_id = $1
       AND pg.tenant_id = $2
     GROUP BY m.code`,
    [userId, tenantId],
  );

  const map: PermissionsMap = {};
  for (const row of result.rows) {
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
    const result = await query<{ code: string }>('SELECT code FROM modules WHERE is_active = true ORDER BY sort_order');
    return result.rows.map(function getCode(r) { return r.code; });
  }

  const result = await query<{ code: string }>(
    `SELECT m.code
     FROM tenant_modules tm
     JOIN modules m ON m.id = tm.module_id
     WHERE tm.tenant_id = $1 AND tm.is_enabled = true AND m.is_active = true
     ORDER BY m.sort_order`,
    [tenantId],
  );

  return result.rows.map(function getCode(r) { return r.code; });
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
    const result = await query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE is_active = true ORDER BY name ASC',
    );
    return result.rows;
  }

  // superuser: CHỈ tenant chính (không multi-tenant)
  if (primaryTenantId) {
    const result = await query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE id = $1 AND is_active = true',
      [primaryTenantId],
    );
    return result.rows;
  }

  return [];
}

/**
 * Resolve org groups mà user thuộc về (thông qua team_members → teams → sub_groups → org_groups).
 * Dùng cho learner_plus để giới hạn scope xem báo cáo.
 */
async function resolveMemberGroups(userId: string): Promise<{ id: string; name: string }[]> {
  const result = await query<{ id: string; name: string }>(
    `SELECT DISTINCT og.id, og.name
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1
     ORDER BY og.name`,
    [userId],
  );
  return result.rows;
}

/**
 * Resolve tenant từ origin (window.location.origin).
 * So sánh origin với domain_learner / domain_admin trong bảng tenants.
 * Trả null nếu origin không match tenant nào (ví dụ: localhost dev mode).
 */
const originTenantCache = new Map<string, { id: string; expires: number } | null>();
const ORIGIN_CACHE_TTL = 60_000; // 60s

async function resolveTenantByOrigin(origin: string): Promise<{ id: string } | null> {
  // Normalize: bỏ trailing slash
  const normalizedOrigin = origin.replace(/\/+$/, '');

  const cached = originTenantCache.get(normalizedOrigin);
  if (cached !== undefined && (cached === null || cached.expires > Date.now())) {
    return cached;
  }

  // So sánh trực tiếp origin với domain_learner / domain_admin
  // Domain trong DB có thể có hoặc không có trailing slash, protocol khác nhau
  const result = await query<{ id: string }>(
    `SELECT id FROM tenants
     WHERE (
       REPLACE(REPLACE(domain_learner, '/', ''), ' ', '') = REPLACE(REPLACE($1, '/', ''), ' ', '')
       OR REPLACE(REPLACE(domain_admin, '/', ''), ' ', '') = REPLACE(REPLACE($1, '/', ''), ' ', '')
     ) AND is_active = true
     LIMIT 1`,
    [normalizedOrigin],
  );

  if (result.rowCount === 0) {
    originTenantCache.set(normalizedOrigin, null);
    return null;
  }

  const tenant = { id: result.rows[0].id, expires: Date.now() + ORIGIN_CACHE_TTL };
  originTenantCache.set(normalizedOrigin, tenant);
  return tenant;
}

/**
 * Dọn refresh tokens hết hạn — chạy định kỳ để giữ bảng gọn.
 */
export async function cleanupExpiredTokens(): Promise<number> {
  // Chỉ xóa tokens hết hạn hoặc đã revoked > 1 ngày trước
  // Giữ recently-revoked tokens để grace period detection hoạt động
  const result = await query(
    `DELETE FROM refresh_tokens
     WHERE expires_at < now()
        OR (revoked = true AND revoked_at < now() - interval '1 day')`,
  );
  return result.rowCount ?? 0;
}

// ── One-Time Token (OTT) — Cross-app SSO ──
// In-memory store: token → { userId, expiresAt }
// Dùng để chuyển auth giữa FE 5173 ↔ Admin Dashboard
// Token tồn tại 30 giây, dùng 1 lần rồi xóa.

const OTT_TTL_MS = 30_000; // 30 giây
const ottStore = new Map<string, { userId: string; expiresAt: number }>();

// Cleanup expired OTTs mỗi phút
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of ottStore) {
    if (now > data.expiresAt) ottStore.delete(token);
  }
}, 60_000);

/**
 * Tạo One-Time Token cho user — dùng để cross-app SSO.
 * User phải đã authenticated (có userId từ JWT).
 */
export function generateOTT(userId: string): string {
  const token = uuidv4();
  ottStore.set(token, { userId, expiresAt: Date.now() + OTT_TTL_MS });
  return token;
}

/**
 * Exchange OTT → full auth session (access_token + refresh_token).
 * Token bị xóa ngay sau khi dùng (one-time).
 */
export async function exchangeOTT(token: string) {
  const entry = ottStore.get(token);
  if (!entry) throw new AppError('Token không hợp lệ hoặc đã hết hạn', 401);

  // Xóa ngay — one-time use
  ottStore.delete(token);

  // Check hết hạn
  if (Date.now() > entry.expiresAt) {
    throw new AppError('Token đã hết hạn', 401);
  }

  // Lấy user từ DB (giống getMe nhưng tạo token pair)
  const userResult = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            t.name AS tenant_name, t.is_active AS tenant_active
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [entry.userId],
  );

  if (userResult.rowCount === 0) throw new AppError('User không tồn tại', 404);
  const user = userResult.rows[0];
  if (!user.is_active) throw new AppError('Tài khoản đã bị vô hiệu hóa', 403);

  // Tạo token pair (giống login)
  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenant_id,
    role: user.role,
    username: user.username,
    session_mode: NORMAL_SESSION_MODE,
  });

  const refreshToken = uuidv4();
  const refreshHash = hashToken(refreshToken);
  const refreshExpiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN));

  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode) VALUES ($1, $2, $3, $4)',
    [user.id, refreshHash, refreshExpiresAt, NORMAL_SESSION_MODE],
  );

  const permissions = await resolvePermissions(user.id, user.role, user.tenant_id);
  const tenantModules = await resolveTenantModules(user.tenant_id);
  const managedTenants = (user.role === 'superuser' || user.role === 'superadmin')
    ? await resolveManagedTenants(user.id, user.tenant_id, user.role)
    : [];
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(
    resolveRoleLabelTenantId(user.role, user.tenant_id, managedTenants),
  );

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
    session_mode: NORMAL_SESSION_MODE,
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
    },
    permissions,
    tenant_modules: tenantModules,
    managed_tenants: managedTenants,
    role_labels: roleLabels,
    group_labels: groupLabels,
  };
}

/**
 * Đổi mật khẩu — verify mật khẩu cũ + set mật khẩu mới.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const result = await query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );

  if (result.rowCount === 0) {
    throw new AppError('User không tồn tại', 404);
  }

  const valid = await comparePassword(currentPassword, result.rows[0].password_hash);
  if (!valid) {
    throw new AppError('Mật khẩu hiện tại không đúng', 403);
  }

  if (newPassword.length < 6) {
    throw new AppError('Mật khẩu mới phải có ít nhất 6 ký tự', 400);
  }

  const { hashPassword } = await import('../../utils/password.js');
  const hash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
}

/**
 * Cập nhật profile — learner tự sửa thông tin cá nhân.
 */
export async function updateProfile(userId: string, input: {
  full_name?: string;
  phone?: string;
  bio?: string;
  avatar_url?: string;
  gender?: string;
  country?: string;
  language?: string;
  level_of_education?: string;
  year_of_birth?: number;
}) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Enum fields cần convert "" → null (PostgreSQL enum không chấp nhận "")
  const enumFields = new Set(['gender', 'level_of_education']);

  const allowed = ['full_name', 'phone', 'bio', 'avatar_url', 'gender', 'country', 'language', 'level_of_education', 'year_of_birth'] as const;
  for (const key of allowed) {
    if ((input as any)[key] !== undefined) {
      const val = (input as any)[key];
      sets.push(`${key} = $${idx++}`);
      params.push(enumFields.has(key) && val === '' ? null : val);
    }
  }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(userId);
  const result = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, username, email, full_name, phone, bio, avatar_url, gender, country, language, level_of_education, year_of_birth`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);
  return result.rows[0];
}
