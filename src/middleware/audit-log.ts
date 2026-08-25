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
// Mapping entity_type → { table, nameColumn } để auto-resolve tên khi thiếu
const ENTITY_NAME_MAP: Record<string, { table: string; col: string }> = {
  user: { table: 'users', col: 'username' },
  tenant: { table: 'tenants', col: 'name' },
  course: { table: 'courses', col: 'display_name' },
  document: { table: 'documents', col: 'title' },
  document_category: { table: 'document_categories', col: 'name' },
  permission_group: { table: 'permission_groups', col: 'name' },
  org_group: { table: 'org_groups', col: 'name' },
  sub_group: { table: 'sub_groups', col: 'name' },
  team: { table: 'teams', col: 'name' },
  module: { table: 'modules', col: 'name' },
  help_folder: { table: 'help_folders', col: 'title' },
  help_page: { table: 'help_pages', col: 'title' },
  course_category: { table: 'course_categories', col: 'name' },
  course_block: { table: 'course_blocks', col: 'display_name' },
  course_asset: { table: 'course_assets', col: 'display_name' },
  knowledgebase: { table: 'knowledgebases', col: 'name' },
  kb_document: { table: 'kb_documents', col: 'name' },
  chatbot: { table: 'chatbots', col: 'name' },
  assignment: { table: 'course_assignments', col: 'title' },
  lesson_author_job: { table: 'courses', col: 'display_name' },
  user_permission_groups: { table: 'users', col: 'username' },
  user_tenants: { table: 'users', col: 'username' },
  tenant_modules: { table: 'tenants', col: 'name' },
  tenant_role_labels: { table: 'tenants', col: 'name' },
  tenant_group_labels: { table: 'tenants', col: 'name' },
  tenant_smtp_config: { table: 'tenants', col: 'name' },
  sso_config: { table: 'tenants', col: 'name' },
  branding_image: { table: 'tenants', col: 'name' },
  dashboard_content: { table: 'tenants', col: 'name' },
  badge_setting: { table: 'tenants', col: 'name' },
  permission_matrix: { table: 'permission_groups', col: 'name' },
  permission_group_members: { table: 'permission_groups', col: 'name' },
  team_member: { table: 'teams', col: 'name' },
  team_course: { table: 'teams', col: 'name' },
  team_category: { table: 'teams', col: 'name' },
  team_doc_category: { table: 'teams', col: 'name' },
  team_course_category: { table: 'teams', col: 'name' },
  course_mentor_section: { table: 'courses', col: 'display_name' },
  course_modal_config: { table: 'courses', col: 'display_name' },
  section_modal_config: { table: 'courses', col: 'display_name' },
};

/**
 * Auto-resolve entity name từ DB nếu chưa truyền.
 * Fire-and-forget, không block.
 */
async function resolveEntityName(entityType: string, entityId: string): Promise<string | null> {
  const mapping = ENTITY_NAME_MAP[entityType];
  if (!mapping) return null;
  try {
    const r = await query<Record<string, string>>(
      `SELECT ${mapping.col} AS name FROM ${mapping.table} WHERE id = $1 LIMIT 1`,
      [entityId],
    );
    return r.rows[0]?.name || null;
  } catch {
    return null;
  }
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    // Auto-resolve entity_name nếu thiếu mà có entityId
    let entityName = entry.entityName || null;
    if (!entityName && entry.entityId) {
      entityName = await resolveEntityName(entry.entityType, entry.entityId);
    }

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
        entityName,
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

export function auditFromReqForTenant(
  req: Request,
  tenantId: string,
  action: AuditAction,
  entityType: string,
  entityId?: string,
  entityName?: string,
  details?: string,
): void {
  logAudit({
    tenantId,
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
