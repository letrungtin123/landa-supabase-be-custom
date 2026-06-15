import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  if (!env.SSO_CONFIG_ENCRYPTION_KEY) {
    throw new AppError('SSO_CONFIG_ENCRYPTION_KEY chưa được cấu hình', 500);
  }
  return createHash('sha256').update(env.SSO_CONFIG_ENCRYPTION_KEY).digest();
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string | null): string | null {
  if (!payload) return null;
  const [version, ivB64, tagB64, encryptedB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !encryptedB64) {
    throw new AppError('Định dạng SSO secret không hợp lệ', 500);
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
