// ═══════════════════════════════════════════════════════════════
// Env Config — Validate tất cả biến môi trường bắt buộc
// CRASH ngay nếu thiếu biến — KHÔNG fallback
// ═══════════════════════════════════════════════════════════════

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Xác định thư mục gốc project (chứa .env files)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

// Load env file theo NODE_ENV — KHÔNG fallback, KHÔNG cross-load
const isProd = process.env.NODE_ENV === 'production';
const envFile = isProd ? '.env.production' : '.env';
const envPath = path.resolve(rootDir, envFile);
const result = dotenvConfig({ path: envPath });

if (result.error) {
  console.error(`[Env] KHÔNG tìm thấy ${envFile} tại ${envPath}`);
  process.exit(1);
}
console.log(`[Env] Loaded ${envFile}`);

/**
 * Đọc biến môi trường bắt buộc — throw nếu thiếu hoặc rỗng.
 */
function required(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[ENV] Thiếu biến môi trường bắt buộc: ${key}`);
  }
  return value.trim();
}

/**
 * Đọc biến môi trường kiểu số — throw nếu không hợp lệ.
 */
function requiredInt(key: string): number {
  const raw = required(key);
  const num = parseInt(raw, 10);
  if (isNaN(num)) {
    throw new Error(`[ENV] ${key} phải là số nguyên, nhận: "${raw}"`);
  }
  return num;
}

export const env = {
  NODE_ENV: required('NODE_ENV'),
  PORT: requiredInt('PORT'),

  // Database
  DATABASE_URL: required('DATABASE_URL'),

  // JWT
  JWT_SECRET: required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES_IN: required('JWT_ACCESS_EXPIRES_IN'),
  JWT_REFRESH_EXPIRES_IN: required('JWT_REFRESH_EXPIRES_IN'),

  // Bcrypt
  BCRYPT_SALT_ROUNDS: requiredInt('BCRYPT_SALT_ROUNDS'),

  // CORS
  CORS_ORIGIN: required('CORS_ORIGIN'),

  // Supabase Storage
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),

  // RabbitMQ (mandatory — crash if missing)
  RABBITMQ_URL: required('RABBITMQ_URL'),

  // Gemini temp directory (optional — default ./tmp/gemini)
  GEMINI_TEMP_DIR: process.env.GEMINI_TEMP_DIR?.trim() || './tmp/gemini',

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
