// ═══════════════════════════════════════════════════════════════
// Gemini Service — Google Gemini File Search SDK integration
// ═══════════════════════════════════════════════════════════════
// Handles: client init, store management, file upload (LRO), delete (throttled)

import { createHmac } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import type { AiUsage } from './ai-engine.types.js';
import { BilledAiCallError } from './ai-metered-call.service.js';
import { aiUsageFromGeminiMetadata } from './ai-usage.logic.js';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import fs from 'fs/promises';
import {
  getGoogleAiStudioApiKey,
  getOptionalGoogleAiStudioApiKeyFingerprint,
} from './ai-settings.service.js';
import {
  extractGeminiAudioTranscriptionText,
  summarizeGeminiTranscriptionResponse,
} from './gemini-transcription.logic.js';

// ── Constants ──
const LRO_POLL_INTERVAL = 5_000;   // 5 seconds
const LRO_TIMEOUT = 5 * 60_000;    // 5 minutes
const DELETE_BATCH_SIZE = 10;
const DELETE_BATCH_PAUSE = 150;     // 150ms between batches

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function redactGeminiApiKeys(value: string): string {
  return value.replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|AQ\.?[0-9A-Za-z_-]{8,})\b/g, '[redacted]');
}

function isMissingGeminiResourceError(err: any): boolean {
  const status = err?.status || err?.code || 0;
  const msg = err?.message || err?.toString?.() || '';
  return status === 404 || /(^|\b)(404|NOT_FOUND)(\b|$)/i.test(msg);
}

export function isGeminiPermissionDeniedError(err: any): boolean {
  const status = err?.status || err?.code || 0;
  const msg = err?.message || err?.toString?.() || '';
  return status === 403 || /(^|\b)(403|PERMISSION_DENIED|permission denied|forbidden)(\b|$)/i.test(msg);
}

function throwGeminiCleanupError(action: string, err: any): never {
  const raw = err?.message || err?.toString?.() || 'Unknown Gemini error';
  const msg = redactGeminiApiKeys(String(raw)).slice(0, 500);
  console.error(`[Gemini] ${action} failed:`, msg);
  throw new Error(`${action} thất bại. DB chưa được thay đổi để tránh mồ côi dữ liệu trên Gemini File Search.`);
}

// ── Utility ──
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Get the tenant Google AI Studio API key through the central AI settings service.
 * Throws if key not configured.
 */
export async function getGeminiApiKey(tenantId: string): Promise<string> {
  return getGoogleAiStudioApiKey(tenantId);
}

export function fingerprintGeminiApiKey(apiKey: string): string {
  return `hmac-sha256:v1:${createHmac('sha256', env.JWT_SECRET).update(apiKey.trim()).digest('hex')}`;
}

export async function getGeminiApiKeyFingerprint(tenantId: string): Promise<string> {
  return fingerprintGeminiApiKey(await getGeminiApiKey(tenantId));
}

export async function getOptionalGeminiApiKeyFingerprint(tenantId: string): Promise<string | null> {
  return getOptionalGoogleAiStudioApiKeyFingerprint(tenantId);
}

export async function markTenantGeminiStoresKeyChanged(
  tenantId: string,
  currentFingerprint: string | null,
): Promise<number> {
  const result = await query(
    `UPDATE kb_google_store kgs
     SET remote_status = 'key_changed',
         remote_error_code = 'KEY_CHANGED',
         remote_error_reason = 'Tenant Gemini API key was changed; restore this KB to rebuild a store for the current key.',
         last_checked_at = now()
     FROM knowledgebases kb
     WHERE kb.id = kgs.kb_id
       AND kb.tenant_id = $1
       AND kgs.remote_status IN ('active', 'permission_denied')
       AND (
         kgs.api_key_fingerprint IS NULL
         OR $2::text IS NULL
         OR kgs.api_key_fingerprint <> $2::text
       )`,
    [tenantId, currentFingerprint],
  );
  return result.rowCount || 0;
}

export async function markKbGeminiStoreRemoteProblem(
  kbId: string,
  remoteStatus: 'key_changed' | 'permission_denied' | 'not_found',
  errorCode: string,
  errorReason: string,
): Promise<void> {
  await query(
    `UPDATE kb_google_store
     SET remote_status = $2,
         remote_error_code = $3,
         remote_error_reason = $4,
         last_checked_at = now()
     WHERE kb_id = $1`,
    [kbId, remoteStatus, errorCode, redactGeminiApiKeys(errorReason).slice(0, 1000)],
  );
}

