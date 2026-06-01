-- ═══════════════════════════════════════════════════════════════
-- LANDA Backend — Supabase Migration
-- Multi-Tenant Auth + RBAC Permission System
-- 
-- Chạy file này trong Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 0. Extension cần thiết
-- ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────
-- 1. TENANTS — Quản lý tổ chức/đơn vị
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  settings    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenants IS 'Tổ chức/đơn vị trong hệ thống multi-tenant';
COMMENT ON COLUMN public.tenants.slug IS 'Identifier duy nhất (dùng cho subdomain hoặc routing)';
COMMENT ON COLUMN public.tenants.settings IS 'Config riêng mỗi tenant (JSON)';

-- ─────────────────────────────────────────────────────────────
-- 2. USERS — Tài khoản người dùng
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  username        VARCHAR(150) NOT NULL UNIQUE,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       VARCHAR(255) DEFAULT '',
  phone           VARCHAR(20) DEFAULT '',
  avatar_url      TEXT,
  role            VARCHAR(20) NOT NULL DEFAULT 'learner'
                  CHECK (role IN ('learner', 'staff', 'superuser', 'superadmin')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.users IS 'Tài khoản người dùng — mỗi user thuộc 1 tenant (trừ superadmin)';
COMMENT ON COLUMN public.users.role IS 'learner: học viên | staff: nhân viên | superuser: admin tenant | superadmin: admin toàn hệ thống';
COMMENT ON COLUMN public.users.tenant_id IS 'NULL cho superadmin (cross-tenant access)';

-- ─────────────────────────────────────────────────────────────
-- 3. REFRESH_TOKENS — Theo dõi JWT refresh token
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.refresh_tokens IS 'Lưu hash của refresh token — hỗ trợ token rotation + revoke';

-- ─────────────────────────────────────────────────────────────
-- 4. MODULES — Các tính năng/module trong hệ thống
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(50) NOT NULL UNIQUE,
  name        VARCHAR(100) NOT NULL,
  description TEXT DEFAULT '',
  icon        VARCHAR(50) DEFAULT '',
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.modules IS 'Danh sách modules/tính năng — dùng cho phân quyền';
COMMENT ON COLUMN public.modules.code IS 'Mã duy nhất: library, courses, account, groups, ...';
COMMENT ON COLUMN public.modules.icon IS 'Lucide icon name cho sidebar';

-- ─────────────────────────────────────────────────────────────
-- 5. TENANT_MODULES — Module nào bật cho tenant nào
-- (superadmin quản lý — dạng ma trận tick)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  module_id   UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, module_id)
);

COMMENT ON TABLE public.tenant_modules IS 'Ma trận bật/tắt module per tenant — superadmin quản lý';

-- ─────────────────────────────────────────────────────────────
-- 6. PERMISSION_GROUPS — Nhóm quyền (per tenant)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.permission_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, name)
);

COMMENT ON TABLE public.permission_groups IS 'Nhóm quyền trong tenant — CRUD bởi staff/superuser';

-- ─────────────────────────────────────────────────────────────
-- 7. PERMISSION_GROUP_MODULES — Ma trận tick quyền
-- group × module × (can_view, can_add, can_edit, can_delete)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.permission_group_modules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_group_id   UUID NOT NULL REFERENCES public.permission_groups(id) ON DELETE CASCADE,
  module_id             UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  can_view              BOOLEAN NOT NULL DEFAULT false,
  can_add               BOOLEAN NOT NULL DEFAULT false,
  can_edit              BOOLEAN NOT NULL DEFAULT false,
  can_delete            BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(permission_group_id, module_id)
);

COMMENT ON TABLE public.permission_group_modules IS 'Ma trận phân quyền: mỗi row = 1 group × 1 module × 4 actions';

-- ─────────────────────────────────────────────────────────────
-- 8. USER_PERMISSION_GROUPS — User thuộc nhóm quyền nào
-- (1 user có thể thuộc nhiều groups, quyền = UNION tất cả)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_permission_groups (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  permission_group_id   UUID NOT NULL REFERENCES public.permission_groups(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, permission_group_id)
);

COMMENT ON TABLE public.user_permission_groups IS 'Gán user vào permission group — 1 user có thể thuộc nhiều groups';

-- ─────────────────────────────────────────────────────────────
-- 9. AUDIT_LOGS — Ghi log hành động
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  actor_id        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_username  VARCHAR(150),
  action          VARCHAR(20) NOT NULL
                  CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT')),
  entity_type     VARCHAR(50) NOT NULL,
  entity_id       VARCHAR(255),
  entity_name     VARCHAR(255),
  details         TEXT DEFAULT '',
  ip_address      VARCHAR(45),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_logs IS 'Audit trail — log mọi hành động quan trọng';


