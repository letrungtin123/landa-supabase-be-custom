// ═══════════════════════════════════════════════════════════════
// Prompt Templates Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createTemplateSchema = z.object({
  name: z.string().min(1, 'Tên mascot không được trống').max(255),
  description: z.string().max(2000).optional().default(''),
  prompt: z.string().min(1, 'Prompt không được trống').max(20000),
  voice_prompt: z.string().max(4000).nullable().optional(),
  is_active: z.boolean().optional().default(false),
  is_lesson_author: z.boolean().optional().default(false),
  sort_order: z.number().int().min(0).optional().default(0),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  prompt: z.string().min(1).max(20000).optional(),
  voice_prompt: z.string().max(4000).nullable().optional(),
  is_active: z.boolean().optional(),
  is_lesson_author: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
