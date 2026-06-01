// ═══════════════════════════════════════════════════════════════
// Seed Script — Tạo superadmin user ban đầu
// Chạy: npm run seed
// ═══════════════════════════════════════════════════════════════

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { pool, query } from '../config/database.js';
import { hashPassword } from '../utils/password.js';

async function seed() {
  console.log('[Seed] Bắt đầu seed database...');

  // Hash password cho superadmin
  const password = 'Admin@123';
  const hash = await hashPassword(password);

  // Upsert superadmin
  const result = await query(
    `INSERT INTO users (username, email, password_hash, full_name, role, tenant_id)
     VALUES ($1, $2, $3, $4, $5, NULL)
     ON CONFLICT (username) DO UPDATE SET password_hash = $3
     RETURNING id, username, role`,
    ['superadmin', 'admin@landa.vn', hash, 'Super Admin', 'superadmin'],
  );

  console.log('[Seed] Superadmin:', result.rows[0]);
  console.log(`[Seed] Password: ${password}`);
  console.log('[Seed] ⚠️  Đổi password sau khi deploy production!');

  await pool.end();
  console.log('[Seed] Done!');
}

seed().catch(function handleError(err) {
  console.error('[Seed] Error:', err);
  process.exit(1);
});
