// ═══════════════════════════════════════════════════════════════
// Audit Log Middleware — structured, transactional audit entries only.
// ═══════════════════════════════════════════════════════════════

import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { withDatabaseTransaction } from '../config/database.js';
import { normalizeStructuredAuditEvent, type StructuredAuditEvent } from '../modules/audit-logs/audit-event.contract.js';

type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT';

/**
 * Immutable, server-generated identity of an audited subject that can be
 * permanently removed later. Do not put this in event_metadata: list APIs
 * return metadata for every row, while subject email is detail-only PII.
 */
export interface AuditSubjectSnapshot {
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface TransactionalAuditEntry {
  tenantId?: string | null;
  actorId?: string | null;
  actorUsername?: string;
  /** Only platform/global events may intentionally have no tenant owner. */
  platformEvent?: boolean;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  entityName?: string;
  ipAddress?: string;
  event: StructuredAuditEvent;
  /** Only server-side deletion flows may provide a subject snapshot. */
  subject?: AuditSubjectSnapshot;
}

function normalizeSnapshotText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeSubjectSnapshot(subject: AuditSubjectSnapshot | undefined): Required<AuditSubjectSnapshot> {
  return {
    displayName: normalizeSnapshotText(subject?.displayName, 160),
    username: normalizeSnapshotText(subject?.username, 150),
    email: normalizeSnapshotText(subject?.email?.toLowerCase(), 254),
    role: normalizeSnapshotText(subject?.role, 50),
  };
}

/**
 * Lấy IP address thực từ request (hỗ trợ proxy).
 */
export function getClientIp(req: Request): string {
  // Express derives req.ip from its configured `trust proxy` policy. Reading
  // X-Forwarded-For directly would let an untrusted client forge audit IPs.
  const candidate = req.ip || req.socket.remoteAddress || 'unknown';
  return candidate.slice(0, 45);
}

/**
 * Appends a structured audit record through the caller's existing transaction.
 * The transaction owner must await this before COMMIT; this is deliberately not
 * fire-and-forget, so a quota/database failure rolls the business write back.
 */
export async function appendAuditLog(client: PoolClient, entry: TransactionalAuditEntry): Promise<void> {
  const structured = normalizeStructuredAuditEvent(entry.event);
  const subject = normalizeSubjectSnapshot(entry.subject);
  if (!entry.tenantId && !entry.platformEvent) {
    throw new Error('Audit log thiếu doanh nghiệp sở hữu');
  }
  const viewerScope = entry.platformEvent ? 'superadmin_only' : structured.viewerScope;

  // Snapshot PII only at the audited write, rather than enriching every
  // authenticated request. The primary-key lookup is O(1) and runs on the
  // same transaction, so the audit record cannot refer to a future profile.
  let actorDisplayName: string | null = null;
  let actorEmail: string | null = null;
  if (entry.actorId) {
    const actor = await client.query<{ full_name: string | null; email: string | null }>(
      `SELECT NULLIF(btrim(full_name), '') AS full_name,
              NULLIF(lower(btrim(email)), '') AS email
       FROM users
       WHERE id = $1::uuid
       LIMIT 1`,
      [entry.actorId],
    );
    actorDisplayName = actor.rows[0]?.full_name?.slice(0, 160) || null;
    actorEmail = actor.rows[0]?.email?.slice(0, 254) || null;
  }
  await client.query(
    `INSERT INTO audit_logs (
       tenant_id, is_platform_event, actor_id, actor_username, actor_display_name, actor_email, action, entity_type, entity_id,
       entity_name, details, ip_address, event_code, event_metadata, changes,
       viewer_scope, subject_display_name, subject_username, subject_email, subject_role
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '', $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19)`,
    [
      entry.tenantId || null,
      entry.platformEvent === true,
      entry.actorId || null,
      entry.actorUsername || null,
      actorDisplayName,
      actorEmail,
      entry.action,
      entry.entityType,
      entry.entityId || null,
      entry.entityName || null,
      entry.ipAddress || null,
      structured.eventCode,
      JSON.stringify(structured.metadata),
      JSON.stringify(structured.changes),
      viewerScope,
      subject.displayName,
      subject.username,
      subject.email,
      subject.role,
    ],
  );
}

/** Creates a superadmin-only platform event which must never inherit X-Tenant-ID. */
export function createPlatformTransactionalAuditEntry(
  req: Request,
  action: AuditAction,
  entityType: string,
  event: StructuredAuditEvent,
  entityId?: string,
  entityName?: string,
): TransactionalAuditEntry {
  return {
    ...createTransactionalAuditEntry(req, action, entityType, event, entityId, entityName),
    tenantId: null,
    platformEvent: true,
  };
}

export function createTransactionalAuditEntry(
  req: Request,
  action: AuditAction,
  entityType: string,
  event: StructuredAuditEvent,
  entityId?: string,
  entityName?: string,
): TransactionalAuditEntry {
  return {
    tenantId: req.user?.tenantId,
    actorId: req.user?.id,
    actorUsername: req.user?.username,
    action,
    entityType,
    entityId,
    entityName,
    ipAddress: getClientIp(req),
    event,
  };
}

/**
 * Runs a business write and its allowlisted audit record in exactly one
 * database transaction. If quota enforcement or the audit insert fails, the
 * business write is rolled back before the controller sends a success reply.
 */
export async function runAuditedTransaction<T>(
  operation: () => Promise<T>,
  createEntry: (result: T) => TransactionalAuditEntry | null | Promise<TransactionalAuditEntry | null>,
): Promise<T> {
  return withDatabaseTransaction(async (client) => {
    const result = await operation();
    const entry = await createEntry(result);
    if (entry) await appendAuditLog(client, entry);
    return result;
  });
}
