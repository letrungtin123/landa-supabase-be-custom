-- Lesson author selected KB source files for proposal audit/debug.
-- Run manually before deploying code that writes lesson_author_jobs.source_documents.

ALTER TABLE lesson_author_jobs
ADD COLUMN IF NOT EXISTS source_documents jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lesson_author_jobs_source_documents_array'
  ) THEN
    ALTER TABLE lesson_author_jobs
    ADD CONSTRAINT lesson_author_jobs_source_documents_array
    CHECK (jsonb_typeof(source_documents) = 'array');
  END IF;
END $$;
