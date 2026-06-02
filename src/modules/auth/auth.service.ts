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
import type { PermissionsMap } from '../../types/index.js';

/** Hash refresh token bằng SHA-256 trước khi lưu DB */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Đăng nhập — verify password, tạo token pair.
 * Trả về access_token, refresh_token, user info, permissions.
 */
export async function login(username: string, password: string) {
  // Tìm user theo username hoặc email (1 query duy nhất)
  const userResult = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            u.password_hash,
            t.name AS tenant_name, t.is_active AS tenant_active
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE (u.username = $1 OR u.email = $1)
     LIMIT 1`,
    [username],
  );

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

  // learner: phải có tenant_id hợp lệ + tenant active
  if (user.role === 'learner') {
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
  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenant_id,
    role: user.role,
    username: user.username,
  });

  const refreshToken = uuidv4();
  const refreshHash = hashToken(refreshToken);
  const refreshExpiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN));

  // Lưu refresh token hash vào DB
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, refreshHash, refreshExpiresAt],
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

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
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
  };
}

/**
 * Refresh token — rotate: cấp token mới, revoke token cũ.
 */
export async function refresh(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);

  // Tìm và validate refresh token (1 query JOIN user)
  const result = await query(
    `SELECT rt.id AS rt_id, rt.user_id, rt.revoked, rt.expires_at,
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

  // Kiểm tra token đã bị revoke
  if (row.revoked) {
    // Có thể token bị đánh cắp → revoke tất cả token của user
    await query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [row.user_id]);
    throw new AppError('Refresh token đã bị thu hồi', 401);
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

  // Revoke token cũ
  await query('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [row.rt_id]);

  // Tạo token pair mới (rotation)
  const newAccessToken = signAccessToken({
    sub: row.user_id,
    tid: row.tenant_id,
    role: row.role,
    username: row.username,
  });

  const newRefreshToken = uuidv4();
  const newRefreshHash = hashToken(newRefreshToken);
  const newRefreshExpiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN));

  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [row.user_id, newRefreshHash, newRefreshExpiresAt],
  );

  // Lấy permissions + tenant modules mới
  const permissions = await resolvePermissions(row.user_id, row.role, row.tenant_id);
  const tenantModules = await resolveTenantModules(row.tenant_id);
  const managedTenants = (row.role === 'superuser' || row.role === 'superadmin')
    ? await resolveManagedTenants(row.user_id, row.tenant_id, row.role)
    : [];

  return {
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_in: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
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
  };
}

/**
 * Logout — revoke refresh token.
 */
export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  await query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);
}

/**
 * Lấy thông tin user hiện tại + permissions.
 */
export async function getMe(userId: string) {
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
 * Dọn refresh tokens hết hạn — chạy định kỳ để giữ bảng gọn.
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await query(
    'DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked = true',
  );
  return result.rowCount ?? 0;
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
