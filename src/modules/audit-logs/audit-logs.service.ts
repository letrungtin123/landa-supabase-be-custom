// Audit Logs Service — tenant-scoped legacy paging plus cursor paging for scale.

import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../../config/env.js';
import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import type { UserRole } from '../../types/index.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

export const AUDIT_LOG_RETENTION_DAYS = 30;
const CURSOR_VERSION = 1;
const MAX_LEGACY_AUDIT_OFFSET = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT']);

// Keep the persisted response-audience marker server-internal. API consumers
// receive only the established audit DTO fields.
export const AUDIT_LOG_PUBLIC_SELECT_COLUMNS = `a.id, a.actor_username, a.action, a.entity_type,
  a.entity_id, a.entity_name, a.details, a.ip_address, a.created_at,
  a.event_code, a.event_metadata, a.changes`;

interface CursorPayload {
  v: number;
  createdAt: string;
  id: string;
}

function signCursorPayload(encodedPayload: string): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`audit-log-cursor:v${CURSOR_VERSION}:${encodedPayload}`)
    .digest('base64url');
}

function encodeCursor(payload: CursorPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${signCursorPayload(encodedPayload)}`;
}

function decodeCursor(rawCursor: unknown): CursorPayload | null {
  if (typeof rawCursor !== 'string' || rawCursor.trim() === '') return null;
  const [encodedPayload, signature, ...rest] = rawCursor.split('.');
  if (!encodedPayload || !signature || rest.length > 0) throw new AppError('Con trỏ nhật ký không hợp lệ', 400);

  const expectedSignature = signCursorPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw new AppError('Con trỏ nhật ký không hợp lệ', 400);
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as CursorPayload;
    if (
      parsed.v !== CURSOR_VERSION
      || typeof parsed.createdAt !== 'string'
      || Number.isNaN(new Date(parsed.createdAt).getTime())
      || typeof parsed.id !== 'string'
      || !UUID_PATTERN.test(parsed.id)
    ) throw new Error('Invalid cursor payload');
    return parsed;
  } catch {
    throw new AppError('Con trỏ nhật ký không hợp lệ', 400);
  }
}

/**
 * Applies the response boundary in SQL, before search, pagination and cursor
 * evaluation. Legacy NULL rows intentionally fail closed for every non-SA.
 */
export function appendAuditLogViewerScopeFilter(
  viewerRole: UserRole,
  params: unknown[],
  conditions: string[],
  alias = 'a',
): void {
  if (viewerRole === 'superadmin') return;
  params.push('tenant');
  conditions.push(`${alias}.viewer_scope = $${params.length}`);
}

/**
 * Cursor paging is the scalable audit-log API. Keep the compatibility path
 * bounded so a stale client cannot force an unindexed deep OFFSET scan.
 */
export function assertLegacyAuditOffset(offset: number): void {
  if (offset >= MAX_LEGACY_AUDIT_OFFSET) {
    throw new AppError('Lịch sử hoạt động chỉ hỗ trợ xem 10.000 mục gần nhất. Vui lòng tải lại danh sách để tiếp tục.', 400);
  }
}

/**
 * Email is personal data. Tenant staff may inspect permitted audit details,
 * but only privileged operators receive actor/subject email fields.
 */
export function canViewAuditLogSensitivePii(viewerRole: UserRole): boolean {
  return viewerRole === 'superuser' || viewerRole === 'superadmin';
}

export function getAuditLogDetailPiiColumns(viewerRole: UserRole): string {
  if (!canViewAuditLogSensitivePii(viewerRole)) {
    return `NULL::text AS actor_email,
            NULL::text AS subject_email`;
  }

  return `COALESCE(NULLIF(a.actor_email, ''), NULLIF(lower(actor.email), '')) AS actor_email,
            a.subject_email`;
}

function addBaseFilters(
  tenantId: string | null,
  viewerRole: UserRole,
  queryParams: Record<string, unknown>,
) {
  const requestedScope = typeof queryParams.scope === 'string' ? queryParams.scope.trim() : '';
  if (requestedScope && requestedScope !== 'platform') {
    throw new AppError('Phạm vi nhật ký không hợp lệ', 400);
  }

  if (requestedScope === 'platform') {
    if (viewerRole !== 'superadmin') throw new AppError('Bạn không có quyền xem nhật ký hệ thống', 403);
    return {
      params: [AUDIT_LOG_RETENTION_DAYS] as unknown[],
      conditions: [
        'a.tenant_id IS NULL',
        'a.is_platform_event = true',
        "a.viewer_scope = 'superadmin_only'",
        "a.created_at >= now() - ($1::int * interval '1 day')",
      ],
    };
  }

  if (!tenantId) throw new AppError('Chưa xác định được doanh nghiệp đang sử dụng', 403);

  const params: unknown[] = [tenantId, AUDIT_LOG_RETENTION_DAYS];
  const conditions = [
    'a.tenant_id = $1',
    "a.created_at >= now() - ($2::int * interval '1 day')",
  ];
  appendAuditLogViewerScopeFilter(viewerRole, params, conditions);

  const search = typeof queryParams.search === 'string' ? queryParams.search.trim() : '';
  if (search.length >= 2) {
    params.push(`%${search}%`);
    conditions.push(`(a.actor_username ILIKE $${params.length} OR a.entity_name ILIKE $${params.length} OR a.entity_type::text ILIKE $${params.length})`);
  }

  const action = typeof queryParams.action === 'string' ? queryParams.action.trim() : '';
  if (action && action !== 'all') {
    if (!ALLOWED_ACTIONS.has(action)) throw new AppError('Loại thao tác không hợp lệ', 400);
    params.push(action);
    conditions.push(`a.action = $${params.length}`);
  }

  const dateFrom = typeof queryParams.date_from === 'string' ? queryParams.date_from.trim() : '';
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`a.created_at >= GREATEST($${params.length}::date::timestamptz, now() - ($2::int * interval '1 day'))`);
  }

  const dateTo = typeof queryParams.date_to === 'string' ? queryParams.date_to.trim() : '';
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`a.created_at < LEAST(($${params.length}::date + interval '1 day')::timestamptz, now() + interval '1 day')`);
  }

  return { params, conditions };
}

async function listLegacyAuditLogs(
  tenantId: string | null,
  viewerRole: UserRole,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  assertLegacyAuditOffset(offset);
  const { params, conditions } = addBaseFilters(tenantId, viewerRole, queryParams);
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs a ${where}`, params),
    query(
      `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS}
       FROM audit_logs a ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return {
    results: dataR.rows,
    total,
    page,
    page_size: pageSize,
    total_pages: calcTotalPages(total, pageSize),
    retention_days: AUDIT_LOG_RETENTION_DAYS,
  };
}

/** Cursor mode is opt-in while older dashboard bundles are still in circulation. */
async function listCursorAuditLogs(
  tenantId: string | null,
  viewerRole: UserRole,
  queryParams: Record<string, unknown>,
) {
  const { pageSize } = parsePagination(queryParams);
  const { params, conditions } = addBaseFilters(tenantId, viewerRole, queryParams);
  const cursor = decodeCursor(queryParams.cursor);
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    conditions.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const data = await query<{
    id: string;
    actor_username: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    entity_name: string | null;
    details: string | null;
    ip_address: string | null;
    created_at: string;
    event_code: string | null;
    event_metadata: Record<string, unknown> | null;
    changes: unknown[] | null;
  }>(
    `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS}
     FROM audit_logs a ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length + 1}`,
    [...params, pageSize + 1],
  );

  const hasMore = data.rows.length > pageSize;
  const results = hasMore ? data.rows.slice(0, pageSize) : data.rows;
  const finalRow = results.at(-1);
  return {
    results,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor: hasMore && finalRow
      ? encodeCursor({ v: CURSOR_VERSION, createdAt: finalRow.created_at, id: finalRow.id })
      : null,
    retention_days: AUDIT_LOG_RETENTION_DAYS,
  };
}

export async function listAuditLogs(
  tenantId: string | null,
  viewerRole: UserRole,
  queryParams: Record<string, unknown>,
) {
  return queryParams.pagination === 'cursor'
    ? listCursorAuditLogs(tenantId, viewerRole, queryParams)
    : listLegacyAuditLogs(tenantId, viewerRole, queryParams);
}

/**
 * Returns PII only for one explicitly opened row. Never add these fields to
 * list/cursor projections: a user must not receive an entire page of emails.
 */
export async function getAuditLogDetail(
  auditLogId: string,
  tenantId: string | null,
  viewerRole: UserRole,
  queryParams: Record<string, unknown>,
) {
  if (!UUID_PATTERN.test(auditLogId)) throw new AppError('Mã nhật ký không hợp lệ', 400);
  const { params, conditions } = addBaseFilters(tenantId, viewerRole, queryParams);
  params.push(auditLogId);
  conditions.push(`a.id = $${params.length}::uuid`);

  const result = await query<{
    id: string;
    actor_username: string | null;
    actor_display_name: string | null;
    actor_email: string | null;
    subject_display_name: string | null;
    subject_username: string | null;
    subject_email: string | null;
    subject_role: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    entity_name: string | null;
    details: string | null;
    ip_address: string | null;
    created_at: string;
    event_code: string | null;
    event_metadata: Record<string, unknown> | null;
    changes: unknown[] | null;
  }>(
    `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS},
            COALESCE(NULLIF(a.actor_display_name, ''), NULLIF(actor.full_name, ''), a.actor_username) AS actor_display_name,
            ${getAuditLogDetailPiiColumns(viewerRole)},
            a.subject_display_name,
            a.subject_username,
            a.subject_role
     FROM audit_logs a
     LEFT JOIN users actor ON actor.id = a.actor_id
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    params,
  );
  if (result.rowCount === 0) throw new AppError('Không tìm thấy nhật ký hoạt động', 404);
  return result.rows[0];
}
