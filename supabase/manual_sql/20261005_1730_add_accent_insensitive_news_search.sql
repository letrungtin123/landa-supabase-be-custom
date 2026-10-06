-- Title: Add accent-insensitive full-text search for News
-- Purpose: Allow both accented and accent-free Vietnamese queries to find News titles/excerpts.
-- Affected schema: public, extensions
-- Affected tables: public.news_posts
-- Risk level: Medium (rebuilds one generated search column and its GIN index)
-- Execution owner: User/manual only
-- Direct execution by Codex: Forbidden
-- Backup recommendation: Take a schema backup and run during a low-traffic window.
-- Notes: Application code is rollout-compatible: accented search continues to work before this file is applied.

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

DO $migration$
DECLARE
  unaccent_schema TEXT;
BEGIN
  SELECT namespace.nspname
  INTO unaccent_schema
  FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'unaccent';

  IF unaccent_schema IS NULL THEN
    RAISE EXCEPTION 'The unaccent extension is unavailable';
  END IF;

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION public.news_search_normalize(input TEXT)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
    SET search_path = pg_catalog, %1$I
    AS $body$
      SELECT lower(%1$I.unaccent(input))
    $body$
  $function$, unaccent_schema);
END
$migration$;

DROP INDEX IF EXISTS public.idx_news_posts_search;

ALTER TABLE public.news_posts
  DROP COLUMN search_vector;

ALTER TABLE public.news_posts
  ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector(
      'simple'::regconfig,
      public.news_search_normalize(coalesce(title, '') || ' ' || coalesce(excerpt, ''))
    )
  ) STORED;

CREATE INDEX idx_news_posts_search
  ON public.news_posts USING GIN (search_vector);

COMMIT;

-- Verification queries (manual/read-only):
-- SELECT public.news_search_normalize('Đào tạo và THÔNG BÁO');
-- Expected: dao tao va thong bao
--
-- SELECT id, title
-- FROM public.news_posts
-- WHERE search_vector @@ websearch_to_tsquery('simple', 'dao tao')
-- ORDER BY created_at DESC
-- LIMIT 20;
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'news_posts';

-- Rollback SQL (manual only; restores the original accent-sensitive search vector):
-- BEGIN;
-- DROP INDEX IF EXISTS public.idx_news_posts_search;
-- ALTER TABLE public.news_posts DROP COLUMN search_vector;
-- ALTER TABLE public.news_posts
--   ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
--     to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(excerpt, ''))
--   ) STORED;
-- CREATE INDEX idx_news_posts_search ON public.news_posts USING GIN (search_vector);
-- DROP FUNCTION IF EXISTS public.news_search_normalize(TEXT);
-- COMMIT;
