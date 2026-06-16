// ═══════════════════════════════════════════════════════════════
// Auth Validator — Zod schemas cho login, refresh, etc.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema đăng nhập */
export const loginSchema = z.object({
  username: z.string().min(1, 'Username không được để trống'),
  password: z.string().min(1, 'Password không được để trống'),
  client_app: z.enum(['admin', 'learner']).optional(),
});

/** Schema refresh token */
export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token không được để trống'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
