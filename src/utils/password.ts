// ═══════════════════════════════════════════════════════════════
// Password Utils — bcrypt hash & compare
// Salt rounds lấy từ env, KHÔNG hardcode
// ═══════════════════════════════════════════════════════════════

import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
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

let dummyHash: Promise<string> | null = null;

/**
 * Runs a full bcrypt comparison against a throwaway hash of the configured
 * cost. Used when a sign-in names no account, so an unknown name takes as
 * long to refuse as a wrong password. Always resolves to false.
 */
export async function compareAgainstDummyPassword(plaintext: string): Promise<false> {
  dummyHash ??= bcrypt.hash(randomBytes(24).toString('base64'), env.BCRYPT_SALT_ROUNDS);
  await bcrypt.compare(plaintext, await dummyHash);
  return false;
}