-- ═══════════════════════════════════════════════════════════════
-- INDEXES — Tối ưu query performance
-- ═══════════════════════════════════════════════════════════════

-- Users
CREATE INDEX IF NOT EXISTS idx_users_tenant       ON public.users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_role          ON public.users(role);
CREATE INDEX IF NOT EXISTS idx_users_email         ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_active        ON public.users(is_active);

-- Refresh tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON public.refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON public.refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_exp  ON public.refresh_tokens(expires_at);

-- Tenant modules
CREATE INDEX IF NOT EXISTS idx_tenant_modules_tenant ON public.tenant_modules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_modules_module ON public.tenant_modules(module_id);

-- Permission groups
CREATE INDEX IF NOT EXISTS idx_perm_groups_tenant   ON public.permission_groups(tenant_id);

-- Permission group modules
CREATE INDEX IF NOT EXISTS idx_pgm_group           ON public.permission_group_modules(permission_group_id);
CREATE INDEX IF NOT EXISTS idx_pgm_module          ON public.permission_group_modules(module_id);

-- User permission groups
CREATE INDEX IF NOT EXISTS idx_upg_user            ON public.user_permission_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_upg_group           ON public.user_permission_groups(permission_group_id);

-- Audit logs
CREATE INDEX IF NOT EXISTS idx_audit_tenant        ON public.audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor         ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_created       ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity_type   ON public.audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_action        ON public.audit_logs(action);


-- ═══════════════════════════════════════════════════════════════
-- TRIGGERS — Auto-update updated_at
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tenants
DROP TRIGGER IF EXISTS trigger_tenants_updated_at ON public.tenants;
CREATE TRIGGER trigger_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Users
DROP TRIGGER IF EXISTS trigger_users_updated_at ON public.users;
CREATE TRIGGER trigger_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Permission groups
DROP TRIGGER IF EXISTS trigger_perm_groups_updated_at ON public.permission_groups;
CREATE TRIGGER trigger_perm_groups_updated_at
  BEFORE UPDATE ON public.permission_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════
-- SEED DATA — Dữ liệu mặc định
-- ═══════════════════════════════════════════════════════════════

-- ── Default Modules (dựa trên sidebar landa-dashboard) ──
INSERT INTO public.modules (code, name, icon, sort_order) VALUES
  ('library',           'Library',            'Library',        1),
  ('courses',           'Courses',            'GraduationCap',  2),
  ('course_categories', 'Course Categories',  'FolderKanban',   3),
  ('account',           'Users',              'Users',          4),
  ('groups',            'Groups',             'FolderTree',     5),
  ('permission_groups', 'Permission Groups',  'ShieldCheck',    6),
  ('audit_log',         'Audit Logs',         'ScrollText',     7),
  ('report_summary',    'Report Summary',     'BarChart3',      8),
  ('help_docs',         'Help Docs',          'BookOpen',       9),
  ('tenant_management', 'Tenant Management',  'Building2',      10)
ON CONFLICT (code) DO NOTHING;

-- ── Default Superadmin User ──
-- Password: Admin@123
-- QUAN TRỌNG: Đổi mật khẩu sau khi deploy!
INSERT INTO public.users (username, email, password_hash, full_name, role, tenant_id)
VALUES (
  'superadmin',
  'admin@landa.vn',
  crypt('Admin@123', gen_salt('bf', 12)),
  'Super Admin',
  'superadmin',
  NULL
)
ON CONFLICT (username) DO NOTHING;

-- ── Default Tenant (demo) ──
INSERT INTO public.tenants (name, slug) VALUES
  ('LANDA Demo', 'landa-demo')
ON CONFLICT (slug) DO NOTHING;

-- ── Enable all modules cho demo tenant ──
INSERT INTO public.tenant_modules (tenant_id, module_id, is_enabled)
SELECT t.id, m.id, true
FROM public.tenants t
CROSS JOIN public.modules m
WHERE t.slug = 'landa-demo'
  AND m.code NOT IN ('tenant_management')  -- tenant_management chỉ cho superadmin
ON CONFLICT (tenant_id, module_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════
-- RLS (Row Level Security) — Tùy chọn, có thể bật sau
-- Hiện tại auth được xử lý hoàn toàn ở application layer (Express)
-- ═══════════════════════════════════════════════════════════════

-- Nếu muốn bật RLS cho thêm lớp bảo vệ:
-- ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
-- ... (define policies per table)


-- ═══════════════════════════════════════════════════════════════
-- DONE! Kiểm tra bằng:
--   SELECT table_name FROM information_schema.tables 
--   WHERE table_schema = 'public' ORDER BY table_name;
-- ═══════════════════════════════════════════════════════════════