/**
 * Initialize Google GenAI client for a tenant.
 */
export async function getGeminiClient(tenantId: string): Promise<GoogleGenAI> {
  const apiKey = await getGeminiApiKey(tenantId);
  return new GoogleGenAI({ apiKey });
}

/**
 * Upload an extracted audio stream to Gemini's Files API and request a plain
 * transcript. The SDK response surface differs between provider revisions, so
 * this boundary intentionally normalizes it before the durable worker writes
 * anything to the database.
 */
export async function transcribeAudioFile(
  localFilePath: string,
  aiClient: GoogleGenAI,
  options: { maxOutputTokens?: number } = {},
): Promise<{ text: string; usage: AiUsage | null }> {
  const filesApi = (aiClient as any).files;
  const modelsApi = (aiClient as any).models;
  if (!filesApi?.upload || !filesApi?.delete || !modelsApi?.generateContent) {
    throw new Error('Gemini SDK không hỗ trợ Files API cho transcription.');
  }

  let uploaded: any = null;
  try {
    uploaded = await filesApi.upload({
      file: localFilePath,
      config: { mimeType: 'audio/mpeg' },
    });
    const startedAt = Date.now();
    while (uploaded?.state && String(uploaded.state).toUpperCase() !== 'ACTIVE') {
      if (String(uploaded.state).toUpperCase() === 'FAILED') {
        throw new Error('Gemini không thể xử lý audio của video.');
      }
      if (Date.now() - startedAt > LRO_TIMEOUT) throw new Error('Gemini xử lý audio quá thời gian cho phép.');
      await sleep(LRO_POLL_INTERVAL);
      uploaded = await filesApi.get({ name: uploaded.name });
    }
    if (!uploaded?.uri) throw new Error('Gemini không trả về URI audio hợp lệ.');

    const response = await modelsApi.generateContent({
      model: env.GEMINI_TRANSCRIPTION_MODEL,
      contents: [
        {
          fileData: {
            fileUri: uploaded.uri,
            mimeType: uploaded.mimeType || 'audio/mpeg',
          },
        },
      ],
      // Deliberately leave languageCodes empty: Gemini detects Vietnamese,
      // English, and code switching from the actual audio rather than the UI
      // locale used for status messages.
      config: {
        audioTranscriptionConfig: {
          languageCodes: [],
        },
        // A cap on the transcript keeps a long or looping audio from billing without bound.
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      },
    });
    const text = extractGeminiAudioTranscriptionText(response);
    if (!text) {
      console.warn('[Gemini] Transcription response did not contain usable text', summarizeGeminiTranscriptionResponse(response));
      const failure = new Error('Gemini không trả về transcript hợp lệ.');
      const billed = aiUsageFromGeminiMetadata(response.usageMetadata);
      // The audio was processed and billed: let the AI meter settle it.
      throw billed ? new BilledAiCallError(billed, failure) : failure;
    }
    return { text, usage: aiUsageFromGeminiMetadata(response.usageMetadata) };
  } finally {
    if (uploaded?.name) await filesApi.delete({ name: uploaded.name }).catch(() => undefined);
  }
}

/** Serializes recording a KB's store row (pg_advisory_xact_lock key prefix). */
const KB_GOOGLE_STORE_LOCK_PREFIX = 'kb-google-store:';

type KbGoogleStoreRow = { id: string; store_name: string; api_key_fingerprint: string | null; remote_status: string };

const KB_GOOGLE_STORE_SELECT_SQL =
  `SELECT id, store_name, api_key_fingerprint, remote_status FROM kb_google_store WHERE kb_id = $1 LIMIT 1`;

function usableStore(row: KbGoogleStoreRow, apiKeyFingerprint?: string | null): { storeId: string; storeName: string } {
  if (
    row.remote_status !== 'active' ||
    (apiKeyFingerprint && row.api_key_fingerprint && row.api_key_fingerprint !== apiKeyFingerprint)
  ) {
    throw new Error('Knowledge Base store can khoi phuc truoc khi upload tai lieu moi.');
  }
  return { storeId: row.id, storeName: row.store_name };
}

