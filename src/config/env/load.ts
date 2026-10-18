// ═══════════════════════════════════════════════════════════════
// Env file loading — runs before any setting is read
// ═══════════════════════════════════════════════════════════════
// ../env.ts imports this module first and every env/*.ts domain file imports
// it before its own code. ES modules evaluate their imports first, in order,
// so the .env file is loaded before the first process.env read.

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Xác định thư mục gốc project (chứa .env files): src/config/env (dist/config/env) → ../../..
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..', '..');

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

// Local-only overrides make `npm run dev` usable without editing or copying
// production secrets. The file is gitignored and is never loaded by PM2.
if (!isProd) {
  const localEnvPath = path.resolve(rootDir, '.env.development.local');
  const localResult = dotenvConfig({ path: localEnvPath, override: true });
  if (!localResult.error) console.log('[Env] Loaded .env.development.local overrides');
}
