-- ═══════════════════════════════════════════════════════════════
-- Migration 002: Performance + Cleanup Indexes
-- Tối ưu cho hàng triệu rows + xóa duplicate indexes
-- ═══════════════════════════════════════════════════════════════

-- ── 1. XÓA DUPLICATE INDEXES (giảm storage + write overhead) ──
DROP INDEX IF EXISTS idx_audit_logs_action;
DROP INDEX IF EXISTS idx_audit_logs_created;
DROP INDEX IF EXISTS idx_audit_logs_created_at;
DROP INDEX IF EXISTS idx_audit_logs_tenant;
DROP INDEX IF EXISTS idx_course_blocks_course;
DROP INDEX IF EXISTS idx_course_blocks_parent;
DROP INDEX IF EXISTS idx_course_blocks_course_parent;
DROP INDEX IF EXISTS idx_documents_tenant;
DROP INDEX IF EXISTS idx_courses_tenant;

-- ── 2. THÊM COMPOSITE INDEXES cho million-row queries ──

-- Users: search theo full_name trong tenant
CREATE INDEX IF NOT EXISTS idx_users_tenant_fullname
  ON users (tenant_id, full_name);

-- Notification recipients: covering index cho learner notification list
CREATE INDEX IF NOT EXISTS idx_notif_recip_user_notif
  ON notification_recipients (user_id, notification_id);

-- Audit logs: composite cho filtered+sorted queries
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created_action
  ON audit_logs (tenant_id, created_at DESC, action);

-- Course blocks: filtered by type + published cho learner content tree
CREATE INDEX IF NOT EXISTS idx_blocks_course_type_pub
  ON course_blocks (course_id, block_type) WHERE is_published = true;

-- Study sessions: report daily aggregation
CREATE INDEX IF NOT EXISTS idx_study_tenant_studydate
  ON study_sessions (tenant_id, study_date DESC);

-- Team course categories: reverse lookup
CREATE INDEX IF NOT EXISTS idx_tcc_category
  ON team_course_categories (category_id);

-- Team doc categories: reverse lookup
CREATE INDEX IF NOT EXISTS idx_tdc_category
  ON team_doc_categories (category_id);
