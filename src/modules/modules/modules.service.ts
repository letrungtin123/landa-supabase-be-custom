// ═══════════════════════════════════════════════════════════════
// Modules Service — Quản lý danh sách modules hệ thống
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { AppError } from '../../utils/errors.js';
import type { CreateModuleInput, UpdateModuleInput } from './modules.validator.js';
import { createModulesRepository, type ModulesDb } from './modules.repository.js';

const modulesRepository = createModulesRepository({ query } satisfies ModulesDb);

/**
 * Danh sách tất cả modules (không phân trang vì số lượng ít).
 */
export async function listModules() {
  const version = await getCacheVersion(...cacheVersions.modules());
  return cacheJson(
    cacheKeys.tenantResource('system', 'modules', version),
    CACHE_TTL.modules,
    listModulesFromDb,
  );
}

async function listModulesFromDb() {
  return modulesRepository.selectAll();
}

/**
 * Tạo module mới (superadmin only).
 */
export async function createModule(input: CreateModuleInput) {
  if (await modulesRepository.codeExists(input.code)) throw new AppError('Module code đã tồn tại', 409);

  const created = await modulesRepository.insert({
    code: input.code,
    name: input.name,
    description: input.description || '',
    icon: input.icon || '',
    sortOrder: input.sort_order || 0,
  });
  await bumpCacheVersion(...cacheVersions.modules());

  return created;
}

/**
 * Cập nhật module.
 */
export async function updateModule(moduleId: string, input: UpdateModuleInput) {
  const module = await updateModuleFromDb(moduleId, input);
  await bumpCacheVersion(...cacheVersions.modules());
  return module;
}

async function updateModuleFromDb(moduleId: string, input: UpdateModuleInput) {
  const before = await modulesRepository.lockSnapshot(moduleId);
  if (before.rowCount === 0) throw new AppError('Module không tồn tại', 404);

  const result = await modulesRepository.update(moduleId, input);
  if (!result) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  if (result.rowCount === 0) throw new AppError('Module không tồn tại', 404);
  return { ...result.rows[0], previous: before.rows[0] };
}
