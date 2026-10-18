// ═══════════════════════════════════════════════════════════════
// Auth Service — Business logic: login, refresh, logout, getMe
// Tối ưu: chỉ query cần thiết, index trên username/email/token_hash
// ═══════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { invalidateUserBadgeCaches } from '../../config/cache-invalidation.js';
import { env } from '../../config/env.js';
import { compareAgainstDummyPassword, comparePassword } from '../../utils/password.js';
import { signAccessToken, parseExpiresIn } from '../../utils/jwt.js';
import { AppError } from '../../utils/errors.js';
import { AuthLoginError } from './auth-login-error.logic.js';
import { looksLikeEmailIdentifier, normalizeEmail } from '../../utils/email.js';
import type { PermissionsMap } from '../../types/index.js';
import { isLearnerRole } from '../../types/index.js';
import { getTenantRoleLabels } from '../tenants/tenant-role-labels.service.js';
import { recordUserSessionRevocation, syncUserAccessRevocationCache } from './auth-revocation.service.js';
import { createOneTimeTokenStore } from './auth-one-time-token.store.js';
import { createRefreshHandoffStore } from './auth-refresh-handoff.store.js';
import { processRolePlan } from '../../config/process-role.js';
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

/**
 * Starts a read-only sign-in lookup now; the caller awaits it where its
 * check stands. A rejection is surfaced only by that await (or never, when
 * an earlier check refused the sign-in), never as an unhandled rejection.
 */
function startLoginLookup<T>(needed: boolean, lookup: () => Promise<T>): Promise<T> | null {
  if (!needed) return null;
  const pending = lookup();
  pending.catch(() => undefined); // marks the rejection handled; the caller's await surfaces it
  return pending;
}

/**
 * last_login_at is shown with minute precision at most; writing it at most
 * once a minute per user keeps repeated sign-ins of one account (tabs,
 * devices, SSO round trips) from rewriting the users row (many indexes,
 * never a HOT update) each time.
 */
async function touchLastLogin(userId: string): Promise<void> {
  await query(
    `UPDATE users SET last_login_at = now()
     WHERE id = $1 AND (last_login_at IS NULL OR last_login_at < now() - interval '1 minute')`,
    [userId],
  );
}

/**
 * Permissions, managed tenants, tenant modules, labels and member groups of
 * a session. Independent reads run at once; modules and labels wait only
 * for the managed tenants that pick their tenant. Same values as reading
 * them one after the other.
 */
