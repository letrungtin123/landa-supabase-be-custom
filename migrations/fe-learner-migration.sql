-- ═══════════════════════════════════════════════════════════════
-- Migration: fe-5173 learner portal — bổ sung tables & indexes
-- Chạy trên Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. notification_recipients — track thông báo per-user (đọc/chưa đọc)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_recipients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read     BOOLEAN DEFAULT false,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),

  UNIQUE(notification_id, user_id)
);

-- Indexes cho notification_recipients
CREATE INDEX IF NOT EXISTS idx_notif_recip_user_read
  ON notification_recipients (user_id, is_read)
  WHERE is_read = false;  -- partial: chỉ index chưa đọc

CREATE INDEX IF NOT EXISTS idx_notif_recip_notification
  ON notification_recipients (notification_id);

-- ────────────────────────────────────────────────────────────────
-- 2. user_badges — thêm is_shown (đánh dấu đã hiện popup)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS is_shown BOOLEAN DEFAULT false;

-- Index cho user_badges
CREATE INDEX IF NOT EXISTS idx_user_badges_user
  ON user_badges (user_id);

-- ────────────────────────────────────────────────────────────────
-- 3. block_completions — tracking hoàn thành từng block per enrollment
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS block_completions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  block_id      UUID NOT NULL REFERENCES course_blocks(id) ON DELETE CASCADE,
  completed_at  TIMESTAMPTZ DEFAULT now(),

  UNIQUE(enrollment_id, block_id)
);

CREATE INDEX IF NOT EXISTS idx_block_completions_enrollment
  ON block_completions (enrollment_id);

-- ────────────────────────────────────────────────────────────────
-- 4. Learner-optimized composite indexes
-- ────────────────────────────────────────────────────────────────

-- Learner tìm courses qua team_members → team_courses
CREATE INDEX IF NOT EXISTS idx_team_members_user
  ON team_members (user_id);

CREATE INDEX IF NOT EXISTS idx_team_courses_team
  ON team_courses (team_id);

CREATE INDEX IF NOT EXISTS idx_team_courses_course
  ON team_courses (course_id);

-- Enrollments: learner lấy enrollments + progress nhanh
CREATE INDEX IF NOT EXISTS idx_enrollments_user_tenant_active
  ON enrollments (user_id, tenant_id)
  WHERE is_active = true;

-- Course blocks: render course structure nhanh
CREATE INDEX IF NOT EXISTS idx_course_blocks_course_parent
  ON course_blocks (course_id, parent_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_course_blocks_course_published
  ON course_blocks (course_id, is_published)
  WHERE is_published = true;

-- Course progress: lookup nhanh theo enrollment
CREATE INDEX IF NOT EXISTS idx_course_progress_enrollment
  ON course_progress (enrollment_id);

-- Study sessions: lookup theo user
CREATE INDEX IF NOT EXISTS idx_study_sessions_user_tenant
  ON study_sessions (user_id, tenant_id);

-- Notifications: recent first
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
  ON notifications (tenant_id, created_at DESC);
