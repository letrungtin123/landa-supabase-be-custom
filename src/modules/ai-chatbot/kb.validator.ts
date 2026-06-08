// ═══════════════════════════════════════════════════════════════
// Knowledge Base Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createKbSchema = z.object({
  name: z.string().min(1, 'Tên KB không được để trống').max(255),
  description: z.string().max(2000).optional(),
});

export const updateKbSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
});

/** Allowed file extensions for KB document upload (Files tab) */
export const ALLOWED_KB_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt', '.md', '.pptx', '.csv'];
export const MAX_KB_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/** FAQ tab — only xlsx/xls */
export const ALLOWED_FAQ_EXTENSIONS = ['.xlsx', '.xls'];
export const MAX_FAQ_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** Article schema */
export const createArticleSchema = z.object({
  title: z.string().min(1, 'Tiêu đề không được để trống').max(500),
  content: z.string().min(1, 'Nội dung không được để trống').max(200_000),
});

export const updateArticleSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(200_000).optional(),
  expected_updated_at: z.string().optional(),
});

export type CreateKbInput = z.infer<typeof createKbSchema>;
export type UpdateKbInput = z.infer<typeof updateKbSchema>;
export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