/** Removes a store this call created but did not record; a failure leaves a logged remote orphan. */
async function discardUnrecordedStore(storeName: string, aiClient: GoogleGenAI): Promise<void> {
  try {
    await deleteFileSearchStoreIfExists(storeName, aiClient);
  } catch (cleanupErr: any) {
    console.error('[Gemini] Failed to cleanup newly-created orphan store:', redactGeminiApiKeys(cleanupErr?.message || String(cleanupErr)));
  }
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Ensure a Gemini File Search Store exists for a KB.
 * Creates one if it doesn't exist (1:1 KB → Store).
 *
 * No transaction or pool connection is held during the Gemini call (it has
 * its own deadline, GEMINI_STORE_CREATE_TIMEOUT_MS). The new store is then
 * recorded in a short transaction under the KB's advisory lock, which reads
 * the row again first: when another call recorded a store meanwhile, that
 * store is used and the one created here is deleted, so a KB never ends up
 * with two stores (kb_google_store.kb_id is also unique).
 * @returns { storeId, storeName }
 */
export async function ensureStore(
  kbId: string,
  aiClient: GoogleGenAI,
  apiKeyFingerprint?: string | null,
): Promise<{ storeId: string; storeName: string }> {
  const existing = await query<KbGoogleStoreRow>(KB_GOOGLE_STORE_SELECT_SQL, [kbId]);
  if (existing.rows[0]) return usableStore(existing.rows[0], apiKeyFingerprint);

  let store: Awaited<ReturnType<GoogleGenAI['fileSearchStores']['create']>>;
  try {
    store = await aiClient.fileSearchStores.create({
      config: {
        displayName: `kb-store-${kbId}`,
        abortSignal: AbortSignal.timeout(env.GEMINI_STORE_CREATE_TIMEOUT_MS),
      },
    });
  } catch (err) {
    if (isAbortError(err)) throw new Error('Gemini không tạo được kho tài liệu trong thời gian cho phép.');
    throw err;
  }
  if (!store.name) {
    throw new Error('Gemini File Search store creation did not return a store name');
  }
  const createdStoreName = store.name;

  let recorded: { row: KbGoogleStoreRow; inserted: boolean };
  try {
    recorded = await withDatabaseTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${KB_GOOGLE_STORE_LOCK_PREFIX}${kbId}`]);
      const current = await client.query<KbGoogleStoreRow>(KB_GOOGLE_STORE_SELECT_SQL, [kbId]);
      if (current.rows[0]) return { row: current.rows[0], inserted: false };
      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO kb_google_store (kb_id, store_name, api_key_fingerprint, remote_status, last_checked_at)
         VALUES ($1, $2, $3, 'active', now())
         RETURNING id`,
        [kbId, createdStoreName, apiKeyFingerprint ?? null],
      );
      return {
        row: { id: insertResult.rows[0].id, store_name: createdStoreName, api_key_fingerprint: apiKeyFingerprint ?? null, remote_status: 'active' },
        inserted: true,
      };
    });
  } catch (err) {
    await discardUnrecordedStore(createdStoreName, aiClient);
    throw err;
  }

  if (!recorded.inserted) {
    await discardUnrecordedStore(createdStoreName, aiClient);
    return usableStore(recorded.row, apiKeyFingerprint);
  }
  return { storeId: recorded.row.id, storeName: createdStoreName };
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
          if (isMissingGeminiResourceError(err)) return;
          throwGeminiCleanupError(`Xoá tài liệu ${docPath} khỏi Gemini File Search`, err);
        }
      }),
    );
    if (batches.indexOf(batch) < batches.length - 1) {
      await sleep(DELETE_BATCH_PAUSE);
    }
  }
}

export async function deleteFileSearchStoreIfExists(
  storeName: string,
  aiClient: GoogleGenAI,
): Promise<boolean> {
  try {
    await aiClient.fileSearchStores.delete({
      name: storeName,
      config: { force: true } as any,
    });
    return true;
  } catch (err: any) {
    if (isMissingGeminiResourceError(err)) return false;
    throwGeminiCleanupError(`Xoá File Search store ${storeName}`, err);
  }
}
