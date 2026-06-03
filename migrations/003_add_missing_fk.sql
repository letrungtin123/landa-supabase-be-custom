-- ═══════════════════════════════════════════════════════════════
-- Migration 003: Add missing FK constraints
-- Chống rác khi xóa course
-- ═══════════════════════════════════════════════════════════════

-- course_modal_states.course_id → courses.id ON DELETE CASCADE
ALTER TABLE course_modal_states
  ADD CONSTRAINT fk_cms_course FOREIGN KEY (course_id)
  REFERENCES courses(id) ON DELETE CASCADE;

-- section_modal_shown.course_id → courses.id ON DELETE CASCADE
ALTER TABLE section_modal_shown
  ADD CONSTRAINT fk_sms_course FOREIGN KEY (course_id)
  REFERENCES courses(id) ON DELETE CASCADE;
