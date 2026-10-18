// Env: sign-in rate limits, JWT, bcrypt, session revocation and SSO secrets (part of `env`, see ../env.ts).

import './load.js';
import {
  optionalBoolean,
  optionalBoundedInt,
  optionalBoundedIntWithLegacyName,
  required,
  requiredInt,
} from './helpers.js';

export const authEnv = {
  // Auth rate limits, per 15-minute window. Counters are shared through Redis
  // when it is available.
  // Refused sign-ins (4xx) per client address, SSO code exchanges included.
  // Successful sign-ins are not counted, so a whole office behind one NAT can
  // sign in. The old name AUTH_LOGIN_IP_MAX_ATTEMPTS (it counted every
  // attempt) is still read as this cap when the new name is not set.
  AUTH_LOGIN_IP_MAX_FAILURES: optionalBoundedIntWithLegacyName(
    'AUTH_LOGIN_IP_MAX_FAILURES',
    'AUTH_LOGIN_IP_MAX_ATTEMPTS',
    300,
    1,
    100_000,
  ),
  // Failed sign-ins per typed account (successful sign-ins are not counted).
  AUTH_LOGIN_ACCOUNT_MAX_FAILURES: optionalBoundedInt('AUTH_LOGIN_ACCOUNT_MAX_FAILURES', 10, 1, 1_000),
  // Session refreshes per refresh token (each token is valid for one use).
  AUTH_REFRESH_TOKEN_MAX_ATTEMPTS: optionalBoundedInt('AUTH_REFRESH_TOKEN_MAX_ATTEMPTS', 10, 1, 1_000),
  // Refused session refreshes (4xx) per client address: a flood of invented
  // tokens is stopped while valid refreshes of many users behind one NAT pass.
  AUTH_REFRESH_IP_MAX_FAILURES: optionalBoundedInt('AUTH_REFRESH_IP_MAX_FAILURES', 2_000, 1, 100_000),
  AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS: optionalBoundedInt('AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS', 10, 1, 1_000),
  // One-time sign-in links (create + use) and profile updates, per user or IP.
  AUTH_ACCOUNT_ACTION_MAX_ATTEMPTS: optionalBoundedInt('AUTH_ACCOUNT_ACTION_MAX_ATTEMPTS', 30, 1, 10_000),

  // JWT
  JWT_SECRET: required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES_IN: required('JWT_ACCESS_EXPIRES_IN'),
  JWT_REFRESH_EXPIRES_IN: required('JWT_REFRESH_EXPIRES_IN'),

  // Bcrypt
  BCRYPT_SALT_ROUNDS: requiredInt('BCRYPT_SALT_ROUNDS'),

  // Production refuses to start without Redis for access-token revocation
  // unless this is false (REDIS_* are in ./messaging.ts).
  AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION: optionalBoolean('AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION', true),

  // SSO config encryption (optional until SSO secrets are configured)
  SSO_CONFIG_ENCRYPTION_KEY: process.env.SSO_CONFIG_ENCRYPTION_KEY?.trim() || '',
} as const;
