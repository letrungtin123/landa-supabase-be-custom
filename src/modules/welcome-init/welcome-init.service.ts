import { query } from '../../config/database.js';

type TimestampLike = Date | string | null;

interface WelcomeInitRow {
  shown_at: TimestampLike;
}

interface DemoAccountRow {
  is_demo_account: boolean;
}

function iso(value: TimestampLike): string | null {
  return value ? new Date(value).toISOString() : null;
}

function isUndefinedTableError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

async function isDemoAccount(userId: string): Promise<boolean> {
  try {
    const result = await query<DemoAccountRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM tenant_demo_login_accounts
         WHERE user_id = $1
       ) AS is_demo_account`,
      [userId],
    );
    return result.rows[0]?.is_demo_account === true;
  } catch (err) {
    if (isUndefinedTableError(err)) return false;
    throw err;
  }
}

export async function getWelcomeInitState(userId: string) {
  const demoAccount = await isDemoAccount(userId);
  if (demoAccount) {
    return {
      should_show: true,
      has_seen: false,
      is_demo_account: true,
      shown_at: null,
      setup_required: false,
    };
  }

  try {
    const result = await query<WelcomeInitRow>(
      'SELECT shown_at FROM user_welcome_init_states WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    const hasSeen = !!row;
    return {
      should_show: !hasSeen,
      has_seen: hasSeen,
      is_demo_account: false,
      shown_at: iso(row?.shown_at || null),
      setup_required: false,
    };
  } catch (err) {
    if (isUndefinedTableError(err)) {
      return {
        should_show: false,
        has_seen: true,
        is_demo_account: false,
        shown_at: null,
        setup_required: true,
      };
    }
    throw err;
  }
}

export async function markWelcomeInitSeen(userId: string, tenantId: string | null) {
  const demoAccount = await isDemoAccount(userId);
  if (demoAccount) {
    return {
      should_show: false,
      has_seen: false,
      is_demo_account: true,
      shown_at: null,
      setup_required: false,
    };
  }

  try {
    const result = await query<WelcomeInitRow>(
      `INSERT INTO user_welcome_init_states (user_id, tenant_id, shown_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         tenant_id = COALESCE(EXCLUDED.tenant_id, user_welcome_init_states.tenant_id),
         updated_at = now()
       RETURNING shown_at`,
      [userId, tenantId],
    );

    return {
      should_show: false,
      has_seen: true,
      is_demo_account: false,
      shown_at: iso(result.rows[0]?.shown_at || null),
      setup_required: false,
    };
  } catch (err) {
    if (isUndefinedTableError(err)) {
      return {
        should_show: false,
        has_seen: true,
        is_demo_account: false,
        shown_at: null,
        setup_required: true,
      };
    }
    throw err;
  }
}
