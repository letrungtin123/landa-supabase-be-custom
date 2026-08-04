// ═══════════════════════════════════════════════════════════════
// Audit Logs Service — List + filter (reads from audit_logs table)
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

const DEFAULT_AUDIT_WINDOW_DAYS = 30;

export async function listAuditLogs(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (tenantId) { params.push(tenantId); conditions.push(`a.tenant_id = $${params.length}`); }
  if (search && search.length >= 2) {
    params.push(`%${search}%`);
    conditions.push(`(a.actor_username ILIKE $${params.length} OR a.entity_name ILIKE $${params.length} OR a.entity_type::text ILIKE $${params.length})`);
  }
  const actionFilter = queryParams.action as string;
  if (actionFilter && actionFilter !== 'all') { params.push(actionFilter); conditions.push(`a.action = $${params.length}`); }
  const dateFrom = queryParams.date_from as string;
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`a.created_at >= $${params.length}::timestamptz`);
  } else {
    params.push(DEFAULT_AUDIT_WINDOW_DAYS);
    conditions.push(`a.created_at >= now() - ($${params.length}::int * interval '1 day')`);
  }
  const dateTo = queryParams.date_to as string;
  if (dateTo) { params.push(dateTo); conditions.push(`a.created_at <= ($${params.length}::timestamptz + interval '1 day')`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs a ${where}`, params),
    query(
      `SELECT a.* FROM audit_logs a ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return { results: dataR.rows, total, page, page_size: pageSize, total_pages: calcTotalPages(total, pageSize) };
}
