-- Title: Reconcile Realtime feature_flags migration history
-- Purpose: Record an already-present Realtime migration so the Realtime service can start.
-- Affected schema: _realtime
-- Affected tables: _realtime.schema_migrations, _realtime.feature_flags (read-only validation)
-- Risk level: Medium — writes one migration-history row only after strict schema guards pass.
-- Execution owner: User/manual only
-- Direct execution by Codex: Forbidden
-- Backup recommendation: Take a database backup or at minimum export _realtime.schema_migrations before execution.
-- Notes:
--   - This does NOT create, alter, drop, or delete the feature_flags table.
--   - It is idempotent: a matching existing history row is left untouched.
--   - It aborts if feature_flags does not exactly match the expected migration shape.

BEGIN;

DO $$
DECLARE
  target_version CONSTANT bigint := 20260422000000;
  feature_flags_shape_ok boolean;
BEGIN
  IF to_regclass('_realtime.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Expected table _realtime.schema_migrations does not exist; no change was made.';
  END IF;

  IF to_regclass('_realtime.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'Expected table _realtime.feature_flags does not exist; no change was made.';
  END IF;

  SELECT
    (SELECT count(*) = 5
       FROM information_schema.columns
      WHERE table_schema = '_realtime'
        AND table_name = 'feature_flags')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '_realtime' AND table_name = 'feature_flags'
        AND column_name = 'id' AND data_type = 'uuid' AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '_realtime' AND table_name = 'feature_flags'
        AND column_name = 'name' AND data_type = 'character varying' AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '_realtime' AND table_name = 'feature_flags'
        AND column_name = 'enabled' AND data_type = 'boolean'
        AND is_nullable = 'NO' AND column_default = 'false'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '_realtime' AND table_name = 'feature_flags'
        AND column_name = 'inserted_at' AND data_type = 'timestamp without time zone'
        AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '_realtime' AND table_name = 'feature_flags'
        AND column_name = 'updated_at' AND data_type = 'timestamp without time zone'
        AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = '_realtime' AND tablename = 'feature_flags'
        AND indexname = 'feature_flags_pkey'
    )
    AND EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = '_realtime' AND tablename = 'feature_flags'
        AND indexname = 'feature_flags_name_index'
    )
  INTO feature_flags_shape_ok;

  IF NOT feature_flags_shape_ok THEN
    RAISE EXCEPTION 'The existing _realtime.feature_flags table does not match migration %; no change was made.', target_version;
  END IF;

  IF EXISTS (
    SELECT 1 FROM _realtime.schema_migrations WHERE version = target_version
  ) THEN
    RAISE NOTICE 'Realtime migration % is already recorded; no change was made.', target_version;
    RETURN;
  END IF;

  INSERT INTO _realtime.schema_migrations (version)
  VALUES (target_version);

  RAISE NOTICE 'Recorded Realtime migration % after feature_flags validation.', target_version;
END
$$;

COMMIT;

-- Verification (run manually after COMMIT):
-- SELECT version, inserted_at
-- FROM _realtime.schema_migrations
-- WHERE version = 20260422000000;
--
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = '_realtime' AND table_name = 'feature_flags'
-- ORDER BY ordinal_position;
--
-- Rollback (only if Realtime has not been restarted and after confirming with a DBA):
-- DELETE FROM _realtime.schema_migrations WHERE version = 20260422000000;
