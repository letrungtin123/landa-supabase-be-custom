import crypto from 'crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/error-handler.js';

interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function getSecretKey(): Buffer {
  const raw = env.SMTP_CONFIG_ENCRYPTION_KEY || env.SSO_CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new AppError('Chua cau hinh SMTP_CONFIG_ENCRYPTION_KEY tren server', 500);
  }

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // Continue to hash fallback below.
  }

  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plainText: string): EncryptedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getSecretKey(),
    Buffer.from(secret.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

