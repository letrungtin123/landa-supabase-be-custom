import { z } from 'zod';

const uuid = z.string().uuid();

export const listNewsSchema = z.object({
  cursor: z.string().trim().max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'archived']).default('active'),
});

export const createNewsSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content_html: z.string().max(500_000),
  preview_image_path: z.string().trim().max(1_200).nullable().optional(),
  upload_session_id: uuid,
});

export const updateNewsSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  content_html: z.string().max(500_000).optional(),
  preview_image_path: z.string().trim().max(1_200).nullable().optional(),
  upload_session_id: uuid.optional(),
  expected_version: z.coerce.number().int().positive(),
}).refine(
  (value) => value.title !== undefined || value.content_html !== undefined || value.preview_image_path !== undefined,
  { message: 'Không có thay đổi để lưu' },
);

export const uploadNewsImageSchema = z.object({
  upload_session_id: uuid,
  kind: z.enum(['preview', 'inline']),
});

export const importNewsImageSchema = z.object({
  upload_session_id: uuid,
  source_url: z.string().trim().min(1).max(4_000),
});

export const deleteNewsImageSchema = z.object({
  storage_path: z.string().trim().min(1).max(1_200),
  upload_session_id: uuid.optional(),
});

export type ListNewsInput = z.infer<typeof listNewsSchema>;
export type CreateNewsInput = z.infer<typeof createNewsSchema>;
export type UpdateNewsInput = z.infer<typeof updateNewsSchema>;
