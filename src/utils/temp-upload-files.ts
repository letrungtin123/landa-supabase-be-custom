// ═══════════════════════════════════════════════════════════════
// Temp files of multer disk uploads — removed when the request ends
// ═══════════════════════════════════════════════════════════════

import { unlink } from 'node:fs/promises';

const TEMP_UPLOAD_UNLINK_RETRY_MS = 1_000;

/** Removes the temp files of a disk upload; one retry for a file Windows still holds open. */
export async function removeTempUploadFiles(
  uploaded: ReadonlyArray<{ path?: string } | undefined>,
  logTag: string,
): Promise<void> {
  await Promise.all(uploaded.map(async (item) => {
    const filePath = item?.path;
    if (!filePath) return;
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      await new Promise((resolve) => setTimeout(resolve, TEMP_UPLOAD_UNLINK_RETRY_MS));
      await unlink(filePath).catch(() => console.warn(`[${logTag}] Could not remove a temp upload file`));
    }
  }));
}
