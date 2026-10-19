// ═══════════════════════════════════════════════════════════════
// Email templates repository: a tenant's custom email templates and the SMTP
// readiness columns. SQL only, moved unchanged from
// email-templates.service.ts, which keeps the rules (template keys,
// normalizing, placeholders, SMTP readiness, caches, messages).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface EmailTemplatesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface TenantEmailTemplateRow {
  tenant_id: string;
  template_key: string;
  subject_template: string;
  preheader_template: string;
  body_template: string;
  is_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SmtpReadinessRow {
  is_enabled: boolean;
  host: string | null;
  username: string | null;
  from_email: string | null;
  password_ciphertext: string | null;
  password_iv: string | null;
  password_auth_tag: string | null;
}

export function createEmailTemplatesRepository(db: EmailTemplatesDb) {
  return {
    /** The tenant's enabled custom template for this key. */
    async selectTemplate<Row extends QueryResultRow = TenantEmailTemplateRow>(tenantId: string, key: string): Promise<Row | undefined> {
      const result = await db.query<Row>(
        `SELECT tenant_id, template_key, subject_template, preheader_template, body_template,
                       is_enabled, updated_at, updated_by
                FROM tenant_email_templates
                WHERE tenant_id = $1::uuid
                  AND template_key = $2
                  AND is_enabled = true
                LIMIT 1`,
        [tenantId, key],
      );
      return result.rows[0];
    },

    /** Every enabled custom template of the tenant. */
    async selectTemplates<Row extends QueryResultRow = TenantEmailTemplateRow>(tenantId: string): Promise<Row[]> {
      const result = await db.query<Row>(
        `SELECT tenant_id, template_key, subject_template, preheader_template, body_template,
                is_enabled, updated_at, updated_by
         FROM tenant_email_templates
         WHERE tenant_id = $1::uuid
           AND is_enabled = true`,
        [tenantId],
      );
      return result.rows;
    },

    async selectSmtpReadiness(tenantId: string): Promise<SmtpReadinessRow | undefined> {
      const result = await db.query<SmtpReadinessRow>(
        `SELECT is_enabled, host, username, from_email,
                password_ciphertext, password_iv, password_auth_tag
         FROM tenant_smtp_configs
         WHERE tenant_id = $1::uuid
         LIMIT 1`,
        [tenantId],
      );
      return result.rows[0];
    },

    /** Inserts or replaces (and re-enables) the tenant's template for this key. */
    async upsertTemplate<Row extends QueryResultRow = TenantEmailTemplateRow>(values: {
      tenantId: string;
      key: string;
      subjectTemplate: string;
      preheaderTemplate: string;
      bodyTemplate: string;
      updatedBy: string;
    }): Promise<Row> {
      const result = await db.query<Row>(
        `INSERT INTO tenant_email_templates (
           tenant_id, template_key, subject_template, preheader_template, body_template,
           is_enabled, updated_by, updated_at
         )
         VALUES ($1::uuid, $2, $3, $4, $5, true, $6::uuid, now())
         ON CONFLICT (tenant_id, template_key) DO UPDATE SET
           subject_template = EXCLUDED.subject_template,
           preheader_template = EXCLUDED.preheader_template,
           body_template = EXCLUDED.body_template,
           is_enabled = true,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING tenant_id, template_key, subject_template, preheader_template, body_template,
                   is_enabled, updated_at, updated_by`,
        [values.tenantId, values.key, values.subjectTemplate, values.preheaderTemplate, values.bodyTemplate, values.updatedBy],
      );
      return result.rows[0];
    },

    async deleteTemplate(tenantId: string, key: string): Promise<void> {
      await db.query(
        `DELETE FROM tenant_email_templates
         WHERE tenant_id = $1::uuid
           AND template_key = $2`,
        [tenantId, key],
      );
    },
  };
}

export type EmailTemplatesRepository = ReturnType<typeof createEmailTemplatesRepository>;
