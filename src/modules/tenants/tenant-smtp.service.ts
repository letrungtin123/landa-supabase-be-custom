import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { encryptSecret } from '../../utils/secret-crypto.js';
import type { UpdateTenantSmtpInput } from './tenant-smtp.validator.js';

export interface TenantSmtpConfigForSend {
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

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export async function getTenantSmtpConfig(tenantId: string) {
  const result = await query<TenantSmtpConfigForSend>(
    `SELECT tenant_id, is_enabled, host, port, secure, username, from_email, from_name,
            reply_to_email, copy_to_sender, copy_to_email,
            password_ciphertext, password_iv, password_auth_tag
     FROM tenant_smtp_configs
     WHERE tenant_id = $1`,
    [tenantId],
  );

  if (result.rowCount === 0) {
    return {
      tenant_id: tenantId,
      is_enabled: false,
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      username: '',
      from_email: '',
      from_name: '',
      reply_to_email: null,
      copy_to_sender: true,
      copy_to_email: null,
      has_password: false,
      masked_username: null,
    };
  }

  const row = result.rows[0];
  return {
    tenant_id: row.tenant_id,
    is_enabled: row.is_enabled,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    from_email: row.from_email,
    from_name: row.from_name || '',
    reply_to_email: row.reply_to_email,
    copy_to_sender: row.copy_to_sender,
    copy_to_email: row.copy_to_email,
    has_password: Boolean(row.password_ciphertext),
    masked_username: maskEmail(row.username),
  };
}

export async function getTenantSmtpConfigForSend(tenantId: string): Promise<TenantSmtpConfigForSend | null> {
  const result = await query<TenantSmtpConfigForSend>(
    `SELECT tenant_id, is_enabled, host, port, secure, username, from_email, from_name,
            reply_to_email, copy_to_sender, copy_to_email,
            password_ciphertext, password_iv, password_auth_tag
     FROM tenant_smtp_configs
     WHERE tenant_id = $1 AND is_enabled = true`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

export async function updateTenantSmtpConfig(tenantId: string, input: UpdateTenantSmtpInput) {
  const tenant = await query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
  if (tenant.rowCount === 0) throw new AppError('Tenant khong ton tai', 404);

  const existing = await query<{ password_ciphertext: string | null }>(
    'SELECT password_ciphertext FROM tenant_smtp_configs WHERE tenant_id = $1',
    [tenantId],
  );

  if (input.is_enabled && !input.password && !existing.rows[0]?.password_ciphertext) {
    throw new AppError('Can nhap SMTP password/app password khi bat SMTP', 400);
  }

  const encrypted = input.password ? encryptSecret(input.password) : null;

  const result = await query(
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
      input.is_enabled,
      input.host,
      input.port,
      input.secure,
      input.username,
      input.from_email,
      input.from_name || '',
      input.reply_to_email ?? null,
      input.copy_to_sender,
      input.copy_to_email ?? null,
      encrypted?.ciphertext ?? null,
      encrypted?.iv ?? null,
      encrypted?.authTag ?? null,
    ],
  );

  if (result.rowCount === 0) throw new AppError('Khong the cap nhat SMTP', 500);
  return getTenantSmtpConfig(tenantId);
}

