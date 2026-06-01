// ═══════════════════════════════════════════════════════════════
// Password Utils — bcrypt hash & compare
// Salt rounds lấy từ env, KHÔNG hardcode
// ═══════════════════════════════════════════════════════════════

import bcrypt from 'bcrypt';
import { env } from '../config/env.js';

/**
 * Hash password bằng bcrypt.
 * Salt rounds = env.BCRYPT_SALT_ROUNDS (mặc định 12).
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, env.BCRYPT_SALT_ROUNDS);
}

/**
 * So sánh password plaintext với hash đã lưu.
 */
export async function comparePassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
