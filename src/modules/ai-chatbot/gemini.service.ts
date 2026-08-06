// ═══════════════════════════════════════════════════════════════
// Gemini Service — Google Gemini File Search SDK integration
// ═══════════════════════════════════════════════════════════════
// Handles: client init, store management, file upload (LRO), delete (throttled)

import { createHmac } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { getClient, query } from '../../config/database.js';
import { env } from '../../config/env.js';
import fs from 'fs/promises';

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
 * Get Gemini API key for a tenant from tenants.settings.gemini_api_key.
 * Throws if key not configured.
 */
export async function getGeminiApiKey(tenantId: string): Promise<string> {
  const result = await query<{ api_key: string | null }>(
    `SELECT settings->>'gemini_api_key' AS api_key FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const key = result.rows[0]?.api_key?.trim();
  if (!key) {
    throw new Error('Gemini API key chưa được cấu hình cho tenant này. Vui lòng nhập API key trong Tenant Management.');
  }
  return key;
}

export function fingerprintGeminiApiKey(apiKey: string): string {
  return `hmac-sha256:v1:${createHmac('sha256', env.JWT_SECRET).update(apiKey.trim()).digest('hex')}`;
}

export async function getGeminiApiKeyFingerprint(tenantId: string): Promise<string> {
  return fingerprintGeminiApiKey(await getGeminiApiKey(tenantId));
}

export async function getOptionalGeminiApiKeyFingerprint(tenantId: string): Promise<string | null> {
  const result = await query<{ api_key: string | null }>(
    `SELECT settings->>'gemini_api_key' AS api_key FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const key = result.rows[0]?.api_key?.trim();
  return key ? fingerprintGeminiApiKey(key) : null;
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

export interface GeminiSpeechResult {
  audio: Buffer;
  mimeType: string;
}

function sanitizeTtsText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parsePcmAudioMime(mimeType: string): { sampleRate: number; channels: number; bitsPerSample: number } {
  const rateMatch = mimeType.match(/(?:^|;)\s*rate=(\d+)/i);
  const channelsMatch = mimeType.match(/(?:^|;)\s*channels=(\d+)/i);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24_000;
  const channels = channelsMatch ? parseInt(channelsMatch[1], 10) : 1;

  return {
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24_000,
    channels: Number.isFinite(channels) && channels > 0 ? channels : 1,
    bitsPerSample: 16,
  };
}

function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function toBrowserPlayableAudio(audio: Buffer, mimeType: string): GeminiSpeechResult {
  const normalizedMime = mimeType || 'audio/L16;codec=pcm;rate=24000';
  const lowerMime = normalizedMime.toLowerCase();
  if (lowerMime.includes('audio/l16') || lowerMime.includes('audio/pcm') || lowerMime.includes('codec=pcm')) {
    const { sampleRate, channels, bitsPerSample } = parsePcmAudioMime(normalizedMime);
    return { audio: wrapPcmAsWav(audio, sampleRate, channels, bitsPerSample), mimeType: 'audio/wav' };
  }
  return { audio, mimeType: normalizedMime };
}

interface GenerateSpeechOptions {
  voiceName?: string;
  voicePrompt?: string | null;
}

export async function generateSpeechForTenant(
  tenantId: string,
  text: string,
  options: GenerateSpeechOptions = {},
): Promise<GeminiSpeechResult> {
  const cleaned = sanitizeTtsText(text);
  if (!cleaned) throw new Error('Nội dung giọng nói không được để trống');

  const maxChars = Math.min(Math.max(env.GEMINI_TTS_MAX_CHARS, 1), 8_000);
  if (cleaned.length > maxChars) {
    throw new Error('Nội dung giọng nói vượt quá giới hạn ' + maxChars + ' ký tự');
  }

  const voiceName = options.voiceName?.trim() || env.GEMINI_TTS_VOICE;
  const voicePrompt = sanitizeTtsText(options.voicePrompt ?? '').slice(0, 4_000);
  const ttsInstruction = [
    'Đọc nội dung sau bằng tiếng Việt tự nhiên, rõ ràng, thân thiện.',
    voicePrompt ? `Áp dụng hướng dẫn phong cách giọng đọc: ${voicePrompt}` : '',
    'Chỉ đọc nội dung trong phần "NỘI DUNG", không đọc hướng dẫn và không thêm lời dẫn.',
    '',
    'NỘI DUNG:',
    cleaned,
  ].filter(Boolean).join('\n');

  const aiClient = await getGeminiClient(tenantId);
  const response = await aiClient.models.generateContent({
    model: env.GEMINI_TTS_MODEL,
    contents: [{
      role: 'user',
      parts: [{
        text: ttsInstruction,
      }],
    }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: 'vi-VN',
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName || 'Sulafat' },
        },
      },
    },
  });

  const inlineData = response.candidates?.[0]?.content?.parts?.find(part => Boolean(part.inlineData?.data))?.inlineData;
  const audioBase64 = inlineData?.data || response.data;
  if (!audioBase64) throw new Error('Gemini TTS không trả về audio');

  return toBrowserPlayableAudio(Buffer.from(audioBase64, 'base64'), inlineData?.mimeType || 'audio/L16;codec=pcm;rate=24000');
}

/**
 * Ensure a Gemini File Search Store exists for a KB.
 * Creates one if it doesn't exist (1:1 KB → Store).
 * @returns { storeId, storeName }
 */
export async function ensureStore(
  kbId: string,
  aiClient: GoogleGenAI,
  apiKeyFingerprint?: string | null,
): Promise<{ storeId: string; storeName: string }> {
  const client = await getClient();
  let createdStoreName: string | null = null;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-google-store:${kbId}`]);

    const existing = await client.query<{ id: string; store_name: string; api_key_fingerprint: string | null; remote_status: string }>(
      `SELECT id, store_name, api_key_fingerprint, remote_status FROM kb_google_store WHERE kb_id = $1 LIMIT 1`,
      [kbId],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      if (
        existing.rows[0].remote_status !== 'active' ||
        (apiKeyFingerprint && existing.rows[0].api_key_fingerprint && existing.rows[0].api_key_fingerprint !== apiKeyFingerprint)
      ) {
        throw new Error('Knowledge Base store can khoi phuc truoc khi upload tai lieu moi.');
      }
      await client.query('COMMIT');
      return { storeId: existing.rows[0].id, storeName: existing.rows[0].store_name };
    }

    const store = await aiClient.fileSearchStores.create({
      config: { displayName: `kb-store-${kbId}` },
    });
    if (!store.name) {
      throw new Error('Gemini File Search store creation did not return a store name');
    }
    createdStoreName = store.name;

    const insertResult = await client.query<{ id: string }>(
      `INSERT INTO kb_google_store (kb_id, store_name, api_key_fingerprint, remote_status, last_checked_at)
       VALUES ($1, $2, $3, 'active', now())
       RETURNING id`,
      [kbId, createdStoreName, apiKeyFingerprint ?? null],
    );

    await client.query('COMMIT');
    return { storeId: insertResult.rows[0].id, storeName: createdStoreName };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (createdStoreName) {
      try {
        await deleteFileSearchStoreIfExists(createdStoreName, aiClient);
      } catch (cleanupErr: any) {
        console.error('[Gemini] Failed to cleanup newly-created orphan store:', redactGeminiApiKeys(cleanupErr?.message || String(cleanupErr)));
      }
    }
    throw err;
  } finally {
    client.release();
  }
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
