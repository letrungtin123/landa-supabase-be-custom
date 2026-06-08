// ═══════════════════════════════════════════════════════════════
// Bot Validator — Zod schemas
// system_prompt removed — now managed via bot_personas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

export const createBotSchema = z.object({
  name: z.string().min(1, 'Tên bot không được để trống').max(255),
  kb_id: z.string().uuid().nullable().optional(),
  config: z.record(z.unknown()).optional(),
});

export const updateBotSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  kb_id: z.string().uuid().nullable().optional(),
  config: z.record(z.unknown()).optional(),
  avatar_url: z.string().nullable().optional(),
});

export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotInput = z.infer<typeof updateBotSchema>;
