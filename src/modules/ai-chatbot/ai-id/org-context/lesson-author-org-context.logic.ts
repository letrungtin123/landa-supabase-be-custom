// Pure rules of the AI ID organization context (ORG_CONTEXT_SPEC §3): the feature gate, readiness,
// the document view, the unread count, what a profile save does, the drafting worker's retry rule
// and its AI points estimate.

import { LESSON_AUTHOR_CONTEXT_KB_TARGET } from '../../chat/chat.constants.js';
import { orgContextProfileHash, type OrgContextProfileV1 } from '../contracts/lesson-author-org-context.contract.js';

/** Name of the hidden per-tenant knowledge base of the context files. */
export const ORG_CONTEXT_KB_NAME = 'AI ID – Ngữ cảnh doanh nghiệp';
export const ORG_CONTEXT_KB_DESCRIPTION = 'Tài liệu ngữ cảnh doanh nghiệp của AI ID (không hiện trong Kho tri thức).';
/** `tenant_kb_assignments.target` of the context knowledge base (one per tenant). */
export const ORG_CONTEXT_KB_TARGET = LESSON_AUTHOR_CONTEXT_KB_TARGET;
/** Per-tenant transaction lock of the 50 MB check (pg_advisory_xact_lock(hashtext(key))). */
export const orgContextUsageLockKey = (tenantId: string) => `lesson_author_org_context:${tenantId}`;
/** History rows the state shows (newest first). */
export const ORG_CONTEXT_HISTORY_LIMIT = 20;
/** Documents the state lists (newest first). */
export const ORG_CONTEXT_DOCUMENT_LIST_LIMIT = 500;
/** Learned documents one profile draft reads (the AI route accepts 1..50). */
export const ORG_CONTEXT_DISTILL_MAX_DOCUMENTS = 50;
/** A failed draft is retried once (attempts counts claims, so the second failure is final). */
export const ORG_CONTEXT_DISTILL_MAX_ATTEMPTS = 2;
/** The lease of a running draft outlasts its AI call by this much. */
export const ORG_CONTEXT_DISTILL_LEASE_MARGIN_MS = 60_000;
/** Output tokens one draft may use (map notes and the final profile, every provider call together). */
export const ORG_CONTEXT_DISTILL_OUTPUT_TOKENS = 65_536;
/** Input tokens the prompts add to the source text (instructions of every map and reduce call). */
export const ORG_CONTEXT_DISTILL_PROMPT_TOKENS = 20_000;

export type OrgContextNotReadyReason = 'schema' | 'engine' | 'not_deployed' | 'provider_key';
export type OrgContextDistillStatus = 'idle' | 'queued' | 'running' | 'failed';
export type OrgContextProfileOrigin = 'ai_draft' | 'author_edit' | 'restore';
export type OrgContextDocumentStatus = 'learning' | 'learned' | 'error';

/** `LESSON_AUTHOR_ORG_CONTEXT_ENABLED` + `_TENANT_ALLOWLIST` (empty = every tenant). */
export function orgContextEnabledFor(tenantId: string, settings: { enabled: boolean; tenant_allowlist: readonly string[] }): boolean {
  if (!settings.enabled) return false;
  const tenant = tenantId.trim().toLowerCase();
  return !settings.tenant_allowlist.length
    || settings.tenant_allowlist.some(candidate => candidate.trim().toLowerCase() === tenant);
}

/** The first reason the feature cannot run for the tenant, or null (schema, engine, deployment, key). */
export function orgContextNotReadyReason(facts: {
  schema: boolean; engine: string | null; deployed: boolean; providerKey: boolean;
}): OrgContextNotReadyReason | null {
  if (!facts.schema) return 'schema';
  if (facts.engine !== 'self_built_rag') return 'engine';
  if (!facts.deployed) return 'not_deployed';
  if (!facts.providerKey) return 'provider_key';
  return null;
}

/** kb_documents.status as the context tab shows it (queued, pending and draft documents are still being read). */
export function orgContextDocumentStatus(status: string): OrgContextDocumentStatus {
  if (status === 'learned') return 'learned';
  if (status === 'error') return 'error';
  return 'learning';
}

/** Whether `used + adding` stays within the limit (exactly the limit is allowed). */
export function orgContextFitsLimit(usedBytes: number, addingBytes: number, limitBytes: number): boolean {
  return usedBytes + addingBytes <= limitBytes;
}

export type OrgContextSaveDecision =
  | { kind: 'unchanged' }
  | { kind: 'confirm_current' }
  | { kind: 'new_version'; confirm: boolean };

