-- ═══════════════════════════════════════════════════════════════
-- Migration V3: Complete OpenEdX Removal
-- New tables: enrollments, progress, badges, study_sessions, 
--             course_blocks, course_assets, notifications
-- Materialized view: mv_report_summary
-- ═══════════════════════════════════════════════════════════════

-- ── Module codes for RBAC ──
INSERT INTO modules (code, name, description) VALUES
  ('enrollments', 'Enrollments', 'Quản lý đăng ký khóa học'),
  ('course_authoring', 'Course Authoring', 'Soạn nội dung khóa học')
ON CONFLICT (code) DO NOTHING;

-- ── Profile columns on users table ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(10) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS level_of_education VARCHAR(20) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS year_of_birth INT;

-- ═══════════════════════════════════════════════════════════════
-- ENROLLMENTS & PROGRESS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS enrollments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id VARCHAR(255) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, course_id)
);

-- Indexes optimized for multi-tenant queries at scale
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_course ON enrollments(tenant_id, course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_user ON enrollments(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_enrolled_at ON enrollments(tenant_id, enrolled_at DESC);

CREATE TABLE IF NOT EXISTS course_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  progress NUMERIC(5,2) DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  is_completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(enrollment_id)
);

-- Fast lookup for incomplete learners (report queries)
CREATE INDEX IF NOT EXISTS idx_progress_incomplete ON course_progress(is_completed, last_activity_at DESC) WHERE is_completed = false;
CREATE INDEX IF NOT EXISTS idx_progress_enrollment ON course_progress(enrollment_id);

-- ═══════════════════════════════════════════════════════════════
-- BADGES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS badge_definitions (
  id VARCHAR(50) PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  image_key VARCHAR(100) DEFAULT '',
  criteria JSONB DEFAULT '{}',
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed 12 default badges
INSERT INTO badge_definitions (id, name, image_key, sort_order) VALUES
  ('perfect_profile',     'Mảnh Ghép Hoàn Hảo',         'ManhGhepHoanHao',      1),
  ('onboarding_warrior',  'Chiến Binh Onboarding',       'ChienBinhOnboarding',   2),
  ('value_holder',        'Người Nắm Giữ Giá Trị',      'NguoiNamGiuGiaTri',     3),
  ('la_ambassador',       'Đại Sứ L&A',                  'DaiSuLA',               4),
  ('la_breakthrough',     'Người Bức Phá L&A',           'NguoiButPhaLA',         5),
  ('la_expert',           'Chuyên Gia L&A',              'ChuyenGiaLA',           6),
  ('recruitment_master',  'Bậc Thầy Tuyển Dụng',         'BacThayTuyenDung',      7),
  ('otif_expert',         'Chuyên Gia OTIF',             'BacThayTuyenDung2',     8),
  ('trusted_ambassador',  'Đại Sứ Tin Cậy',              'DaiSuTinCay',           9),
  ('omnipotent_master',   'Bậc Thầy Toàn Năng',          'BacThayToanNang',      10),
  ('speed_scholar',       'Học Giả Tốc Độ',              'HocGiaTocDo',          11),
  ('system_explorer',     'Nhà Thám Hiểm Hệ Thống',     'NhaThamHiemHeThong',   12)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_badges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id VARCHAR(50) NOT NULL REFERENCES badge_definitions(id) ON DELETE CASCADE,
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- ═══════════════════════════════════════════════════════════════
-- STUDY TIME TRACKING
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS study_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id VARCHAR(255) REFERENCES courses(id) ON DELETE SET NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_minutes INT GENERATED ALWAYS AS (
    CASE 
      WHEN ended_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::INT / 60)
      ELSE 0
    END
  ) STORED
);

-- Fast query: user study time for last 7 days
CREATE INDEX IF NOT EXISTS idx_study_user_date ON study_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_tenant_date ON study_sessions(tenant_id, started_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- COURSE CONTENT TREE (replaces XBlocks)
-- Structure: course → chapter → sequential → vertical → components
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS course_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id VARCHAR(255) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES course_blocks(id) ON DELETE CASCADE,
  block_type VARCHAR(50) NOT NULL CHECK (block_type IN (
    'course', 'chapter', 'sequential', 'vertical',
    'video', 'html', 'problem',
    'la_crossword', 'la_sortable', 'la_diagram', 'la_faq', 'la_pdf'
  )),
  display_name VARCHAR(500) DEFAULT '',
  data JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  sort_order INT DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  has_draft_changes BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tree traversal indexes
CREATE INDEX IF NOT EXISTS idx_blocks_course ON course_blocks(course_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent ON course_blocks(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_course_parent_sort ON course_blocks(course_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_blocks_type ON course_blocks(block_type);

-- GIN index for JSONB data search
CREATE INDEX IF NOT EXISTS idx_blocks_data_gin ON course_blocks USING GIN (data);

-- ═══════════════════════════════════════════════════════════════
-- COURSE ASSETS (files/images per course)
-- Storage path: tenants/{tenant_id}/courses/{course_id}/assets/{filename}
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS course_assets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id VARCHAR(255) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name VARCHAR(500) NOT NULL,
  content_type VARCHAR(200) DEFAULT 'application/octet-stream',
  file_size BIGINT DEFAULT 0,
  storage_path TEXT NOT NULL,
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  is_locked BOOLEAN DEFAULT false,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assets_course ON course_assets(course_id);
CREATE INDEX IF NOT EXISTS idx_assets_tenant ON course_assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_assets_name ON course_assets(display_name);

-- ═══════════════════════════════════════════════════════════════
-- NOTIFICATIONS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  course_id VARCHAR(255) REFERENCES courses(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  message TEXT DEFAULT '',
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- MATERIALIZED VIEW: Report Summary (pre-aggregated)
-- Refresh periodically (e.g. every 15 min via cron)
-- ═══════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_report_summary AS
SELECT
  e.tenant_id,
  DATE_TRUNC('month', e.enrolled_at)::DATE AS month,
  COUNT(DISTINCT e.user_id) AS total_learners,
  COUNT(DISTINCT e.id) AS total_enrollments,
  COUNT(DISTINCT e.course_id) AS total_courses,
  COUNT(DISTINCT CASE WHEN cp.is_completed THEN e.user_id END) AS completed_learners,
  COUNT(DISTINCT CASE WHEN cp.last_activity_at >= (DATE_TRUNC('month', e.enrolled_at) - INTERVAL '30 days') THEN e.user_id END) AS active_learners,
  ROUND(
    CASE WHEN COUNT(e.id) > 0
    THEN COUNT(CASE WHEN cp.is_completed THEN 1 END) * 100.0 / COUNT(e.id)
    ELSE 0 END, 1
  ) AS completion_rate
FROM enrollments e
LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
WHERE e.is_active = true
GROUP BY e.tenant_id, DATE_TRUNC('month', e.enrolled_at)::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_report_tenant_month ON mv_report_summary(tenant_id, month);

-- ═══════════════════════════════════════════════════════════════
-- HELPER: Function to refresh materialized view
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refresh_report_summary()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_report_summary;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- HELPER: Auto-update updated_at timestamp
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_course_blocks_updated
  BEFORE UPDATE ON course_blocks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_course_progress_updated
  BEFORE UPDATE ON course_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
