-- Title: Tenant News module with durable image ownership
-- Purpose: Add tenant-scoped News posts, soft archive, scalable feed indexes, and tracked image assets.
-- Affected schema: public
-- Affected tables: public.modules, public.tenant_modules, public.news_posts, public.news_post_assets,
--                  tenant quota registry/manifest tables when the quota framework is installed.
-- Affected types: public.audit_entity_type (adds news_post and news_asset enum values).
-- Risk level: High - creates tenant-owned tables and registers them with quota enforcement.
-- Execution owner: User/manual only
-- Direct execution by Codex: Forbidden
-- Backup recommendation: Back up public.modules, public.tenant_modules and tenant quota registry/manifest tables.
-- Notes:
--   - Idempotent for schema/module creation.
--   - The News module is disabled for every existing tenant and remains opt-in for new tenants.
--   - Run as the owner-capable database role. If SQL Editor reports "must be owner", use the reviewed
--     supabase_admin/owner execution path instead of weakening ownership or grants.
--   - Quota triggers are installed only on the two News tables. This migration deliberately does not call
--     tenant_data_quota_install_direct_triggers(), which rewrites triggers on every registered relation.
--   - This file does not create, publish, archive, or delete any News post.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.modules') IS NULL
     OR to_regclass('public.tenant_modules') IS NULL
     OR to_regclass('public.tenants') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regtype('public.audit_entity_type') IS NULL THEN
    RAISE EXCEPTION 'Required Landa tenant/module tables or audit_entity_type are missing; aborting News migration.';
  END IF;
END;
$$;

-- Audit rows are written in the same transaction as each News mutation. Keep
-- these domain types explicit so audit filtering remains semantically correct.
ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'news_post';
ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'news_asset';

INSERT INTO public.modules (code, name, description, icon, sort_order, is_active)
VALUES (
  'news',
  'Bảng tin',
  'Quản lý và hiển thị bài viết nội bộ theo doanh nghiệp',
  'Newspaper',
  12,
  true
)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  is_active = true;

-- Existing tenants must be explicitly granted News by superadmin.
INSERT INTO public.tenant_modules (tenant_id, module_id, is_enabled)
SELECT tenant.id, module.id, false
FROM public.tenants tenant
CROSS JOIN public.modules module
WHERE module.code = 'news'
ON CONFLICT (tenant_id, module_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.news_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title VARCHAR(240) NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  excerpt VARCHAR(320) NOT NULL DEFAULT '',
  preview_image_path VARCHAR(1200),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  archived_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(excerpt, ''))
  ) STORED,
  CONSTRAINT news_posts_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT news_posts_preview_path_tenant_prefix CHECK (
    preview_image_path IS NULL OR preview_image_path LIKE tenant_id::text || '/news/%'
  ),
  CONSTRAINT news_posts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS public.news_post_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  post_id UUID,
  upload_session_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('preview', 'inline')),
  status VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'delete_pending')),
  storage_path VARCHAR(1200) NOT NULL UNIQUE,
  original_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '24 hours'),
  cleanup_lease_until TIMESTAMPTZ,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  CONSTRAINT news_post_assets_tenant_post_fk
    FOREIGN KEY (tenant_id, post_id)
    REFERENCES public.news_posts(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT news_post_assets_storage_path_tenant_prefix CHECK (
    storage_path LIKE tenant_id::text || '/news/%'
  ),
  CONSTRAINT news_post_assets_state_consistency CHECK (
    (status = 'pending' AND post_id IS NULL AND expires_at IS NOT NULL)
    OR (status = 'attached' AND post_id IS NOT NULL AND expires_at IS NULL)
    OR status = 'delete_pending'
  )
);

