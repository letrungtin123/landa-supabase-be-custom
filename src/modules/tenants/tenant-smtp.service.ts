import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { encryptSecret } from '../../utils/secret-crypto.js';
import type { UpdateTenantSmtpInput } from './tenant-smtp.validator.js';
import { createTenantSettingsRepository, type TenantSettingsDb, type TenantSmtpConfigRow } from './tenant-settings.repository.js';

export type TenantSmtpConfigForSend = TenantSmtpConfigRow;

const settingsRepository = createTenantSettingsRepository({ query } satisfies TenantSettingsDb);

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export async function getTenantSmtpConfig(tenantId: string) {
  const result = await settingsRepository.selectSmtpConfig(tenantId, false);

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
  const result = await settingsRepository.selectSmtpConfig(tenantId, true);
  return result.rows[0] ?? null;
}

export async function updateTenantSmtpConfig(tenantId: string, input: UpdateTenantSmtpInput) {
  if (!await settingsRepository.tenantExists(tenantId)) throw new AppError('Tenant khong ton tai', 404);

  const existingCiphertext = await settingsRepository.selectSmtpPasswordCiphertext(tenantId);

  if (input.is_enabled && !input.password && !existingCiphertext) {
    throw new AppError('Can nhap SMTP password/app password khi bat SMTP', 400);
  }

  const encrypted = input.password ? encryptSecret(input.password) : null;

  const written = await settingsRepository.upsertSmtpConfig(tenantId, {
    isEnabled: input.is_enabled,
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username,
    fromEmail: input.from_email,
    fromName: input.from_name || '',
    replyToEmail: input.reply_to_email ?? null,
    copyToSender: input.copy_to_sender,
    copyToEmail: input.copy_to_email ?? null,
    passwordCiphertext: encrypted?.ciphertext ?? null,
    passwordIv: encrypted?.iv ?? null,
    passwordAuthTag: encrypted?.authTag ?? null,
  });

  if (written === 0) throw new AppError('Khong the cap nhat SMTP', 500);
  return getTenantSmtpConfig(tenantId);
}

