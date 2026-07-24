// ═══════════════════════════════════════════════════════════════
// Express Request Extension — Gắn user info vào request
// ═══════════════════════════════════════════════════════════════

/**
 * Thông tin user đã xác thực — gắn bởi authenticate middleware.
 */
export interface AuthUser {
  id: string;
  tenantId: string | null;
  role: 'learner' | 'learner_plus' | 'staff' | 'superuser' | 'superadmin';
  username: string;
  sessionMode: 'normal' | 'demo_iframe';
}

declare global {
  namespace Express {
    interface Request {
      /** User đã xác thực (set bởi authenticate middleware) */
      user?: AuthUser;
    }
  }
}
