// ═══════════════════════════════════════════════════════════════
// Audit Log Middleware — Ghi log hành động tự động
// Chạy async sau khi response đã gửi (không block request)
// ═══════════════════════════════════════════════════════════════

import type { Request } from 'express';
import { query } from '../config/database.js';

type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT';

interface AuditEntry {
  tenantId?: string | null;
  actorId?: string | null;
  actorUsername?: string;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  entityName?: string;
  details?: string;
  ipAddress?: string;
}

/**
 * Lấy IP address thực từ request (hỗ trợ proxy).
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Ghi audit log — chạy async, không throw error.
 * Fire-and-forget: không block request flow.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (tenant_id, actor_id, actor_username, action, entity_type, entity_id, entity_name, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.tenantId || null,
        entry.actorId || null,
        entry.actorUsername || null,
        entry.action,
        entry.entityType,
        entry.entityId || null,
        entry.entityName || null,
        entry.details || '',
        entry.ipAddress || null,
      ],
    );
  } catch (err) {
    // Log lỗi nhưng không crash app
    console.error('[AuditLog] Failed to write:', err);
  }
}

/**
 * Helper: tạo audit entry từ request context.
 */
export function auditFromReq(req: Request, action: AuditAction, entityType: string, entityId?: string, entityName?: string, details?: string): void {
  // Fire-and-forget — không await
  logAudit({
    tenantId: req.user?.tenantId,
    actorId: req.user?.id,
    actorUsername: req.user?.username,
    action,
    entityType,
    entityId,
    entityName,
    details,
    ipAddress: getClientIp(req),
  });
}
