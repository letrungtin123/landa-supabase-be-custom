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

// Load .env.production nếu NODE_ENV=production, ngược lại load .env
// Ưu tiên: .env.production (production) → .env (fallback)
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenvConfig({ path: path.resolve(rootDir, envFile) });
// Luôn load .env làm fallback (các biến chưa có trong .env.production sẽ lấy từ .env)
dotenvConfig({ path: path.resolve(rootDir, '.env') });

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

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