/**
 * PUT /profile: canonical-equal to the current version → no new version (only a confirm when asked and
 * the current version is not the confirmed one yet); otherwise a new author_edit version, confirmed
 * when asked.
 */
export function decideOrgContextSave(input: {
  current: { version: number; profile_hash: string } | null;
  confirmedVersion: number | null;
  profile: OrgContextProfileV1;
  confirm: boolean;
}): OrgContextSaveDecision {
  if (input.current && input.current.profile_hash === orgContextProfileHash(input.profile)) {
    return input.confirm && input.confirmedVersion !== input.current.version ? { kind: 'confirm_current' }
      : { kind: 'unchanged' };
  }
  return { kind: 'new_version', confirm: input.confirm };
}

/** Error codes of a failed draft that a second try cannot fix. */
const NON_RETRYABLE_DISTILL_CODES = new Set([
  'ORG_CONTEXT_NO_LEARNED_SOURCE',
  'ORG_CONTEXT_NO_LEARNED_DOCUMENTS',
  'ORG_CONTEXT_DISTILL_RESPONSE_INVALID',
  'ORG_CONTEXT_NOT_READY',
  'AI_CREDIT_LIMIT_REACHED',
  'AI_PROVIDER_KEY_MISSING',
  'AI_PROVIDER_AUTH_REJECTED',
  'AI_PROVIDER_REQUEST_REJECTED',
  'REQUEST_TOO_LARGE',
  'REQUEST_VALIDATION_FAILED',
  'AI_RAG_SERVICE_NOT_CONFIGURED',
  'AI_RAG_SERVICE_HMAC_NOT_CONFIGURED',
  'AI_RAG_SERVICE_AUTH_NOT_CONFIGURED',
]);

/** The code a failure is stored with (varchar(64), upper snake case), or a generic one. */
export function orgContextDistillErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ORG_CONTEXT_DISTILL_FAILED';
}

/** After a failed attempt: failed for good (non-retryable code or attempts used up), or queued again. */
export function orgContextDistillFailureStatus(code: string, attempts: number): 'failed' | 'queued' {
  return NON_RETRYABLE_DISTILL_CODES.has(code) || attempts >= ORG_CONTEXT_DISTILL_MAX_ATTEMPTS ? 'failed' : 'queued';
}

/**
 * The AI points a draft holds before its call: the source text it can read (bytes of the files, at most
 * the source character cap; about 3 characters a token like every other estimate) plus the prompts,
 * and the output allowance. The call is settled with the usage the AI service reports.
 */
export function orgContextDistillTokenEstimate(sourceBytes: number, maxSourceChars: number): {
  inputTokens: number; outputTokens: number;
} {
  const chars = Math.max(0, Math.min(Math.floor(sourceBytes), maxSourceChars));
  return { inputTokens: Math.ceil(chars / 3) + ORG_CONTEXT_DISTILL_PROMPT_TOKENS, outputTokens: ORG_CONTEXT_DISTILL_OUTPUT_TOKENS };
}

/** Domain error of the org-context routes; the controller maps the code to its status and message. */
export type OrgContextErrorCode =
  | 'ORG_CONTEXT_DISABLED'
  | 'ORG_CONTEXT_FILE_INVALID'
  | 'ORG_CONTEXT_LIMIT_REACHED'
  | 'ORG_CONTEXT_NOT_DEPLOYED'
  | 'ORG_CONTEXT_NOT_READY'
  | 'ORG_CONTEXT_REVISION_CONFLICT'
  | 'ORG_CONTEXT_NO_LEARNED_DOCUMENTS'
  | 'ORG_CONTEXT_DISTILL_RUNNING'
  | 'ORG_CONTEXT_PROFILE_INVALID'
  | 'ORG_CONTEXT_VERSION_NOT_FOUND'
  | 'ORG_CONTEXT_DOCUMENT_NOT_FOUND'
  | 'ORG_CONTEXT_INPUT_INVALID'
  | 'KB_DOCUMENT_LEARNING'
  | 'TENANT_DATA_LIMIT_REACHED'
  | 'AI_CREDIT_LIMIT_REACHED'
  | 'ORG_CONTEXT_UNAVAILABLE';

export class OrgContextError extends Error {
  constructor(readonly code: OrgContextErrorCode, readonly details?: Record<string, unknown>,
    readonly variant?: 'required' | 'type' | 'too_large') {
    super(code);
    this.name = 'OrgContextError';
  }
}
