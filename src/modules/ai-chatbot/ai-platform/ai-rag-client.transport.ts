// HTTP transport of the AI RAG client: service URL and token, HMAC request signing, keep-alive
// agents, JSON requests and the mapping of AI service errors. Split out of ai-rag-client.service.ts
// (move only), which re-exports its public names.

import http from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readSafeBlueprintFailure } from '../ai-id/content/lesson-author-capabilities.logic.js';
import https from 'node:https';
import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/error-handler.js';
import type { AiUsage } from './ai-engine.types.js';

export class RagServiceError extends AppError {
  public readonly diagnostics: Record<string, string | number>;
  public readonly usage?: Partial<AiUsage>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    usage?: Partial<AiUsage>,
    diagnostics?: unknown,
  ) {
    super(message, statusCode, code);
    this.name = 'RagServiceError';
    this.usage = usage;
    this.diagnostics = readSafeBlueprintFailure(diagnostics);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSafeUsage(value: unknown): Partial<AiUsage> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const usage: Partial<AiUsage> = {};
  for (const field of ['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens', 'cachedInputTokens'] as const) {
    const candidate = raw[field];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      usage[field] = Math.floor(candidate);
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** User-facing text (kb_documents.error_reason on a terminal failure) for SEP-1 index/storage codes. */
const RAG_INDEX_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  DOCUMENT_TYPE_UNSUPPORTED: 'Định dạng tài liệu chưa được hỗ trợ để AI học. Hãy dùng PDF, Word, PowerPoint, Excel, TXT, Markdown hoặc CSV.',
  STORAGE_OBJECT_UNAVAILABLE: 'Không tìm thấy tệp nguồn của tài liệu trong kho lưu trữ.',
  STORAGE_DOWNLOAD_FAILED: 'Không tải được tệp nguồn từ kho lưu trữ. Hệ thống sẽ thử lại.',
  STORAGE_URL_REJECTED: 'Cấu hình tải tệp nguồn cho dịch vụ AI chưa đúng. Vui lòng liên hệ quản trị viên.',
  STORAGE_REDIRECT_REJECTED: 'Cấu hình tải tệp nguồn cho dịch vụ AI chưa đúng. Vui lòng liên hệ quản trị viên.',
  SOURCE_DOWNLOAD_URL_REQUIRED: 'Cấu hình tải tệp nguồn cho dịch vụ AI chưa đúng. Vui lòng liên hệ quản trị viên.',
  DATABASE_NOT_READY: 'Dịch vụ AI đang khởi động. Hệ thống sẽ thử lại.',
});

function readSafeRagErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return /^[A-Z][A-Z0-9_]{2,95}$/.test(code) ? code : null;
}

function requireRagServiceUrl(): string {
  const baseUrl = env.AI_RAG_SERVICE_URL.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new AppError('Dịch vụ AI RAG chưa được cấu hình trên máy chủ.', 503, 'AI_RAG_SERVICE_NOT_CONFIGURED');
  }
  const hmacConfigured = Boolean(env.AI_RAG_SERVICE_HMAC_KEY_ID && env.AI_RAG_SERVICE_HMAC_SECRET);
  const hmacPartiallyConfigured = Boolean(env.AI_RAG_SERVICE_HMAC_KEY_ID || env.AI_RAG_SERVICE_HMAC_SECRET);
  if (hmacPartiallyConfigured && !hmacConfigured) {
    throw new AppError('Cấu hình chữ ký dịch vụ AI RAG chưa đầy đủ.', 503, 'AI_RAG_SERVICE_HMAC_NOT_CONFIGURED');
  }
  if (env.isProduction && !getRagServiceToken() && !hmacConfigured) {
    throw new AppError('Dịch vụ AI RAG thiếu xác thực nội bộ trên máy chủ.', 503, 'AI_RAG_SERVICE_AUTH_NOT_CONFIGURED');
  }
  return baseUrl;
}

function getRagServiceToken(): string {
  return env.AI_RAG_SERVICE_TOKEN;
}

function isRagRequestTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'AI_RAG_REQUEST_TIMEOUT';
}

/**
 * SEP-1 #6: keep-alive agents for the AI service. A reused socket idles out after
 * AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS (default 30 s), below the server side (uvicorn 75 s, nginx 75 s),
 * so the client never writes a request onto a socket the server is closing (ECONNRESET). Every
 * request still sets its own, longer timeout while it is in flight.
 */
export function createRagHttpAgents(idleTimeoutMs: number): { http: http.Agent; https: https.Agent } {
  const options = { keepAlive: true, timeout: idleTimeoutMs, scheduling: 'lifo' as const };
  return { http: new http.Agent(options), https: new https.Agent(options) };
}

const ragHttpAgents = createRagHttpAgents(env.AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS);

interface PreparedRagRequest {
  method: 'GET' | 'POST';
  requestBody: string;
  url: URL;
  transport: typeof http | typeof https;
  agent: http.Agent | https.Agent;
  correlationId?: string;
}

export function prepareRagRequest(
  path: string,
  body: Record<string, unknown> | null,
  method: 'GET' | 'POST' = 'POST',
): PreparedRagRequest {
  const requestBody = body === null ? '' : JSON.stringify(body);
  const url = new URL(`${requireRagServiceUrl()}${path}`);
  const correlationId = typeof body?.correlation_id === 'string' && body.correlation_id.trim()
    ? body.correlation_id.trim()
    : undefined;
  const secure = url.protocol === 'https:';
  return { method, requestBody, url, transport: secure ? https : http,
    agent: secure ? ragHttpAgents.https : ragHttpAgents.http, correlationId };
}

