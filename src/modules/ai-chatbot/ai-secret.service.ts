import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { env } from '../../config/env.js';

const CIPHER = 'aes-256-gcm';
const LEGACY_FORMAT_PREFIX = 'aes-256-gcm:v1';
const FORMAT_PREFIX = 'aes-256-gcm:v2';

function encryptionMaterial(options: { legacy: boolean }): string {
  const configured = options.legacy ? env.JWT_SECRET : env.AI_SECRET_ENCRYPTION_KEY;
  if (!configured && !options.legacy && !env.isProduction) {
    return env.JWT_SECRET;
  }
  if (!configured || configured.trim().length === 0) {
    throw new Error(options.legacy
      ? 'Legacy AI secret encryption key is not configured'
      : 'AI_SECRET_ENCRYPTION_KEY is required before storing AI provider keys in production');
  }
  return configured.trim();
}

function encryptionKey(options: { legacy: boolean }): Buffer {
  return createHash('sha256').update(encryptionMaterial(options)).digest();
}

export function fingerprintAiProviderKey(apiKey: string): string {
  return `hmac-sha256:v1:${createHmac('sha256', env.JWT_SECRET).update(apiKey.trim()).digest('hex')}`;
}

export function encryptAiProviderKey(apiKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, encryptionKey({ legacy: false }), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey.trim(), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptAiProviderKey(value: string): string {
  const [prefixA, prefixB, ivValue, tagValue, encryptedValue] = value.split(':');
  const prefix = [prefixA, prefixB].join(':');
  if ((prefix !== FORMAT_PREFIX && prefix !== LEGACY_FORMAT_PREFIX) || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('AI provider key has an unsupported encryption format');
  }
  const decipher = createDecipheriv(
    CIPHER,
    encryptionKey({ legacy: prefix === LEGACY_FORMAT_PREFIX }),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
