// ═══════════════════════════════════════════════════════════════
// Knowledge base restore rules: which restore states are active, and why a
// knowledge base's Gemini store needs a restore for the tenant's current
// key. Pure; moved unchanged from kb.service.ts.
// ═══════════════════════════════════════════════════════════════

import type { KbGeminiStore } from './kb.repository.js';

const ACTIVE_RESTORE_STATES = new Set(['queued', 'restoring', 'uploading']);
const RESTORE_REQUIRED_STORE_STATUSES = new Set(['key_changed', 'permission_denied', 'not_found']);

export function isRestoreActiveState(state?: string | null): boolean {
  return ACTIVE_RESTORE_STATES.has(state || '');
}

export function getRestoreReasonFromStore(
  store: Pick<KbGeminiStore, 'api_key_fingerprint' | 'remote_status' | 'remote_error_reason'> | null | undefined,
  currentFingerprint: string | null,
): string | null {
  if (!store) return null;
  if (RESTORE_REQUIRED_STORE_STATUSES.has(store.remote_status)) {
    return store.remote_error_reason || store.remote_status;
  }
  if (store.remote_status !== 'active') return null;
  if (!currentFingerprint) return 'Gemini API key is missing. Configure a key before restoring this KB.';
  if (store.api_key_fingerprint && store.api_key_fingerprint !== currentFingerprint) return 'Gemini API key was changed.';
  return null;
}