async function resolveSessionContext(
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
  if (!identifier) return null;

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
 *
 * No account enumeration: an unknown name still runs a full bcrypt compare,
 * and every refusal before the password is proven is INVALID_CREDENTIALS.
 * Account state (disabled, no organization, ...) is told only afterwards.
 */
export async function login(username: string, password: string, clientApp?: 'admin' | 'learner', origin?: string) {
  const userResult = await findLoginUser(username);
  const user = userResult?.rows[0];

  if (!user) {
    await compareAgainstDummyPassword(password);
    throw new AuthLoginError('INVALID_CREDENTIALS');
  }

  const valid = typeof user.password_hash === 'string' && user.password_hash
    ? await comparePassword(password, user.password_hash)
    : await compareAgainstDummyPassword(password);
  if (!valid) {
    throw new AuthLoginError('INVALID_CREDENTIALS');
  }

  // The read-only lookups the checks below need start together, once the
  // password is proven; each one is still awaited where its check stands,
  // so the refusals (and their order) are exactly as before.
  const originTenantLookup = startLoginLookup(Boolean(origin) && user.role !== 'superadmin',
    () => resolveTenantByOrigin(origin!));
  const adminGroupCountLookup = startLoginLookup(clientApp === 'admin' && user.role === 'learner_plus',
    () => query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM user_permission_groups WHERE user_id = $1`,
      [user.id],
    ));
  const managedTenantCountLookup = startLoginLookup(user.role === 'superuser',
    () => query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM user_tenants ut
       JOIN tenants t ON t.id = ut.tenant_id
       WHERE ut.user_id = $1 AND t.is_active = true`,
      [user.id],
    ));
  const demoAccountLookup = startLoginLookup(user.role === 'learner', () => isActiveDemoIframeAccount(user.id));

  // ── Kiểm tra user có thuộc tenant của domain đang login không ──
  // Chỉ superadmin mới được login ở bất kỳ domain nào.
  // Các role khác phải login đúng domain của tenant mình.
  if (originTenantLookup) {
    const tenantFromDomain = await originTenantLookup;
    if (tenantFromDomain && tenantFromDomain.id !== user.tenant_id) {
      throw new AuthLoginError('INVALID_CREDENTIALS');
    }
  }

  // Told only after the correct password.
  if (!user.is_active) {
    throw new AuthLoginError('ACCOUNT_DISABLED');
  }

  if (clientApp === 'admin' && user.role === 'learner') {
    throw new AuthLoginError('LEARNER_ADMIN_FORBIDDEN');
  }

  // learner_plus login admin: phải có ít nhất 1 permission group
  if (adminGroupCountLookup) {
    const pgCheck = await adminGroupCountLookup;
    if (parseInt(pgCheck.rows[0].count) === 0) {
      throw new AuthLoginError('NO_ADMIN_ACCESS');
    }
  }

  // learner/learner_plus: phải có tenant_id hợp lệ + tenant active
  if (isLearnerRole(user.role)) {
    if (!user.tenant_id) {
      throw new AuthLoginError('NO_ORGANIZATION');
    }
    if (!user.tenant_active) {
      throw new AuthLoginError('ORGANIZATION_DISABLED');
    }
  }

  // superuser: check user_tenants có ít nhất 1 tenant active
  if (user.role === 'superuser') {
    const managedCheck = await managedTenantCountLookup!;
    const hasManagedTenants = parseInt(managedCheck.rows[0].count) > 0;
    const hasPrimaryTenant = !!user.tenant_id && !!user.tenant_active;

    if (!hasManagedTenants && !hasPrimaryTenant) {
      throw new AuthLoginError('INVALID_CREDENTIALS');
    }
  } else if (user.role === 'staff') {
    // staff: phải có tenant_id hợp lệ + tenant active
    if (!user.tenant_id) {
      throw new AuthLoginError('INVALID_CREDENTIALS');
    }
    if (!user.tenant_active) {
      throw new AuthLoginError('INVALID_CREDENTIALS');
    }
  }

  // Tạo token pair
  if (demoAccountLookup && await demoAccountLookup) {
    throw new AuthLoginError('DEMO_ACCOUNT_LOCKED');
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
  const sessionId = user.role === 'superadmin' ? uuidv4() : null;

  // Lưu refresh token hash vào DB
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshHash, refreshExpiresAt, NORMAL_SESSION_MODE, sessionId],
  );

  // last_login_at (at most once a minute) and the session context, together.
  const [, {
    permissions, managedTenants, tenantModules, roleLabels, groupLabels, memberGroups,
  }] = await Promise.all([
    touchLastLogin(user.id),
    resolveSessionContext(user.id, user.role, user.tenant_id),
  ]);

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

/** A rotated token used again within the grace period (the response is unchanged). */
class RefreshTokenReusedWithinGraceError extends AppError {
  constructor() {
    super('Refresh token đã được sử dụng', 401);
  }
}

export const AUTH_REFRESH_CONTEXT_UNAVAILABLE_CODE = 'AUTH_REFRESH_CONTEXT_UNAVAILABLE';
/** Waits before the retries of the session context read after a committed rotation. */
const REFRESH_CONTEXT_RETRY_DELAYS_MS: readonly number[] = [100, 300];

// Successors whose answer never left the server (auth-refresh-handoff.store.ts).
const refreshHandoffs = createRefreshHandoffStore({
  ttlMs: RACE_CONDITION_GRACE_MS,
  shared: processRolePlan.severalApiInstances,
});

