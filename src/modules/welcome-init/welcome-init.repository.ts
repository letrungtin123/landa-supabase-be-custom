// ═══════════════════════════════════════════════════════════════
// Welcome init repository: whether a user is a demo login account and when
// the user first saw the welcome screen. SQL only; moved unchanged from
// welcome-init.service.ts, which keeps the rules (demo sessions, a missing
// table during a deploy).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction). */
export interface WelcomeInitDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type TimestampLike = Date | string | null;

export interface WelcomeInitRow {
  shown_at: TimestampLike;
}

interface DemoAccountRow {
  is_demo_account: boolean;
}

export function createWelcomeInitRepository(db: WelcomeInitDb) {
  return {
    async isDemoLoginAccount(userId: string): Promise<boolean> {
      const result = await db.query<DemoAccountRow>(
        `SELECT EXISTS (
         SELECT 1
         FROM tenant_demo_login_accounts
         WHERE user_id = $1
       ) AS is_demo_account`,
        [userId],
      );
      return result.rows[0]?.is_demo_account === true;
    },

    /** The user's welcome state row, if the user has seen the screen. */
    async selectWelcomeState(userId: string): Promise<WelcomeInitRow | undefined> {
      const result = await db.query<WelcomeInitRow>(
        'SELECT shown_at FROM user_welcome_init_states WHERE user_id = $1',
        [userId],
      );
      return result.rows[0];
    },

    /** Records that the user saw the screen (the first time stays); the stored row. */
    async upsertWelcomeSeen(userId: string, tenantId: string | null): Promise<WelcomeInitRow | undefined> {
      const result = await db.query<WelcomeInitRow>(
        `INSERT INTO user_welcome_init_states (user_id, tenant_id, shown_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         tenant_id = COALESCE(EXCLUDED.tenant_id, user_welcome_init_states.tenant_id),
         updated_at = now()
       RETURNING shown_at`,
        [userId, tenantId],
      );
      return result.rows[0];
    },
  };
}
