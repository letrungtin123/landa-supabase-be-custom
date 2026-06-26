import { getClient, query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import type { UserRole } from '../../types/index.js';

export type RoleLabelMap = Partial<Record<UserRole, string>>;

export const SYSTEM_ROLES = [
  'superadmin',
  'superuser',
  'staff',
  'learner',
  'learner_plus',
] as const satisfies readonly UserRole[];

const ROLE_SET = new Set<string>(SYSTEM_ROLES);
const MAX_LABEL_LENGTH = 64;
const CACHE_TTL_MS = 5 * 60_000;
const roleLabelsCache = new Map<string, { labels: RoleLabelMap; expires: number }>();

function isUndefinedTableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01';
}

export function sanitizeRoleLabels(input: unknown): RoleLabelMap {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('role_labels phai la object', 400);
  }

  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!ROLE_SET.has(key)) {
      throw new AppError(`Role khong hop le: ${key}`, 400);
    }
  }

  const labels: RoleLabelMap = {};
  for (const role of SYSTEM_ROLES) {
    const raw = source[role];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new AppError(`Label cua role ${role} phai la chuoi`, 400);
    }

    const label = raw.trim();
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) {
      throw new AppError(`Label cua role ${role} toi da ${MAX_LABEL_LENGTH} ky tu`, 400);
    }
    labels[role] = label;
  }
  return labels;
}

export function invalidateTenantRoleLabelsCache(tenantId?: string | null): void {
  if (!tenantId) {
    roleLabelsCache.clear();
    return;
  }
  roleLabelsCache.delete(tenantId);
}

export async function getTenantRoleLabels(tenantId: string | null | undefined): Promise<RoleLabelMap> {
  if (!tenantId) return {};

  const cached = roleLabelsCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.labels;

  try {
    const result = await query<{ role: UserRole; label: string }>(
      `SELECT role::text AS role, label
       FROM tenant_role_labels
       WHERE tenant_id = $1`,
      [tenantId],
    );

    const labels: RoleLabelMap = {};
    for (const row of result.rows) {
      if (ROLE_SET.has(row.role)) labels[row.role] = row.label;
    }

    roleLabelsCache.set(tenantId, { labels, expires: Date.now() + CACHE_TTL_MS });
    return labels;
  } catch (err) {
    if (isUndefinedTableError(err)) return {};
    throw err;
  }
}

export async function replaceTenantRoleLabels(
  tenantId: string,
  input: unknown,
  actorId: string | null,
): Promise<RoleLabelMap> {
  const labels = sanitizeRoleLabels(input);
  const entries = Object.entries(labels) as [UserRole, string][];

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const tenant = await client.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (tenant.rowCount === 0) throw new AppError('Tenant khong ton tai', 404);

    await client.query('DELETE FROM tenant_role_labels WHERE tenant_id = $1', [tenantId]);

    for (const [role, label] of entries) {
      await client.query(
        `INSERT INTO tenant_role_labels (tenant_id, role, label, updated_by, updated_at)
         VALUES ($1, $2::user_role, $3, $4, now())`,
        [tenantId, role, label, actorId],
      );
    }

    await client.query('COMMIT');
    invalidateTenantRoleLabelsCache(tenantId);
    return labels;
  } catch (err) {
    await client.query('ROLLBACK');
    if (isUndefinedTableError(err)) {
      throw new AppError('Bang tenant_role_labels chua duoc tao. Hay chay manual SQL truoc.', 500);
    }
    throw err;
  } finally {
    client.release();
  }
}
