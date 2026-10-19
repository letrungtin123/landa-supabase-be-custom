// ═══════════════════════════════════════════════════════════════
// JSON request body limits
//
// The JSON parser runs before authentication. Routes whose bodies are known
// to be small parse them first with a small limit; the general parser then
// skips a body that was already read. Callers (learner and admin apps): the
// sign-in calls send a few short fields; learner routes send ids, answers
// and small state objects. Every other route keeps 10 MB. A body over its
// limit is answered 413 by the error handler.
// ═══════════════════════════════════════════════════════════════

import express, { type Express } from 'express';

export const SIGN_IN_JSON_BODY_LIMIT = '100kb';
export const LEARNER_JSON_BODY_LIMIT = '1mb';
export const DEFAULT_JSON_BODY_LIMIT = '10mb';

/** Sign-in, refresh, logout, one-time links, password change, SSO code exchange (not profile: its bio is free text). */
export const SIGN_IN_JSON_ROUTES = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/ott',
  '/api/auth/change-password',
  '/api/users/profile/change-password',
  '/api/sso/exchange',
];

/** Learner progress, completion, answers, badges, notifications and study time. */
export const LEARNER_JSON_ROUTES = ['/api/learner', '/api/enrollments/study-session'];

export function useJsonBodyParsers(app: Express): void {
  app.use(SIGN_IN_JSON_ROUTES, express.json({ limit: SIGN_IN_JSON_BODY_LIMIT }));
  app.use(LEARNER_JSON_ROUTES, express.json({ limit: LEARNER_JSON_BODY_LIMIT }));
  app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));
}

/**
 * Form bodies (application/x-www-form-urlencoded), parsed with qs
 * (`extended`: nested keys and arrays) within body-parser's defaults:
 * 100 KB, 1000 parameters, 32 levels. Query strings are not parsed with qs:
 * the app keeps Express 5's default `query parser` ('simple', node:querystring).
 */
export function useFormBodyParser(app: Express): void {
  app.use(express.urlencoded({ extended: true }));
}
