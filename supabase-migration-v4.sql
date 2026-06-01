-- ═══════════════════════════════════════════════════════════════
-- Migration V4: Profile columns + Materialized View
-- Chạy file này trên Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Profile columns trên users table ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(10) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS level_of_education VARCHAR(20) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS year_of_birth INT;

-- ── 2. Materialized View: Report Summary (pre-aggregated) ──
-- Drop nếu tồn tại để tạo lại cho chuẩn
DROP MATERIALIZED VIEW IF EXISTS mv_report_summary;

CREATE MATERIALIZED VIEW mv_report_summary AS
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

-- ── 3. Helper function: refresh materialized view ──
CREATE OR REPLACE FUNCTION refresh_report_summary()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_report_summary;
END;
$$;

-- ── 4. Auto-update triggers ──
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Trigger cho course_blocks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_course_blocks_updated') THEN
    CREATE TRIGGER trg_course_blocks_updated
      BEFORE UPDATE ON course_blocks
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- Trigger cho course_progress
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_course_progress_updated') THEN
    CREATE TRIGGER trg_course_progress_updated
      BEFORE UPDATE ON course_progress
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── 5. Missing indexes (nếu chưa có) ──
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_course ON enrollments(tenant_id, course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_user ON enrollments(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_enrolled_at ON enrollments(tenant_id, enrolled_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_incomplete ON course_progress(is_completed, last_activity_at DESC) WHERE is_completed = false;
CREATE INDEX IF NOT EXISTS idx_progress_enrollment ON course_progress(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_study_user_date ON study_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_tenant_date ON study_sessions(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_blocks_course ON course_blocks(course_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent ON course_blocks(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_course_parent_sort ON course_blocks(course_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_blocks_type ON course_blocks(block_type);
CREATE INDEX IF NOT EXISTS idx_blocks_data_gin ON course_blocks USING GIN (data);
CREATE INDEX IF NOT EXISTS idx_assets_course ON course_assets(course_id);
CREATE INDEX IF NOT EXISTS idx_assets_tenant ON course_assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_assets_name ON course_assets(display_name);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id, created_at DESC);
