-- ═══════════════════════════════════════════════════════════════
-- Migration: Thêm published_data / published_metadata cho draft/publish workflow
-- Giống edX: learner chỉ thấy dữ liệu đã publish, admin edit trên draft
-- ═══════════════════════════════════════════════════════════════

-- Thêm columns lưu bản published (snapshot cuối cùng khi publish)
ALTER TABLE course_blocks
  ADD COLUMN IF NOT EXISTS published_data JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS published_metadata JSONB DEFAULT '{}';

-- Copy data hiện tại sang published (cho blocks đã published)
UPDATE course_blocks
SET published_data = data, published_metadata = metadata
WHERE is_published = true;
