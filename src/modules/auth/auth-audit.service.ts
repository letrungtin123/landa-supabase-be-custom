// ═══════════════════════════════════════════════════════════════
// Auth audit — best-effort records of sign-in events
// ═══════════════════════════════════════════════════════════════

import type { Request } from 'express';
import { withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, getClientIp, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import type { StructuredAuditEvent } from '../audit-logs/audit-event.contract.js';

export interface AuthAuditActor {
  id: string;
  username: string;
  role: string;
  tenant_id: string | null;
}

const OPERATOR_ROLES = new Set(['staff', 'superuser', 'superadmin']);

/**
 * Authentication availability must not depend on tenant quota. Sign-in
 * events are recorded best effort: a rejected audit write is logged for
 * operations and never fails the login, logout or SSO exchange it describes.
 * `operatorsOnly` keeps routine learner sign-ins out of the log (staff+ only).
 */
export async function appendBestEffortAuthAudit(
  req: Request,
  actor: AuthAuditActor,
  input: { action: TransactionalAuditEntry['action']; event: StructuredAuditEvent; operatorsOnly: boolean },
): Promise<void> {
  if (input.operatorsOnly && !OPERATOR_ROLES.has(actor.role)) return;
  const isPlatformEvent = actor.role === 'superadmin' || !actor.tenant_id;
  const entry: TransactionalAuditEntry = {
    tenantId: isPlatformEvent ? null : actor.tenant_id,
    platformEvent: isPlatformEvent,
    actorId: actor.id,
    actorUsername: actor.username,
    action: input.action,
    entityType: 'user',
    entityId: actor.id,
    entityName: actor.username,
    ipAddress: getClientIp(req),
    event: input.event,
  };
  try {
    await withDatabaseTransaction((client) => appendAuditLog(client, entry));
  } catch (error) {
    console.error(`[Audit] Could not record ${input.event.code} for ${actor.id}:`, error);
  }
}
