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
  structure_source?: string | null;
  structure_confidence?: number | null;
  structure_node_count?: number;
  source_structure_warnings?: string[];
  known_source_ref_count?: number;
  covered_source_ref_count?: number;
  source_coverage_ratio?: number | null;
  target_source_scope_count?: number;
  target_source_scope_chunk_count?: number;
  target_source_scope_candidate_count?: number;
  target_source_scope_hard_locked?: boolean;
  target_source_scope_pages?: number[];
  target_source_scope_expected_pages?: number[];
  target_source_scope_missing_pages?: number[];
  target_source_scope_truncated?: boolean;
  out_of_scope_retrieval_count?: number;
  source_coverage_required_count?: number;
  source_coverage_covered_count?: number;
  source_coverage_missing_fact_ids?: string[];
  source_coverage_status?: 'complete' | 'incomplete' | 'not_applicable';
  retrieval_candidate_count?: number;
  context_chars?: number;
  context_truncated?: boolean;
  omitted_retrieved_count?: number;
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
  operation?: 'answer' | 'course_blueprint' | 'create' | 'rename' | 'update_content' | 'delete' | 'move' | 'clarify';
  target_type?: 'course' | 'chapter' | 'lesson' | 'unit' | 'component' | null;
  generation_mode?: 'auto' | 'staged' | 'single';
  max_attempts?: number;
  blueprint_architecture?: {
    chapter_title: string;
    source_refs?: string[];
    lessons: Array<{
      title: string;
      source_refs?: string[];
      units: Array<{
        title: string;
        source_refs?: string[];
        source_fact_ids?: string[];
        component_plan: Array<{
          type: string;
          title: string;
          rationale: string;
        }>;
      }>;
    }>;
  };
}

export interface RagLessonAuthorBlueprintRequest extends RagChatRequest {
  outline_context: string;
  blueprint_schema_hint: string;
  max_attempts?: number;
}

export interface RagLessonAuthorResponse {
  proposal: unknown;
  usage?: Partial<AiUsage>;
  sources?: Array<Record<string, unknown>>;
  retrieval?: RagRetrievalDiagnostics;
}

export interface RagLessonAuthorBlueprintResponse {
  blueprint: unknown;
  usage?: Partial<AiUsage>;
  sources?: Array<Record<string, unknown>>;
  retrieval?: RagRetrievalDiagnostics;
}

export interface RagIndexResponse {
  status: 'learned' | 'error';
  chunk_count: number;
  diagnostics?: Record<string, unknown>;
  usage?: Partial<AiUsage>;
  error_reason?: string;
}

export class RagServiceError extends AppError {
  public readonly usage?: Partial<AiUsage>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    usage?: Partial<AiUsage>,
  ) {
    super(message, statusCode, code);
    this.name = 'RagServiceError';
    this.usage = usage;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSafeUsage(value: unknown): Partial<AiUsage> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const usage: Partial<AiUsage> = {};
  for (const field of ['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens'] as const) {
    const candidate = raw[field];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      usage[field] = Math.floor(candidate);
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

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
      const payloadRecord = asRecord(payload);
      const detail = payloadRecord ? payloadRecord.detail : null;
      const detailRecord = asRecord(detail);
      const message = detailRecord && typeof detailRecord.message === 'string'
        ? detailRecord.message.trim()
        : typeof detail === 'string'
          ? detail.trim()
          : '';
      const code = readSafeRagErrorCode(detailRecord?.code) ?? 'AI_RAG_SERVICE_ERROR';
      throw new RagServiceError(
        message || 'Dịch vụ AI RAG xử lý thất bại. Vui lòng thử lại.',
        response.statusCode >= 500 ? 503 : response.statusCode,
        code,
        readSafeUsage(detailRecord?.usage),
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

export async function generateRagLessonAuthorBlueprint(
  request: RagLessonAuthorBlueprintRequest,
): Promise<RagLessonAuthorBlueprintResponse> {
  const apiKey = await getGoogleAiStudioApiKey(request.tenant_id);
  return postRagJson<RagLessonAuthorBlueprintResponse>('/v1/lesson-author/blueprint', {
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
