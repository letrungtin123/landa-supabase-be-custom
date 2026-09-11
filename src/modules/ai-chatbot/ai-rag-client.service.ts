import http from 'node:http';
import https from 'node:https';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import type { AiChatTarget, AiUsage } from './ai-engine.types.js';
import { getGoogleAiStudioApiKey } from './ai-settings.service.js';

export interface RagChatMessage {
  role: 'user' | 'assistant' | 'model';
  content: string;
}

export interface RagSourceDocument {
  document_id: string;
  kb_id: string;
  name: string;
  type: string;
  status: string;
}

export interface RagChatRequest {
  tenant_id: string;
  kb_id: string | null;
  conversation_id: string;
  target: AiChatTarget;
  model: string;
  max_output_tokens: number;
  embedding_model: string;
  embedding_dimensions: number;
  system_prompt: string;
  user_message: string;
  history: RagChatMessage[];
  source_documents?: RagSourceDocument[];
  course_context?: string | null;
  locale?: 'vi' | 'en';
}

export interface RagRetrievalDiagnostics {
  kb_id: string | null;
  source_document_count: number;
  retrieved_count: number;
  returned_source_count: number;
  top_score: number | null;
  top_document_name: string | null;
  methods: string[];
  top_k: number;
  max_context_chars: number;
  min_score?: number;
  keyword_min_score?: number;
  max_chunks_per_document?: number;
  reason: string | null;
}

export interface RagChatResponse {
  text: string;
  usage?: Partial<AiUsage>;
  sources?: Array<Record<string, unknown>>;
  retrieval?: RagRetrievalDiagnostics;
}

export interface RagLessonAuthorRequest extends RagChatRequest {
  outline_context: string;
  target_scope_instruction: string;
  output_schema_hint: string;
}

export interface RagLessonAuthorResponse {
  proposal: unknown;
  usage?: Partial<AiUsage>;
  sources?: Array<Record<string, unknown>>;
  retrieval?: RagRetrievalDiagnostics;
}

export interface RagIndexResponse {
  status: 'learned' | 'error';
  chunk_count: number;
  usage?: Partial<AiUsage>;
  error_reason?: string;
}

function requireRagServiceUrl(): string {
  const baseUrl = env.AI_RAG_SERVICE_URL.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new AppError('Dịch vụ AI RAG chưa được cấu hình trên máy chủ.', 503, 'AI_RAG_SERVICE_NOT_CONFIGURED');
  }
  if (env.isProduction && !getRagServiceToken()) {
    throw new AppError('Dịch vụ AI RAG thiếu token nội bộ trên máy chủ.', 503, 'AI_RAG_SERVICE_TOKEN_NOT_CONFIGURED');
  }
  return baseUrl;
}

function getRagServiceToken(): string {
  return env.AI_RAG_SERVICE_TOKEN;
}

function isRagRequestTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'AI_RAG_REQUEST_TIMEOUT';
}

async function requestRagJson(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ statusCode: number; payload: unknown }> {
  const requestBody = JSON.stringify(body);
  const url = new URL(`${requireRagServiceUrl()}${path}`);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody).toString(),
        ...(getRagServiceToken() ? { 'X-Landa-AI-Service-Token': getRagServiceToken() } : {}),
      },
      timeout: timeoutMs,
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
    req.write(requestBody);
    req.end();
  });
}

async function postRagJson<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = env.AI_RAG_REQUEST_TIMEOUT_MS,
): Promise<T> {
  try {
    const response = await requestRagJson(path, body, timeoutMs);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const { payload } = response;
      const message = payload && typeof payload === 'object' && 'detail' in payload
        ? String((payload as { detail?: unknown }).detail || '')
        : '';
      throw new AppError(
        message || 'Dịch vụ AI RAG xử lý thất bại. Vui lòng thử lại.',
        response.statusCode >= 500 ? 503 : response.statusCode,
        'AI_RAG_SERVICE_ERROR',
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

export async function sendRagChat(request: RagChatRequest): Promise<RagChatResponse> {
  const apiKey = await getGoogleAiStudioApiKey(request.tenant_id);
  return postRagJson<RagChatResponse>('/v1/chat', {
    ...request,
    api_key: apiKey,
  });
}

export async function generateRagLessonAuthorProposal(
  request: RagLessonAuthorRequest,
): Promise<RagLessonAuthorResponse> {
  const apiKey = await getGoogleAiStudioApiKey(request.tenant_id);
  return postRagJson<RagLessonAuthorResponse>('/v1/lesson-author/proposal', {
    ...request,
    api_key: apiKey,
  });
}

export async function indexRagDocument(input: {
  tenantId: string;
  kbId: string;
  documentId: string;
  embeddingModel: string;
  embeddingDimensions: number;
}): Promise<RagIndexResponse> {
  const apiKey = await getGoogleAiStudioApiKey(input.tenantId);
  return postRagJson<RagIndexResponse>('/v1/kb/documents/index', {
    api_key: apiKey,
    tenant_id: input.tenantId,
    kb_id: input.kbId,
    document_id: input.documentId,
    embedding_model: input.embeddingModel,
    embedding_dimensions: input.embeddingDimensions,
  }, env.AI_RAG_INDEX_REQUEST_TIMEOUT_MS);
}

export async function deleteRagDocument(input: {
  tenantId: string;
  kbId: string;
  documentId: string;
}): Promise<void> {
  await postRagJson<{ deleted: boolean }>('/v1/kb/documents/delete', {
    tenant_id: input.tenantId,
    kb_id: input.kbId,
    document_id: input.documentId,
  });
}

export async function deleteRagKnowledgebase(input: {
  tenantId: string;
  kbId: string;
}): Promise<void> {
  await postRagJson<{ deleted: boolean }>('/v1/kb/delete', {
    tenant_id: input.tenantId,
    kb_id: input.kbId,
  });
}
