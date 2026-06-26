// ═══════════════════════════════════════════════════════════════
// Dashboard Content Validator — Zod schemas + constants
// Validate nội dung Hero Card + Tips cho /dashboard FE 5173
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema cho 1 tip (1 trang) */
const tipSchema = z.object({
  title: z.string().min(1, 'Câu nói không được để trống').max(200, 'Câu nói tối đa 200 ký tự'),
  desc: z.string().min(1, 'Tác giả không được để trống').max(100, 'Tác giả tối đa 100 ký tự'),
});

/** Schema validate input khi admin cập nhật */
export const upsertDashboardContentSchema = z.object({
  hero_badge: z
    .string()
    .max(20, 'Badge tối đa 20 ký tự')
    .optional()
    .nullable()
    .transform((v) => v?.trim() || null),
  hero_title: z
    .string()
    .max(200, 'Tiêu đề tối đa 200 ký tự')
    .optional()
    .nullable()
    .transform((v) => v?.trim() || null),
  tips: z
    .array(tipSchema)
    .max(2, 'Tối đa 2 tips')
    .optional()
    .nullable(),
  // ── Explore page hero card ──
  explore_hero_badge: z
    .string()
    .max(20, 'Badge Explore tối đa 20 ký tự')
    .optional()
    .nullable()
    .transform((v) => v?.trim() || null),
  explore_hero_title: z
    .string()
    .max(200, 'Tiêu đề Explore tối đa 200 ký tự')
    .optional()
    .nullable()
    .transform((v) => v?.trim() || null),
});

export type UpsertDashboardContentInput = z.infer<typeof upsertDashboardContentSchema>;

/** Cấu trúc data lưu trong tenants.settings.dashboard_content */
export interface DashboardContentData {
  hero_badge: string | null;
  hero_title: string | null;
  tips: Array<{ title: string; desc: string }> | null;
  explore_hero_badge: string | null;
  explore_hero_title: string | null;
}
