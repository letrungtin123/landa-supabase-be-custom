// Temp files of course asset uploads (multer disk storage). The controller
// streams each one to Storage and removes it when the request ends; what is
// left behind is crash residue.
import fs from 'fs';
import path from 'path';

export const COURSE_ASSET_TEMP_DIR = path.join(process.cwd(), 'tmp', 'course-assets');
/** Older than any upload still in flight (the request budget is 20 minutes): crash residue. */
export const COURSE_ASSET_TEMP_MAX_AGE_MS = 12 * 60 * 60_000;

/**
 * minAgeMs 0 (a single 'all' process at start, as before): every file goes,
 * no upload can be in flight. With several processes another API process
 * may be receiving an upload right now, so only files older than minAgeMs go.
 */
export function cleanupStaleCourseAssetTempFiles(options: { minAgeMs?: number; directory?: string; now?: () => number } = {}): number {
  const directory = options.directory ?? COURSE_ASSET_TEMP_DIR;
  const minAgeMs = options.minAgeMs ?? 0;
  const cutoff = (options.now ?? Date.now)() - minAgeMs;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(directory, entry.name);
      if (minAgeMs > 0) {
        try {
          const stat = fs.statSync(filePath, { throwIfNoEntry: false });
          if (!stat || stat.mtimeMs >= cutoff) continue;
          fs.unlinkSync(filePath);
        } catch {
          continue; // Gone or still open: the next run tries again.
        }
      } else {
        fs.unlinkSync(filePath);
      }
      deleted += 1;
    }
    if (deleted > 0) {
      console.log(`[CourseAssets] Removed ${deleted} stale temp upload file(s)`);
    }
    return deleted;
  } catch (err) {
    console.warn('[CourseAssets] Failed to cleanup stale temp upload files:', err);
    return 0;
  }
}