CREATE INDEX IF NOT EXISTS idx_news_posts_active_feed
  ON public.news_posts (tenant_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_news_posts_archived_feed
  ON public.news_posts (tenant_id, archived_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_posts_search
  ON public.news_posts USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_news_post_assets_post
  ON public.news_post_assets (tenant_id, post_id, status)
  WHERE post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_post_assets_cleanup
  ON public.news_post_assets (expires_at ASC, created_at ASC, id ASC)
  WHERE status IN ('pending', 'delete_pending');

CREATE INDEX IF NOT EXISTS idx_news_post_assets_session
  ON public.news_post_assets (tenant_id, upload_session_id, status);

COMMENT ON TABLE public.news_posts IS
  'Tenant-scoped internal News posts. archived_at is the soft-delete boundary for learner visibility.';
COMMENT ON TABLE public.news_post_assets IS
  'Durable ownership ledger for pending and attached News images; cleanup retries delete_pending rows.';

-- Backend-only tables. The application accesses them through its owner-capable PostgreSQL role.
ALTER TABLE public.news_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_post_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.news_posts FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.news_post_assets FROM PUBLIC, anon, authenticated;

-- Register and protect only the two new News relations when the production quota
-- framework exists. Never invoke the global installer here: production relations
-- may have different owners, and rewriting their triggers is outside this migration.
DO $$
BEGIN
  IF to_regclass('public.tenant_data_quota_table_registry') IS NOT NULL
     AND to_regclass('public.tenant_data_quota_ownership_manifest') IS NOT NULL
     AND to_regprocedure('public.tenant_data_quota_apply_direct_delta()') IS NOT NULL
     AND to_regprocedure('public.tenant_data_quota_assert_coverage()') IS NOT NULL THEN
    INSERT INTO public.tenant_data_quota_table_registry (relation_name, tenant_column, is_active)
    VALUES
      ('public.news_posts'::regclass, 'tenant_id'::name, true),
      ('public.news_post_assets'::regclass, 'tenant_id'::name, true)
    ON CONFLICT (relation_name) DO UPDATE
      SET tenant_column = EXCLUDED.tenant_column,
          is_active = true,
          updated_at = now();

    INSERT INTO public.tenant_data_quota_ownership_manifest (relation_name, classification, note)
    VALUES
      (
        'public.news_posts'::regclass,
        'direct',
        'Direct UUID tenant_id relation; trigger-managed tenant News posts.'
      ),
      (
        'public.news_post_assets'::regclass,
        'direct',
        'Direct UUID tenant_id relation; trigger-managed durable News image ledger.'
      )
    ON CONFLICT (relation_name) DO UPDATE
      SET classification = EXCLUDED.classification,
          note = EXCLUDED.note,
          updated_at = now();

    DROP TRIGGER IF EXISTS tenant_data_quota_direct_insert ON public.news_posts;
    CREATE TRIGGER tenant_data_quota_direct_insert
      AFTER INSERT ON public.news_posts
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_data_quota_apply_direct_delta();

    DROP TRIGGER IF EXISTS tenant_data_quota_direct_update ON public.news_posts;
    CREATE TRIGGER tenant_data_quota_direct_update
      AFTER UPDATE ON public.news_posts
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_data_quota_apply_direct_delta();

    DROP TRIGGER IF EXISTS tenant_data_quota_direct_delete ON public.news_posts;
    CREATE TRIGGER tenant_data_quota_direct_delete
      AFTER DELETE ON public.news_posts
      REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_data_quota_apply_direct_delta();

    DROP TRIGGER IF EXISTS tenant_data_quota_direct_insert ON public.news_post_assets;
    CREATE TRIGGER tenant_data_quota_direct_insert
      AFTER INSERT ON public.news_post_assets
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_data_quota_apply_direct_delta();

    DROP TRIGGER IF EXISTS tenant_data_quota_direct_update ON public.news_post_assets;
    CREATE TRIGGER tenant_data_quota_direct_update
      AFTER UPDATE ON public.news_post_assets
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_data_quota_apply_direct_delta();

    DROP TRIGGER IF EXISTS tenant_data_quota_direct_delete ON public.news_post_assets;
    CREATE TRIGGER tenant_data_quota_direct_delete
      AFTER DELETE ON public.news_post_assets
      REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_data_quota_apply_direct_delta();

    PERFORM public.tenant_data_quota_assert_coverage();
  END IF;
END;
$$;

COMMIT;

-- Verification queries (manual/read-only):
-- SELECT code, name, icon, sort_order, is_active FROM public.modules WHERE code = 'news';
-- SELECT COUNT(*) AS tenant_rows,
--        COUNT(*) FILTER (WHERE tm.is_enabled) AS enabled_tenants
-- FROM public.tenant_modules tm
-- JOIN public.modules m ON m.id = tm.module_id
-- WHERE m.code = 'news';
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename IN ('news_posts', 'news_post_assets')
-- ORDER BY tablename, indexname;
-- SELECT relation_name::text, tenant_column, is_active
-- FROM public.tenant_data_quota_table_registry
-- WHERE relation_name IN ('public.news_posts'::regclass, 'public.news_post_assets'::regclass)
-- ORDER BY relation_name::text;
-- SELECT table_name, tableowner FROM pg_tables
-- WHERE schemaname = 'public' AND table_name IN ('news_posts', 'news_post_assets');
-- SELECT event_object_table, trigger_name
-- FROM information_schema.triggers
-- WHERE trigger_schema = 'public'
--   AND event_object_table IN ('news_posts', 'news_post_assets')
--   AND trigger_name LIKE 'tenant_data_quota_direct_%'
-- ORDER BY event_object_table, trigger_name;

-- Rollback SQL (manual review and Storage reconciliation required; never run blindly):
-- BEGIN;
-- UPDATE public.tenant_modules tm SET is_enabled = false
-- FROM public.modules m WHERE tm.module_id = m.id AND m.code = 'news';
-- -- Export news_posts/news_post_assets and remove corresponding Storage objects before dropping data.
-- DROP TABLE IF EXISTS public.news_post_assets;
-- DROP TABLE IF EXISTS public.news_posts;
-- DELETE FROM public.modules WHERE code = 'news';
-- -- If quota is installed, remove the two News registry/manifest rows only after both tables are dropped,
-- -- then run public.tenant_data_quota_assert_coverage(). Do not run the global trigger installer.
-- COMMIT;
