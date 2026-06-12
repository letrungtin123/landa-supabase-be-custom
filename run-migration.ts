import { query, pool } from './src/config/database.js';
import fs from 'fs';
import path from 'path';

async function run() {
  try {
    console.log('Running migration...');
    const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '004_tenant_badge_settings.sql'), 'utf8');
    await query(sql);
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}
run();
