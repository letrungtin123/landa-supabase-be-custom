-- ═══════════════════════════════════════════════════════════════
-- LANDA Backend — Migration v2: Tất cả modules
-- Chạy trong Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ═══ Library: Document Categories ═══
CREATE TABLE IF NOT EXISTS document_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_cat_tenant ON document_categories(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_cat_unique ON document_categories(tenant_id, slug);

-- ═══ Library: Documents ═══
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  file_url TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  extension VARCHAR(20) DEFAULT '',
  category_id UUID REFERENCES document_categories(id) ON DELETE SET NULL,
  is_visible BOOLEAN DEFAULT true,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_tenant ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_doc_cat ON documents(category_id);
CREATE INDEX IF NOT EXISTS idx_doc_search ON documents USING gin(to_tsvector('simple', title));

-- ═══ Courses (metadata cache — content stays in edX) ═══
CREATE TABLE IF NOT EXISTS courses (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name VARCHAR(500) NOT NULL,
  org VARCHAR(100) DEFAULT '',
  visible_to_staff_only BOOLEAN DEFAULT false,
  image_url TEXT DEFAULT '',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_course_tenant ON courses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_course_search ON courses USING gin(to_tsvector('simple', display_name));

-- ═══ Course Categories ═══
CREATE TABLE IF NOT EXISTS course_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cc_tenant ON course_categories(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unique ON course_categories(tenant_id, slug);

-- ═══ Course ↔ Category mapping ═══
CREATE TABLE IF NOT EXISTS course_category_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES course_categories(id) ON DELETE CASCADE,
  course_id VARCHAR(255) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(category_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_ccc_course ON course_category_courses(course_id);

-- ═══ Course Modal Config (per-course popups) ═══
CREATE TABLE IF NOT EXISTS course_modal_configs (
  course_id VARCHAR(255) PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  welcome_enabled BOOLEAN DEFAULT false,
  welcome_title VARCHAR(500) DEFAULT '',
  welcome_description TEXT DEFAULT '',
  confirm_enabled BOOLEAN DEFAULT false,
  confirm_title VARCHAR(500) DEFAULT '',
  confirm_description TEXT DEFAULT '',
  confirm_checkbox_text VARCHAR(500) DEFAULT '',
  completion_enabled BOOLEAN DEFAULT false,
  completion_title VARCHAR(500) DEFAULT '',
  completion_description TEXT DEFAULT '',
  completion_social_type VARCHAR(50) DEFAULT '',
  completion_social_link TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Section Modal Config (per-section encouragement popups) ═══
CREATE TABLE IF NOT EXISTS section_modal_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id VARCHAR(255) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  section_id VARCHAR(255) NOT NULL,
  enabled BOOLEAN DEFAULT false,
  title VARCHAR(500) DEFAULT '',
  description TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(course_id, section_id)
);

-- ═══ Groups: Org Groups (level 1) ═══
CREATE TABLE IF NOT EXISTS org_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_tenant ON org_groups(tenant_id);

-- ═══ Groups: Sub Groups (level 2) ═══
CREATE TABLE IF NOT EXISTS sub_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_group_id UUID NOT NULL REFERENCES org_groups(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sg_org ON sub_groups(org_group_id);

-- ═══ Groups: Teams (level 3) ═══
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_group_id UUID NOT NULL REFERENCES sub_groups(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_sg ON teams(sub_group_id);

-- ═══ Team ↔ Members (users) ═══
CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tm_user ON team_members(user_id);

-- ═══ Team ↔ Courses ═══
CREATE TABLE IF NOT EXISTS team_courses (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  course_id VARCHAR(255) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, course_id)
);

-- ═══ Team ↔ Document Categories ═══
CREATE TABLE IF NOT EXISTS team_doc_categories (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES document_categories(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, category_id)
);

-- ═══ Team ↔ Course Categories ═══
CREATE TABLE IF NOT EXISTS team_course_categories (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES course_categories(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, category_id)
);

-- ═══ Help Docs: Folders ═══
CREATE TABLE IF NOT EXISTS help_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL,
  icon VARCHAR(100) DEFAULT 'BookOpen',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hf_tenant ON help_folders(tenant_id);

-- ═══ Help Docs: Pages ═══
CREATE TABLE IF NOT EXISTS help_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES help_folders(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) NOT NULL,
  content TEXT DEFAULT '',
  is_published BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hp_folder ON help_pages(folder_id);
