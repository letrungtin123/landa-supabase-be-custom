import { query } from '../../config/database.js';
import { createWelcomeInitRepository, type TimestampLike, type WelcomeInitDb } from './welcome-init.repository.js';

const poolDb: WelcomeInitDb = { query };
const welcomeInitRepository = createWelcomeInitRepository(poolDb);

function iso(value: TimestampLike): string | null {
  return value ? new Date(value).toISOString() : null;
}

function isUndefinedTableError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

async function isDemoAccount(userId: string): Promise<boolean> {
  try {
    return await welcomeInitRepository.isDemoLoginAccount(userId);
  } catch (err) {
    if (isUndefinedTableError(err)) return false;
    throw err;
  }
}

export async function getWelcomeInitState(userId: string, isDemoIframe = false) {
  if (isDemoIframe) {
    return {
      should_show: true,
      has_seen: false,
      is_demo_account: true,
      shown_at: null,
      setup_required: false,
    };
  }

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
    const row = await welcomeInitRepository.selectWelcomeState(userId);
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

export async function markWelcomeInitSeen(userId: string, tenantId: string | null, isDemoIframe = false) {
  if (isDemoIframe) {
    return {
      should_show: false,
      has_seen: false,
      is_demo_account: true,
      shown_at: null,
      setup_required: false,
    };
  }

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
    const row = await welcomeInitRepository.upsertWelcomeSeen(userId, tenantId);

    return {
      should_show: false,
      has_seen: true,
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
