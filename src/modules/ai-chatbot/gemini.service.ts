// ═══════════════════════════════════════════════════════════════
// Gemini Service — Google Gemini File Search SDK integration
// ═══════════════════════════════════════════════════════════════
// Handles: client init, store management, file upload (LRO), delete (throttled)

import { GoogleGenAI } from '@google/genai';
import { query } from '../../config/database.js';
import fs from 'fs/promises';

// ── Constants ──
const LRO_POLL_INTERVAL = 5_000;   // 5 seconds
const LRO_TIMEOUT = 5 * 60_000;    // 5 minutes
const DELETE_BATCH_SIZE = 10;
const DELETE_BATCH_PAUSE = 150;     // 150ms between batches

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Utility ──
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Get Gemini API key for a tenant from tenants.settings.gemini_api_key.
 * Throws if key not configured.
 */
export async function getGeminiApiKey(tenantId: string): Promise<string> {
  const result = await query<{ api_key: string | null }>(
    `SELECT settings->>'gemini_api_key' AS api_key FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const key = result.rows[0]?.api_key;
  if (!key) {
    throw new Error('Gemini API key chưa được cấu hình cho tenant này. Vui lòng nhập API key trong Tenant Management.');
  }
  return key;
}

/**
 * Initialize Google GenAI client for a tenant.
 */
export async function getGeminiClient(tenantId: string): Promise<GoogleGenAI> {
  const apiKey = await getGeminiApiKey(tenantId);
  return new GoogleGenAI({ apiKey });
}

/**
 * Ensure a Gemini File Search Store exists for a KB.
 * Creates one if it doesn't exist (1:1 KB → Store).
 * @returns { storeId, storeName }
 */
export async function ensureStore(
  kbId: string,
  aiClient: GoogleGenAI,
): Promise<{ storeId: string; storeName: string }> {
  // Check existing
  const existing = await query<{ id: string; store_name: string }>(
    `SELECT id, store_name FROM kb_google_store WHERE kb_id = $1`,
    [kbId],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    return { storeId: existing.rows[0].id, storeName: existing.rows[0].store_name };
  }

  // Create new store on Gemini
  const store = await aiClient.fileSearchStores.create({
    config: { displayName: `kb-store-${kbId}` },
  });

  const storeName = store.name!;

  // Insert mapping
  const insertResult = await query<{ id: string }>(
    `INSERT INTO kb_google_store (kb_id, store_name) VALUES ($1, $2) RETURNING id`,
    [kbId, storeName],
  );

  return { storeId: insertResult.rows[0].id, storeName };
}

/**
 * Upload a local file to a Gemini File Search Store.
 * Uses Long Running Operation (LRO) polling.
 * @returns Gemini document path (e.g. "fileSearchStores/xxx/documents/yyy")
 */
export async function uploadToStore(
  storeName: string,
  localFilePath: string,
  displayName: string,
  aiClient: GoogleGenAI,
): Promise<string> {
  // .md → .txt workaround (Gemini SDK may not recognise .md mime properly)
  let uploadPath = localFilePath;
  if (localFilePath.endsWith('.md')) {
    uploadPath = localFilePath.replace(/\.md$/, '.txt');
    await fs.copyFile(localFilePath, uploadPath);
  }

  try {
    // Upload (returns LRO operation)
    let operation = await aiClient.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName: storeName,
      file: uploadPath,
      config: { displayName },
    });

    console.log('[Gemini] Upload initiated, polling LRO...');

    // LRO Polling — pass the whole operation object, not just the name
    const start = Date.now();
    while (operation && !(operation as any).done) {
      if (Date.now() - start > LRO_TIMEOUT) {
        throw new Error(`LRO timeout sau ${LRO_TIMEOUT / 1000}s`);
      }
      await sleep(LRO_POLL_INTERVAL);
      operation = await aiClient.operations.get({ operation: operation as any });
    }

    console.log('[Gemini] LRO completed, extracting document path...');

    // Extract document path from response
    // The operation.response contains the created document with its name
    const op = operation as any;
    const documentName =
      op?.response?.name ||
      op?.response?.documentName ||
      op?.name ||
      op?.documentName;

    if (!documentName || documentName.startsWith('operations/')) {
      // If we got an operation name instead of document name, log and try metadata
      console.log('[Gemini] Full operation response:', JSON.stringify(op, null, 2));
      throw new Error('Không lấy được document path từ Gemini response');
    }

    console.log(`[Gemini] Document created: ${documentName}`);
    return documentName;
  } finally {
    // Cleanup .txt copy
    if (uploadPath !== localFilePath) {
      try { await fs.unlink(uploadPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Delete documents from Gemini store — throttled to avoid rate limiting.
 * Batch size: 10, pause: 150ms between batches.
 */
export async function deleteFromStore(
  geminiPaths: string[],
  aiClient: GoogleGenAI,
): Promise<void> {
  if (geminiPaths.length === 0) return;

  const batches = chunkArray(geminiPaths, DELETE_BATCH_SIZE);

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (docPath) => {
        try {
          await aiClient.fileSearchStores.documents.delete({
            name: docPath,
            config: { force: true } as any,
          });
        } catch (err: any) {
          // 404 = already deleted, ignore
          if (!err.message?.includes('404') && !err.message?.includes('NOT_FOUND')) {
            console.error(`[Gemini] Failed to delete ${docPath}:`, err.message);
          }
        }
      }),
    );
    if (batches.indexOf(batch) < batches.length - 1) {
      await sleep(DELETE_BATCH_PAUSE);
    }
  }
}