/** Locks a refresh token row (with its user, tenant and session revocation) for the rotation. */
async function lockRefreshTokenRow(tokenHash: string) {
  const result = await query(
    `SELECT rt.id AS rt_id, rt.user_id, rt.revoked, rt.expires_at, rt.revoked_at,
            rt.session_id,
            COALESCE(rt.session_mode, 'normal') AS session_mode,
            u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            t.name AS tenant_name, t.is_active AS tenant_active,
            ar.revoked_at AS session_revoked_at
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN auth_revocations ar ON ar.user_id = rt.user_id AND ar.expires_at > now()
     WHERE rt.token_hash = $1
     LIMIT 1
     FOR UPDATE OF rt`,
    [tokenHash],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

/**
 * The rotation transaction of refresh(): token lock, every check, reuse
 * detection with its grace period, revoke + insert. `successorHash` (from a
 * refresh handoff) lets a retry within the grace period rotate the successor
 * that the committed rotation of this token never delivered.
 */
async function rotateRefreshToken(tokenHash: string, successorHash?: string) {
  // Lock the token row for the whole rotation. A frontend mutex cannot protect
  // duplicate requests from separate browser tabs or devices.
  let row = await lockRefreshTokenRow(tokenHash);

  if (!row) {
    throw new AppError('Refresh token không hợp lệ', 401);
  }

  // ── Kiểm tra token đã bị revoke — Grace period cho race condition ──
  if (row.revoked) {
    const revokedAt = row.revoked_at ? new Date(row.revoked_at).getTime() : 0;
    const elapsed = Date.now() - revokedAt;

    // Revoked when every session of the user ended (password change/reset,
    // deactivation, role change): refuse it, but it is not a stolen-token
    // reuse, so newer sessions (e.g. the one issued after a password change)
    // are not revoked.
    const sessionRevokedAt = row.session_revoked_at ? new Date(row.session_revoked_at).getTime() : 0;
    if (sessionRevokedAt && revokedAt && revokedAt <= sessionRevokedAt) {
      throw new AppError('Phiên đăng nhập đã kết thúc — vui lòng đăng nhập lại', 401);
    }

    if (!row.revoked_at || elapsed > RACE_CONDITION_GRACE_MS) {
      // Superadmin sessions are isolated by login/device. A suspected reuse
      // must end only the affected session family; other roles retain the
      // existing account-wide policy for now.
      if (row.role === 'superadmin' && row.session_id) {
        await query(
          `UPDATE refresh_tokens
           SET revoked = true, revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1 AND session_id = $2 AND revoked = false`,
          [row.user_id, row.session_id],
        );
      } else if (row.role !== 'superadmin') {
        await query(
          'UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked = false',
          [row.user_id],
        );
      }
      // Return the business error so the transaction can COMMIT the revocation.
      // Throwing here would make withDatabaseTransaction roll it back.
      return {
        ok: false as const,
        error: new AppError('Phiên đăng nhập đã bị thu hồi — vui lòng đăng nhập lại', 401),
      };
    }

    // Token bị reuse TRONG grace period → race condition từ FE
    // Chỉ reject request này, KHÔNG revoke tokens khác
    // Except with a handoff: this token's rotation committed but its answer
    // never left the server, so the successor nobody holds is rotated now
    // (same user, still valid; the row lock on this token orders the retries).
    const successor = successorHash ? await lockRefreshTokenRow(successorHash) : null;
    if (!successor || successor.revoked || successor.user_id !== row.user_id) {
      throw new RefreshTokenReusedWithinGraceError();
    }
    row = successor;
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
  // Legacy rows have no session_id until the manual migration is run. If one
  // reaches this code after a partial rollout, start a new isolated family.
  const sessionId = row.role === 'superadmin' ? (row.session_id || uuidv4()) : null;
  const isActiveIframeLearner = row.role === 'learner'
    ? await isActiveDemoIframeAccount(row.user_id)
    : false;
  if (isActiveIframeLearner && sessionMode !== 'demo_iframe') {
    await query('UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [row.rt_id]);
    return {
      ok: false as const,
      error: new AppError('Tài khoản đang được khóa cho demo iframe', 403),
    };
  }
  if (sessionMode === 'demo_iframe' && !isActiveIframeLearner) {
    await query('UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [row.rt_id]);
    return {
      ok: false as const,
      error: new AppError('Phiên demo iframe không còn khả dụng', 401),
    };
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
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.user_id, newRefreshHash, newRefreshExpiresAt, sessionMode, sessionId],
  );

  return {
    ok: true as const,
    row,
    sessionMode,
    newAccessToken,
    newRefreshToken,
  };
}

/** The session context after a committed rotation, tried again shortly when a read fails. */
async function resolveSessionContextAfterRotation(
  userId: string,
  role: string,
  tenantId: string | null,
  selectedTenantId?: string | null,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await resolveSessionContext(userId, role, tenantId, selectedTenantId);
    } catch (error) {
      if (attempt >= REFRESH_CONTEXT_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, REFRESH_CONTEXT_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Refresh token — rotate: cấp token mới, revoke token cũ.
 *
 * The transaction holds the token row lock only for the rotation itself
 * (checks, reuse detection with its grace period, revoke + insert); the
 * permissions, modules and labels of the answer are read after COMMIT.
 * When that read still fails after its retries, the answer is a 503 (both
 * frontends retry it with the same token) and a refresh handoff lets that
 * retry, within the grace period, rotate the successor it never received.
 */
export async function refresh(refreshToken: string, selectedTenantId?: string) {
  const tokenHash = hashToken(refreshToken);
  let outcome: Awaited<ReturnType<typeof rotateRefreshToken>>;
  try {
    outcome = await withDatabaseTransaction(() => rotateRefreshToken(tokenHash));
  } catch (error) {
    if (!(error instanceof RefreshTokenReusedWithinGraceError)) throw error;
    // No transaction is open here (the handoff may live in Redis).
    const successorHash = await refreshHandoffs.take(tokenHash);
    if (!successorHash) throw error;
    try {
      outcome = await withDatabaseTransaction(() => rotateRefreshToken(tokenHash, successorHash));
    } catch (retryError) {
      // A database failure keeps the handoff for the next retry; a refusal ends it.
      if (!(retryError instanceof AppError)) await refreshHandoffs.offer(tokenHash, successorHash);
      throw retryError;
    }
  }

  if (!outcome.ok) {
    throw outcome.error;
  }

  // The rotation is committed: the token row lock (and the quota lock of the
  // refresh_tokens insert) is released before the session context is read.
  const { row, sessionMode, newAccessToken, newRefreshToken } = outcome;
  let sessionContext: Awaited<ReturnType<typeof resolveSessionContext>>;
  try {
    sessionContext = await resolveSessionContextAfterRotation(row.user_id, row.role, row.tenant_id, selectedTenantId);
  } catch (error) {
    await refreshHandoffs.offer(tokenHash, hashToken(newRefreshToken));
    console.warn(JSON.stringify({
      event: 'auth_refresh_context_unavailable',
      user_id: row.user_id,
      attempts: REFRESH_CONTEXT_RETRY_DELAYS_MS.length + 1,
      reason: error instanceof Error ? error.message : String(error),
    }));
    throw new AppError(
      'Chưa tải được phiên đăng nhập, vui lòng thử lại sau giây lát',
      503,
      AUTH_REFRESH_CONTEXT_UNAVAILABLE_CODE,
    );
  }
  const {
    permissions, managedTenants, tenantModules, roleLabels, groupLabels, memberGroups,
  } = sessionContext;

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
  const sessionId = user.role === 'superadmin' ? uuidv4() : null;

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshHash, refreshExpiresAt, sessionMode, sessionId],
  );
  const [, {
    permissions, managedTenants, tenantModules, roleLabels, groupLabels, memberGroups,
  }] = await Promise.all([
    options?.updateLastLogin !== false ? touchLastLogin(user.id) : Promise.resolve(),
    resolveSessionContext(user.id, user.role, user.tenant_id),
  ]);

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
     JOIN permission_group_modules pgm
       ON pgm.permission_group_id = upg.permission_group_id
      AND pgm.tenant_id = upg.tenant_id
     JOIN modules m ON m.id = pgm.module_id
     JOIN permission_groups pg ON pg.id = upg.permission_group_id
     WHERE upg.user_id = $1
       AND upg.tenant_id = $2
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
// Store: token → { userId, expiresAt }; in memory with one API process, in
// Redis with several (auth-one-time-token.store.ts).
// Dùng để chuyển auth giữa FE 5173 ↔ Admin Dashboard
// Token tồn tại 30 giây, dùng 1 lần rồi xóa.

const OTT_TTL_MS = 30_000; // 30 giây
const ottStore = createOneTimeTokenStore({ ttlMs: OTT_TTL_MS, shared: processRolePlan.severalApiInstances });

// Cleanup expired OTTs mỗi phút
setInterval(() => ottStore.sweep(), 60_000);

/**
 * Tạo One-Time Token cho user — dùng để cross-app SSO.
 * User phải đã authenticated (có userId từ JWT).
 */
export async function generateOTT(userId: string): Promise<string> {
  return ottStore.issue(userId);
}

/**
 * Exchange OTT → full auth session (access_token + refresh_token).
 * Token bị xóa ngay sau khi dùng (one-time).
 */
export async function exchangeOTT(token: string) {
  // Xóa ngay — one-time use
  const entry = await ottStore.take(token);
  if (!entry) throw new AppError('Token không hợp lệ hoặc đã hết hạn', 401);

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
  const sessionId = user.role === 'superadmin' ? uuidv4() : null;

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshHash, refreshExpiresAt, NORMAL_SESSION_MODE, sessionId],
  );

  const permissions = await resolvePermissions(user.id, user.role, user.tenant_id);
  const managedTenants = (user.role === 'superuser' || user.role === 'superadmin')
    ? await resolveManagedTenants(user.id, user.tenant_id, user.role)
    : [];
  const tenantContextId = resolveRoleLabelTenantId(user.role, user.tenant_id, managedTenants);
  const tenantModules = await resolveTenantModules(tenantContextId);
  const { roleLabels, groupLabels } = await getDisplayLabelsForTenant(
    tenantContextId,
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
  return replacePasswordAndEndSessions(userId, hash);
}

/**
 * Self-service password change: stores the new hash and ends EVERY session of
 * the user in one transaction (refresh tokens + access tokens issued before
 * now), then returns a fresh session for the caller so the device that made
 * the change stays signed in.
 */
export async function replacePasswordAndEndSessions(userId: string, passwordHash: string) {
  await withDatabaseTransaction(async () => {
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await recordUserSessionRevocation(userId, 'password_changed');
  });
  await syncUserAccessRevocationCache(userId);
  return issueSessionForUserId(userId, { updateLastLogin: false });
}

/**
 * Cập nhật profile — learner tự sửa thông tin cá nhân.
 */
export async function updateProfile(userId: string, input: {
  full_name?: string;
  phone?: string;
  bio?: string;
  avatar_url?: string | null;
  gender?: string;
  country?: string;
  language?: string;
  level_of_education?: string;
  year_of_birth?: number;
}) {
  // Avatars are set only by POST /api/users/profile/avatar (server-generated
  // path). A client-chosen path would later be deleted as "the old avatar".
  if (input.avatar_url !== undefined && input.avatar_url !== null) {
    throw new AppError('Ảnh đại diện chỉ được thay bằng cách tải ảnh lên', 400);
  }

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
  // Profile badges read these fields.
  await invalidateUserBadgeCaches([userId]);
  return result.rows[0];
}
