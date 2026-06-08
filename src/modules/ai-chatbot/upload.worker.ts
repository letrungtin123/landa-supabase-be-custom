// ═══════════════════════════════════════════════════════════════
// Upload Worker — Consume upload jobs from RabbitMQ
// Download file from Supabase → upload to Gemini Store → link mapping
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import { downloadToTempFile } from '../../config/storage.js';
import { env } from '../../config/env.js';
import { getGeminiClient, ensureStore, uploadToStore } from './gemini.service.js';
import { updateDocumentStatus, linkDocumentGemini, getDocument } from './kb.service.js';
import { query } from '../../config/database.js';

interface UploadJob {
  documentId: string;
  kbId: string;
  tenantId: string;
  mode: 'file' | 'faq' | 'article' | 'url';
}

async function processUploadJob(data: Record<string, any>): Promise<void> {
  const job = data as unknown as UploadJob;
  const { documentId, kbId, tenantId } = job;

  let tempPath: string | null = null;

  try {
    // 1. Verify document still exists
    const doc = await getDocument(documentId, tenantId);
    if (!doc) {
      console.warn(`[UploadWorker] Document ${documentId} not found, skipping`);
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
      return;
    }

    // 3. Download file from Supabase Storage to temp
    console.log(`[UploadWorker] Processing document ${documentId}`);
    tempPath = await downloadToTempFile(doc.file_path, env.GEMINI_TEMP_DIR);

    // 4. Get Gemini client
    const aiClient = await getGeminiClient(tenantId);

    // 5. Ensure store exists
    const { storeId, storeName } = await ensureStore(kbId, aiClient);

    // 6. Upload to Gemini store (LRO polling)
    const displayName = doc.name || `doc-${documentId}`;
    const geminiPath = await uploadToStore(storeName, tempPath, displayName, aiClient);

    // 7. Link mapping
    await linkDocumentGemini(documentId, storeId, geminiPath);

    // 8. Mark as learned
    await updateDocumentStatus(documentId, 'learned');
    console.log(`[UploadWorker] Document ${documentId} → learned`);

  } catch (err: any) {
    console.error(`[UploadWorker] Error for document ${documentId}:`, err.message);
    await updateDocumentStatus(documentId, 'error', err.message);
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
        }
      } catch { /* ignore */ }
    },
  );
}
