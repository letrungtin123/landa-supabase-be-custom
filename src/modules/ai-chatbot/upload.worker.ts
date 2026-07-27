// ═══════════════════════════════════════════════════════════════
// Upload Worker — Consume upload jobs from RabbitMQ
// Download file from Supabase → upload to Gemini Store → link mapping
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import { downloadToTempFile } from '../../config/storage.js';
import { env } from '../../config/env.js';
import { getGeminiApiKeyFingerprint, getGeminiClient, ensureStore, uploadToStore, deleteFromStore } from './gemini.service.js';
import {
  claimRestoreDocumentForUpload,
  getDocument,
  linkDocumentGemini,
  recordRestoreDocumentFinished,
  resetRestoreDocumentForRetry,
  setRestoreJobNewStore,
  updateDocumentStatus,
} from './kb.service.js';
import { query } from '../../config/database.js';

interface UploadJob {
  documentId: string;
  kbId: string;
  tenantId: string;
  mode: 'file' | 'faq' | 'article' | 'url';
  restoreJobId?: string;
}

async function processUploadJob(data: Record<string, any>): Promise<void> {
  const job = data as unknown as UploadJob;
  const { documentId, kbId, tenantId, restoreJobId } = job;

  let tempPath: string | null = null;
  let restoreClaimed = false;

  try {
    if (restoreJobId) {
      restoreClaimed = await claimRestoreDocumentForUpload(restoreJobId, documentId, kbId, tenantId);
      if (!restoreClaimed) {
        console.log(`[UploadWorker] Restore document ${documentId} already claimed or finished, skipping duplicate`);
        return;
      }
      await updateDocumentStatus(documentId, 'learning');
    }

    // 1. Verify document still exists
    const doc = await getDocument(documentId, tenantId);
    if (!doc) {
      console.warn(`[UploadWorker] Document ${documentId} not found, skipping`);
      if (restoreJobId && restoreClaimed) {
        await recordRestoreDocumentFinished(restoreJobId, documentId, kbId, tenantId, false, 'Document not found');
      }
      return;
    }
    if (!doc.file_path) {
      throw new Error('Document has no file_path');
    }

    // 2. Anti-race: check if already linked
    const existingMapping = await query<{ id: string }>(
      `SELECT id FROM kb_doc_gemini_mapping WHERE document_id = $1 LIMIT 1`,
      [documentId],
    );
    if (existingMapping.rowCount && existingMapping.rowCount > 0) {
      console.log(`[UploadWorker] Document ${documentId} already linked, marking learned`);
      await updateDocumentStatus(documentId, 'learned');
      if (restoreJobId) {
        await recordRestoreDocumentFinished(restoreJobId, documentId, kbId, tenantId, true);
      }
      return;
    }

    // 3. Download file from Supabase Storage to temp
    console.log(`[UploadWorker] Processing document ${documentId}`);
    tempPath = await downloadToTempFile(doc.file_path, env.GEMINI_TEMP_DIR);

    // 4. Get Gemini client
    const [aiClient, apiKeyFingerprint] = await Promise.all([
      getGeminiClient(tenantId),
      getGeminiApiKeyFingerprint(tenantId),
    ]);

    // 5. Ensure store exists
    const { storeId, storeName } = await ensureStore(kbId, aiClient, apiKeyFingerprint);
    if (restoreJobId) {
      await setRestoreJobNewStore(restoreJobId, kbId, tenantId, storeName);
    }

    // 6. Upload to Gemini store (LRO polling)
    const displayName = doc.name || `doc-${documentId}`;
    const geminiPath = await uploadToStore(storeName, tempPath, displayName, aiClient);

    // 7. Link mapping. If DB mapping cannot be created, remove the Gemini doc
    // immediately so File Search never keeps an untracked document.
    try {
      const linked = await linkDocumentGemini(documentId, storeId, geminiPath);
      if (!linked) {
        await deleteFromStore([geminiPath], aiClient);
        console.log(`[UploadWorker] Duplicate mapping detected for ${documentId}, cleaned uploaded Gemini doc`);
      }
    } catch (linkErr) {
      await deleteFromStore([geminiPath], aiClient);
      throw linkErr;
    }

    // 8. Mark as learned
    await updateDocumentStatus(documentId, 'learned');
    if (restoreJobId) {
      await recordRestoreDocumentFinished(restoreJobId, documentId, kbId, tenantId, true);
    }
    console.log(`[UploadWorker] Document ${documentId} → learned`);

  } catch (err: any) {
    console.error(`[UploadWorker] Error for document ${documentId}:`, err.message);
    if (restoreJobId && restoreClaimed) {
      await resetRestoreDocumentForRetry(restoreJobId, documentId, kbId, tenantId, err.message || 'Upload failed');
    } else {
      await updateDocumentStatus(documentId, 'error', err.message);
    }
    throw err; // Re-throw for consumer retry logic
  } finally {
    // ALWAYS cleanup temp file
    if (tempPath) {
      try { await fs.unlink(tempPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Start the upload consumer.
 */
export async function startUploadWorker(): Promise<void> {
  await consume(
    QUEUES.GEMINI_UPLOAD,
    processUploadJob,
    async function onMaxRetry(_queue: string, rawMessage: string) {
      // Mark document as error after max retries
      try {
        const data = JSON.parse(rawMessage);
        if (data.documentId) {
          await updateDocumentStatus(data.documentId, 'error', 'Max retries exceeded');
          if (data.restoreJobId && data.kbId && data.tenantId) {
            await recordRestoreDocumentFinished(data.restoreJobId, data.documentId, data.kbId, data.tenantId, false, 'Max retries exceeded');
          }
        }
      } catch { /* ignore */ }
    },
  );
}