/** Value of X-Landa-Signature-Version: the AI service checks a v2 signature (HMAC v2 spec). */
export const RAG_HMAC_SIGNATURE_VERSION = '2';

interface RagHmacInput {
  keyId: string;
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  requestBody: string;
  requestId: string;
}

/**
 * The v2 canonical message: UTF-8 lines joined by \n, no trailing newline. The key id and the request
 * id are signed too, so a captured request cannot be sent again under a fresh X-Landa-Request-Id
 * (security audit 2026-10-24, M1). The path has no query string, like v1.
 */
export function ragHmacCanonicalMessage(input: Omit<RagHmacInput, 'secret'>): string {
  const bodyHash = createHash('sha256').update(input.requestBody, 'utf8').digest('hex');
  return ['v2', input.keyId, input.requestId, input.timestamp, input.method.toUpperCase(), input.path, bodyHash]
    .join('\n');
}

export function buildRagHmacHeaders(input: RagHmacInput): Record<string, string> {
  if (!input.keyId || !input.secret) return {};
  const canonical = ragHmacCanonicalMessage(input);
  return {
    'X-Landa-Key-Id': input.keyId,
    'X-Landa-Timestamp': input.timestamp,
    'X-Landa-Signature': createHmac('sha256', input.secret).update(canonical, 'utf8').digest('hex'),
    'X-Landa-Signature-Version': RAG_HMAC_SIGNATURE_VERSION,
    'X-Landa-Request-Id': input.requestId,
  };
}

async function requestRagJson(
  prepared: PreparedRagRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ statusCode: number; payload: unknown }> {
  const { method, requestBody, url, transport, agent } = prepared;
  const hmacHeaders = buildRagHmacHeaders({
    keyId: env.AI_RAG_SERVICE_HMAC_KEY_ID,
    secret: env.AI_RAG_SERVICE_HMAC_SECRET,
    timestamp: Math.floor(Date.now() / 1_000).toString(),
    method,
    path: url.pathname,
    requestBody,
    requestId: randomUUID(),
  });

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      agent,
      headers: {
        ...(method === 'POST' ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody).toString(),
        } : {}),
        ...(getRagServiceToken() ? { 'X-Landa-AI-Service-Token': getRagServiceToken() } : {}),
        ...hmacHeaders,
        ...(prepared.correlationId ? { 'X-Correlation-Id': prepared.correlationId } : {}),
      },
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload: unknown = null;
        if (raw) {
          try { payload = JSON.parse(raw); } catch { payload = null; }
        }
        resolve({ statusCode: response.statusCode ?? 500, payload });
      });
      response.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error('AI_RAG_REQUEST_TIMEOUT'));
    });
    req.on('error', reject);
    if (method === 'POST') req.write(requestBody);
    req.end();
  });
}

export async function postRagJson<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = env.AI_RAG_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
  beforeRequestDispatch?: () => Promise<void>,
): Promise<T> {
  return sendRagJson<T>(prepareRagRequest(path, body), timeoutMs, signal, beforeRequestDispatch);
}

export async function sendRagJson<T>(
  prepared: PreparedRagRequest,
  timeoutMs: number,
  signal?: AbortSignal,
  beforeRequestDispatch?: () => Promise<void>,
): Promise<T> {
  await beforeRequestDispatch?.();
  try {
    const response = await requestRagJson(prepared, timeoutMs, signal);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const { payload } = response;
      const payloadRecord = asRecord(payload);
      const detail = payloadRecord ? payloadRecord.detail : null;
      const detailRecord = asRecord(detail);
      const message = detailRecord && typeof detailRecord.message === 'string'
        ? detailRecord.message.trim()
        : typeof detail === 'string'
          ? detail.trim()
          : '';
      const fallbackCode = response.statusCode === 413
        ? 'REQUEST_TOO_LARGE'
        : response.statusCode === 503
          ? 'SERVICE_BUSY'
          : 'AI_RAG_SERVICE_ERROR';
      const code = readSafeRagErrorCode(detailRecord?.code) ?? fallbackCode;
      const safeMessage = code === 'REQUEST_TOO_LARGE'
        ? 'Dữ liệu gửi sang dịch vụ AI vượt giới hạn cho phép.'
        : code === 'DOCUMENT_LIMIT_EXCEEDED'
          ? 'Tài liệu vượt giới hạn xử lý an toàn. Vui lòng giảm dung lượng hoặc độ dài tài liệu.'
          : code === 'SERVICE_BUSY'
            ? 'Dịch vụ AI đang bận. Vui lòng thử lại sau.'
            : RAG_INDEX_ERROR_MESSAGES[code] ?? (message || 'Dịch vụ AI RAG xử lý thất bại. Vui lòng thử lại.');
      throw new RagServiceError(
        safeMessage,
        response.statusCode >= 500 ? 503 : response.statusCode,
        code,
        readSafeUsage(detailRecord?.usage),
        detailRecord,
      );
    }
    return response.payload as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isRagRequestTimeout(error)) {
      throw new AppError('Dịch vụ AI RAG phản hồi quá lâu. Vui lòng thử lại sau.', 504, 'AI_RAG_SERVICE_TIMEOUT');
    }
    throw new AppError('Không kết nối được dịch vụ AI RAG.', 503, 'AI_RAG_SERVICE_UNAVAILABLE');
  }
}
