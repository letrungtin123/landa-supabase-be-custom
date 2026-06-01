// ═══════════════════════════════════════════════════════════════
// Query Helpers — Pagination, search, ordering
// Tối ưu cho hàng triệu rows: LIMIT/OFFSET + indexed WHERE
// ═══════════════════════════════════════════════════════════════

import type { PaginationParams } from '../types/index.js';

/** Giới hạn page size tối đa để tránh quá tải */
const MAX_PAGE_SIZE = 100;

/**
 * Parse và validate pagination params từ query string.
 * Mặc định page=1, pageSize=20.
 */
export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const rawSize = parseInt(String(query.page_size || '20'), 10) || 20;
  const pageSize = Math.min(Math.max(1, rawSize), MAX_PAGE_SIZE);
  const search = typeof query.search === 'string' ? query.search.trim() : undefined;

  return { page, pageSize, search };
}

/**
 * Tính offset từ page + pageSize.
 */
export function calcOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/**
 * Tính tổng số trang.
 */
export function calcTotalPages(total: number, pageSize: number): number {
  return Math.ceil(total / pageSize) || 1;
}

/**
 * Build mệnh đề WHERE ILIKE cho search.
 * Trả về { clause, param } để ghép vào query.
 * paramIndex: vị trí tham số (ví dụ $3).
 */
export function buildSearchClause(
  columns: string[],
  paramIndex: number,
): { clause: string; toParam: (search: string) => string } {
  const conditions = columns.map(function mapCol(col) {
    return `${col} ILIKE $${paramIndex}`;
  });
  return {
    clause: `(${conditions.join(' OR ')})`,
    toParam: function formatSearch(search: string) {
      return `%${search}%`;
    },
  };
}
