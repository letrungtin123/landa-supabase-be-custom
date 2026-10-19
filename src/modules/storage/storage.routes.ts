// ═══════════════════════════════════════════════════════════════
// Storage Proxy routes — GET /api/storage/* (no auth, like a public bucket).
// The handler is in storage-proxy.controller.ts.
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { createStorageProxyHandler, type StorageProxyOptions } from './storage-proxy.controller.js';

export type { StorageProxyOptions };

const BUCKET = 'landa-storage';

export function createStorageProxyRouter(options: StorageProxyOptions): Router {
  const router = Router();
  router.get('/*path', createStorageProxyHandler(options));
  return router;
}

// Supabase admin client (service_role — bypass RLS)
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default createStorageProxyRouter({
  publicUrlFor: (storagePath) => supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl,
});
