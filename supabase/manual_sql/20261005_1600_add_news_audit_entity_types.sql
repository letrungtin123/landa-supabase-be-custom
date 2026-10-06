-- Title: Add missing News audit entity types
-- Purpose: Repair environments where 20261005_1430_add_tenant_news_module.sql
--          was already executed before the News audit enum values were included.
-- Affected schema: public
-- Affected type: public.audit_entity_type
-- Risk level: Low - append-only, idempotent PostgreSQL enum extension.
-- Execution owner: User/manual only
-- Direct execution by Codex: Forbidden
-- Backup recommendation: Schema backup recommended; existing rows are unchanged.
-- Notes:
--   - PostgreSQL enum values cannot be removed safely by a simple rollback.
--   - Run as the owner of public.audit_entity_type (postgres in the verified local environment).
--   - No application restart is required after this file succeeds.

DO $$
BEGIN
  IF to_regtype('public.audit_entity_type') IS NULL THEN
    RAISE EXCEPTION 'Required type public.audit_entity_type is missing; aborting News audit repair.';
  END IF;
END;
$$;

ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'news_post';
ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'news_asset';

-- Verification query (manual/read-only):
-- SELECT e.enumlabel
-- FROM pg_type t
-- JOIN pg_enum e ON e.enumtypid = t.oid
-- WHERE t.typnamespace = 'public'::regnamespace
--   AND t.typname = 'audit_entity_type'
--   AND e.enumlabel IN ('news_post', 'news_asset')
-- ORDER BY e.enumsortorder;

-- Rollback guidance:
-- PostgreSQL does not support DROP VALUE for enums. Leave these inert values in
-- place if the News module is disabled; rebuilding the enum would be higher risk
-- than retaining two unused labels.
