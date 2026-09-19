-- Title: Repair incomplete Realtime feature_flags migration
-- Purpose: Reconcile the partially applied Realtime migration 20260422000000, then allow
--          the Realtime container to start without recreating existing objects.
-- Affected schema: _realtime
-- Affected tables: _realtime.feature_flags, _realtime.tenants, _realtime.schema_migrations
-- Risk level: Medium — adds one metadata-only defaulted JSONB column when absent and records one migration version.
-- Execution owner: User/manual only
-- Direct execution by Codex: Forbidden
-- Backup recommendation: Take a database backup or export the three affected _realtime tables before execution.
-- Notes:
--   - Run this exact replacement file once in the production Supabase SQL Editor.
--   - Do not run an earlier copy that only inserted the migration-history row; that would leave
--     _realtime.tenants.feature_flags missing.
--   - No CREATE INDEX CONCURRENTLY is used, so this script is safe in the SQL Editor transaction context.
--   - The script is idempotent and aborts without recording migration history if the existing table is unexpected.

BEGIN;

-- Fail safely instead of waiting behind production traffic for an unbounded time.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Prevent a racing Realtime boot from writing the same migration history while this short repair runs.
LOCK TABLE _realtime.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  target_version CONSTANT bigint := 20260422000000;
  feature_flags_shape_ok boolean;
  tenants_feature_flags_type text;
  tenants_feature_flags_nullable text;
BEGIN
  IF to_regclass('_realtime.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Expected table _realtime.schema_migrations does not exist; no change was made.';
  END IF;

  IF to_regclass('_realtime.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'Expected table _realtime.feature_flags does not exist; no change was made.';
  END IF;

  IF to_regclass('_realtime.tenants') IS NULL THEN
    RAISE EXCEPTION 'Expected table _realtime.tenants does not exist; no change was made.';
  END IF;

  -- Validate objects already created by the interrupted migration before touching its history.
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
    RAISE EXCEPTION 'Existing _realtime.feature_flags does not match migration %; no change was made.', target_version;
  END IF;

  SELECT data_type, is_nullable
    INTO tenants_feature_flags_type, tenants_feature_flags_nullable
    FROM information_schema.columns
   WHERE table_schema = '_realtime'
     AND table_name = 'tenants'
     AND column_name = 'feature_flags';

  IF NOT FOUND THEN
    -- Matches the missing ALTER TABLE portion of Realtime migration 20260422000000.
    ALTER TABLE _realtime.tenants
      ADD COLUMN feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb;
  ELSIF tenants_feature_flags_type <> 'jsonb' OR tenants_feature_flags_nullable <> 'NO' THEN
    RAISE EXCEPTION
      'Existing _realtime.tenants.feature_flags has incompatible shape (type %, nullable %); no change was made.',
      tenants_feature_flags_type,
      tenants_feature_flags_nullable;
  ELSE
    -- Repair a previously created compatible column that lacks the migration default for future tenants.
    ALTER TABLE _realtime.tenants
      ALTER COLUMN feature_flags SET DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = '_realtime'
       AND table_name = 'tenants'
       AND column_name = 'feature_flags'
       AND data_type = 'jsonb'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Expected _realtime.tenants.feature_flags was not created with the required shape; no migration history was written.';
  END IF;

  INSERT INTO _realtime.schema_migrations (version, inserted_at)
  SELECT target_version, CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
  WHERE NOT EXISTS (
    SELECT 1 FROM _realtime.schema_migrations WHERE version = target_version
  );

  RAISE NOTICE 'Realtime migration % is reconciled.', target_version;
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
-- WHERE table_schema = '_realtime'
--   AND table_name = 'tenants'
--   AND column_name = 'feature_flags';
--
-- Rollback:
-- The transaction rolls back automatically on any error before COMMIT. After a successful COMMIT,
-- do not delete migration history or drop the column manually; restore from the verified backup if a DBA determines rollback is required.
