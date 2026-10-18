// Env: browser origins the API answers or links to (part of `env`, see ../env.ts).
// A file of its own so that CORS_ORIGIN keeps its place among the required
// settings: after BCRYPT_SALT_ROUNDS (./auth.ts), before SUPABASE_URL (./storage.ts).

import './load.js';
import { required } from './helpers.js';

export const originsEnv = {
  // CORS
  CORS_ORIGIN: required('CORS_ORIGIN'),

  // Demo iframe public origin override (optional; use tenant.domain_learner when empty)
  DEMO_IFRAME_PUBLIC_ORIGIN: process.env.DEMO_IFRAME_PUBLIC_ORIGIN?.trim() || '',
} as const;
