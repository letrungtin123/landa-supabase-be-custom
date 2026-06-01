// ═══════════════════════════════════════════════════════════════
// Modules Service — Quản lý danh sách modules hệ thống
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import type { CreateModuleInput, UpdateModuleInput } from './modules.validator.js';

/**
 * Danh sách tất cả modules (không phân trang vì số lượng ít).
 */
export async function listModules() {
  const result = await query(
    'SELECT id, code, name, description, icon, sort_order, is_active, created_at FROM modules ORDER BY sort_order',
  );
  return result.rows;
}

/**
 * Tạo module mới (superadmin only).
 */
export async function createModule(input: CreateModuleInput) {
  const existing = await query('SELECT id FROM modules WHERE code = $1', [input.code]);
  if (existing.rowCount! > 0) throw new AppError('Module code đã tồn tại', 409);

  const result = await query(
    `INSERT INTO modules (code, name, description, icon, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, name, icon, sort_order`,
    [input.code, input.name, input.description || '', input.icon || '', input.sort_order || 0],
  );

  return result.rows[0];
}

/**
 * Cập nhật module.
 */
export async function updateModule(moduleId: string, input: UpdateModuleInput) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (input.icon !== undefined) { sets.push(`icon = $${idx++}`); params.push(input.icon); }
  if (input.sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(input.sort_order); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(moduleId);
  const result = await query(
    `UPDATE modules SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, code, name, icon, sort_order, is_active`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('Module không tồn tại', 404);
  return result.rows[0];
}
