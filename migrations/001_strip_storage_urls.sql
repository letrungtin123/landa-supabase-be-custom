-- ═══════════════════════════════════════════════════════════════
-- Migration: Strip full Supabase URLs → storage paths only
-- 
-- BẢO MẬT: DB chỉ lưu storage path (e.g. "tenant/avatars/file.jpg")
-- KHÔNG lưu full URL (e.g. "http://127.0.0.1:54321/storage/v1/...")
-- 
-- Chạy 1 lần sau khi deploy code mới
-- ═══════════════════════════════════════════════════════════════

-- 1. Users: avatar_url
UPDATE users
SET avatar_url = SUBSTRING(
  avatar_url FROM POSITION('/object/public/landa-storage/' IN avatar_url) + LENGTH('/object/public/landa-storage/')
)
WHERE avatar_url IS NOT NULL
  AND avatar_url LIKE '%/object/public/landa-storage/%';

-- 2. Documents: file_url
UPDATE documents
SET file_url = SUBSTRING(
  file_url FROM POSITION('/object/public/landa-storage/' IN file_url) + LENGTH('/object/public/landa-storage/')
)
WHERE file_url IS NOT NULL
  AND file_url LIKE '%/object/public/landa-storage/%';

-- 3. Course assets: url
UPDATE course_assets
SET url = SUBSTRING(
  url FROM POSITION('/object/public/landa-storage/' IN url) + LENGTH('/object/public/landa-storage/')
)
WHERE url IS NOT NULL
  AND url LIKE '%/object/public/landa-storage/%';

-- Verify: Kiểm tra không còn full URL nào
-- SELECT avatar_url FROM users WHERE avatar_url LIKE 'http%' LIMIT 5;
-- SELECT file_url FROM documents WHERE file_url LIKE 'http%' LIMIT 5;
-- SELECT url FROM course_assets WHERE url LIKE 'http%' LIMIT 5;
