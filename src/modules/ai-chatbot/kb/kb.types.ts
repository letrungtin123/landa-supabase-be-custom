// ═══════════════════════════════════════════════════════════════
// Knowledge base types: knowledge bases, documents and the restore results
// the KB services return. Moved unchanged from kb.service.ts, which still
// re-exports every exported one.
// ═══════════════════════════════════════════════════════════════

import type { AiEngine } from '../ai-platform/ai-engine.types.js';

export interface Knowledgebase {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  document_count?: number;
  restore_state?: KbRestoreState;
  active_restore_job_id?: string | null;
  restore_error_reason?: string | null;
  restore_started_at?: string | null;
  restore_finished_at?: string | null;
  restore_required?: boolean;
  restore_reason?: string | null;
  restore_progress?: KbRestoreProgress | null;
  ai_active_engine?: AiEngine;
  ai_transition_state?: KbAiTransitionState;
  ai_pending_engine?: AiEngine | null;
  ai_transition_progress?: KbAiTransitionProgress | null;
}

export type KbRestoreState = 'idle' | 'queued' | 'restoring' | 'uploading' | 'completed' | 'failed';
export type KbAiTransitionState = 'idle' | 'queued' | 'running' | 'failed';

export interface KbRestoreProgress {
  total_docs: number;
  enqueued_docs: number;
  learned_docs: number;
  failed_docs: number;
  skipped_docs: number;
}

export interface KbAiTransitionProgress {
  phase: string | null;
  total_documents: number;
  processed_documents: number;
  cleanup_processed_documents: number;
  last_error: string | null;
}

export interface KbDocument {
  id: string;
  tenant_id: string;
  kb_id: string;
  type: string;
  name: string;
  status: string;
  error_reason: string | null;
  source_info: Record<string, unknown>;
  file_path: string | null;
  content: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RestoreKnowledgebaseResult {
  restored: number;
  enqueued: number;
  failed_to_enqueue: number;
  skipped_no_file: number;
  deleted_stores: number;
  deleted_mappings: number;
  orphaned_stores: number;
  upload_publish_failed: boolean;
}

export interface EnqueueRestoreKnowledgebaseResult {
  queued: true;
  job_id: string;
  kb_id: string;
  lock_ttl_seconds: number;
}
