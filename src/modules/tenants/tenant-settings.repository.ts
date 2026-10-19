// ═══════════════════════════════════════════════════════════════
// Tenant settings repository: SMTP configuration and the custom role and
// group hierarchy labels. SQL only, moved unchanged from
// tenant-smtp.service.ts, tenant-role-labels.service.ts and
// tenant-group-labels.service.ts, which keep the rules (validation,
// messages, transactions, audit entries, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { UserRole } from '../../types/index.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface TenantSettingsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface TenantSmtpConfigRow {
  tenant_id: string;
  is_enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from_email: string;
  from_name: string | null;
  reply_to_email: string | null;
  copy_to_sender: boolean;
  copy_to_email: string | null;
  password_ciphertext: string | null;
  password_iv: string | null;
  password_auth_tag: string | null;
}

export type TenantSmtpConfigValues = {
  isEnabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromEmail: string;
  fromName: string;
  replyToEmail: string | null;
  copyToSender: boolean;
  copyToEmail: string | null;
  /** Null keeps the stored password. */
  passwordCiphertext: string | null;
  passwordIv: string | null;
  passwordAuthTag: string | null;
};

export type RoleLabelRow = { role: UserRole; label: string };

export type GroupLabelRow<Key extends string = string> = { label_key: Key; label: string };

const SMTP_CONFIG_COLUMNS = `tenant_id, is_enabled, host, port, secure, username, from_email, from_name,
            reply_to_email, copy_to_sender, copy_to_email,
            password_ciphertext, password_iv, password_auth_tag`;

export function createTenantSettingsRepository(db: TenantSettingsDb) {
  return {
    async tenantExists(tenantId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      return result.rowCount !== 0;
    },

    // ── SMTP ──

    /** `enabledOnly`: only a configuration that is turned on. */
    async selectSmtpConfig(tenantId: string, enabledOnly: boolean): Promise<QueryResult<TenantSmtpConfigRow>> {
      return db.query<TenantSmtpConfigRow>(
        `SELECT ${SMTP_CONFIG_COLUMNS}
         FROM tenant_smtp_configs
         WHERE tenant_id = $1${enabledOnly ? ' AND is_enabled = true' : ''}`,
        [tenantId],
      );
    },

    async selectSmtpPasswordCiphertext(tenantId: string): Promise<string | null | undefined> {
      const result = await db.query<{ password_ciphertext: string | null }>(
        'SELECT password_ciphertext FROM tenant_smtp_configs WHERE tenant_id = $1',
        [tenantId],
      );
      return result.rows[0]?.password_ciphertext;
    },

    /** Inserts or replaces the configuration; a null password keeps the stored one. Returns the row count. */
    async upsertSmtpConfig(tenantId: string, values: TenantSmtpConfigValues): Promise<number | null> {
      const result = await db.query<{ tenant_id: string }>(
        `INSERT INTO tenant_smtp_configs (
           tenant_id, is_enabled, host, port, secure, username, from_email, from_name,
           reply_to_email, copy_to_sender, copy_to_email,
           password_ciphertext, password_iv, password_auth_tag
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id) DO UPDATE SET
           is_enabled = EXCLUDED.is_enabled,
           host = EXCLUDED.host,
           port = EXCLUDED.port,
           secure = EXCLUDED.secure,
           username = EXCLUDED.username,
           from_email = EXCLUDED.from_email,
           from_name = EXCLUDED.from_name,
           reply_to_email = EXCLUDED.reply_to_email,
           copy_to_sender = EXCLUDED.copy_to_sender,
           copy_to_email = EXCLUDED.copy_to_email,
           password_ciphertext = COALESCE(EXCLUDED.password_ciphertext, tenant_smtp_configs.password_ciphertext),
           password_iv = COALESCE(EXCLUDED.password_iv, tenant_smtp_configs.password_iv),
           password_auth_tag = COALESCE(EXCLUDED.password_auth_tag, tenant_smtp_configs.password_auth_tag)
         RETURNING tenant_id`,
        [
          tenantId,
          values.isEnabled,
          values.host,
          values.port,
          values.secure,
          values.username,
          values.fromEmail,
          values.fromName,
          values.replyToEmail,
          values.copyToSender,
          values.copyToEmail,
          values.passwordCiphertext,
          values.passwordIv,
          values.passwordAuthTag,
        ],
      );
      return result.rowCount;
    },

    // ── Role labels ──

    async selectRoleLabels(tenantId: string): Promise<RoleLabelRow[]> {
      const result = await db.query<RoleLabelRow>(
        `SELECT role::text AS role, label
         FROM tenant_role_labels
         WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows;
    },

    async deleteRoleLabels(tenantId: string): Promise<void> {
      await db.query('DELETE FROM tenant_role_labels WHERE tenant_id = $1', [tenantId]);
    },

    async insertRoleLabel(tenantId: string, role: UserRole, label: string, actorId: string | null): Promise<void> {
      await db.query(
        `INSERT INTO tenant_role_labels (tenant_id, role, label, updated_by, updated_at)
         VALUES ($1, $2::user_role, $3, $4, now())`,
        [tenantId, role, label, actorId],
      );
    },

    // ── Group hierarchy labels ──

    async selectGroupLabels<Key extends string>(tenantId: string): Promise<GroupLabelRow<Key>[]> {
      const result = await db.query<GroupLabelRow<Key>>(
        `SELECT label_key, label
         FROM tenant_group_labels
         WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows;
    },

    async deleteGroupLabels(tenantId: string): Promise<void> {
      await db.query('DELETE FROM tenant_group_labels WHERE tenant_id = $1', [tenantId]);
    },

    async insertGroupLabel(tenantId: string, labelKey: string, label: string, actorId: string | null): Promise<void> {
      await db.query(
        `INSERT INTO tenant_group_labels (tenant_id, label_key, label, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [tenantId, labelKey, label, actorId],
      );
    },
  };
}

export type TenantSettingsRepository = ReturnType<typeof createTenantSettingsRepository>;
