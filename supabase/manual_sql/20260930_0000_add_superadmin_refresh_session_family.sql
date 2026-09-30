-- Title: Isolate refresh-token reuse revocation by superadmin session family
-- Purpose: Allow a superadmin to use multiple devices without a refresh-token
--          reuse incident on one device revoking every superadmin session.
-- Affected schema: public
-- Affected tables: public.refresh_tokens
-- Risk level: Medium — authentication session metadata
-- Execution owner: User/manual only
-- Direct execution by Codex: Forbidden
-- Backup recommendation: Back up public.refresh_tokens before execution.
-- Notes: Deploy the backend code that understands session_id only after this
--        migration has completed successfully.

BEGIN;

ALTER TABLE public.refresh_tokens
  ADD COLUMN IF NOT EXISTS session_id UUID;

-- Existing superadmin tokens are each treated as an independent session. New
-- tokens inherit a session_id during rotation; non-superadmin rows remain NULL
-- because their existing account-wide revoke behavior is intentionally kept.
UPDATE public.refresh_tokens AS refresh_token
SET session_id = refresh_token.id
FROM public.users AS user_account
WHERE refresh_token.user_id = user_account.id
  AND user_account.role = 'superadmin'
  AND refresh_token.session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_superadmin_session_active
  ON public.refresh_tokens (user_id, session_id)
  WHERE session_id IS NOT NULL AND revoked = false;

COMMENT ON COLUMN public.refresh_tokens.session_id IS
  'Refresh-token session family. Populated for superadmin sessions so reuse revocation is device/session scoped.';

COMMIT;

-- Verification queries (run manually after COMMIT):
-- SELECT u.username, rt.session_id, rt.revoked, COUNT(*)
-- FROM public.refresh_tokens rt
-- JOIN public.users u ON u.id = rt.user_id
-- WHERE u.role = 'superadmin'
-- GROUP BY u.username, rt.session_id, rt.revoked
-- ORDER BY u.username, rt.session_id, rt.revoked;
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'refresh_tokens'
--   AND indexname = 'idx_refresh_tokens_superadmin_session_active';
--
-- Rollback (run manually only if the backend code change is also rolled back):
-- DROP INDEX IF EXISTS public.idx_refresh_tokens_superadmin_session_active;
-- ALTER TABLE public.refresh_tokens DROP COLUMN IF EXISTS session_id;
