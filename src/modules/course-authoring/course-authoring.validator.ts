// ═══════════════════════════════════════════════════════════════
// Course Authoring Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Schema tạo block */
export const createBlockSchema = z.object({
  course_id: z.string().max(500).optional(),
  parent_id: z.string().max(500).optional(),
  parent_locator: z.string().max(500).optional(),
  block_type: z.string().max(50).optional(),
  type: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  display_name: z.string().max(500).optional(),
  data: z.any().optional(),
  metadata: z.any().optional(),
  boilerplate: z.string().max(200).optional(),
});

/** Schema reorder children — validate UUID array */
export const reorderSchema = z.object({
  children: z.array(
    z.string().regex(uuidPattern, 'ID phải là UUID hợp lệ')
  ).min(1).max(500, 'Tối đa 500 blocks'),
});

/** Schema update block */
export const updateBlockSchema = z.object({
  display_name: z.string().max(500).optional(),
  data: z.any().optional(),
  metadata: z.any().optional(),
  publish: z.string().max(50).optional(),
  children: z.array(z.string()).optional(),
  is_published: z.boolean().optional(),
});

/** Schema upload asset — validate query params */
export const assetQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
  text_search: z.string().max(200).default(''),
});
