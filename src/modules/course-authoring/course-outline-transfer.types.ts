// ═══════════════════════════════════════════════════════════════
// Course outline transfer types: the job, asset and payload rows and the
// API shapes. Moved unchanged from course-outline-transfer.service.ts, which
// still re-exports the API types.
// ═══════════════════════════════════════════════════════════════

export type CourseOutlineTransferOperation = 'duplicate' | 'move';
export type CourseOutlineTransferStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type CourseOutlineTransferDestinationLevel = 'chapter' | 'sequential' | 'vertical' | 'complete';

type TransferableBlockType = 'chapter' | 'sequential' | 'vertical' | 'component';

export interface CourseRow {
  id: string;
  display_name: string;
  tenant_id: string;
  deleted_at: Date | null;
}

export interface BlockRow {
  id: string;
  course_id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  updated_at: Date;
  deleted_at: Date | null;
  delete_status: string | null;
}

export interface TransferJobRow {
  id: string;
  tenant_id: string;
  source_course_id: string;
  source_block_id: string;
  destination_course_id: string;
  destination_parent_id: string;
  operation: CourseOutlineTransferOperation;
  requested_by: string;
  requested_username: string | null;
  requested_ip: string | null;
  source_block_name: string;
  source_block_type: string;
  source_root_updated_at: Date;
  destination_parent_updated_at: Date;
  status: CourseOutlineTransferStatus;
  attempts: number;
  max_attempts: number;
  asset_count: number;
  block_count: number;
  lease_token: string | null;
}

export interface TransferAssetRow {
  id: string;
  job_id: string;
  tenant_id: string;
  source_asset_id: string;
  source_storage_path: string;
  target_storage_path: string;
  display_name: string;
  content_type: string | null;
  file_size: string | number | null;
  source_url: string | null;
  target_url: string | null;
  status: 'queued' | 'copied';
}

export interface PayloadRow {
  id: string;
  data: unknown;
  metadata: unknown;
  published_data: unknown;
  published_metadata: unknown;
}

export interface CourseOutlineTransferJob {
  id: string;
  operation: CourseOutlineTransferOperation;
  status: CourseOutlineTransferStatus;
  source_course_id: string;
  source_block_id: string;
  destination_course_id: string;
  destination_parent_id: string;
  source_block_name: string;
  source_block_type: string;
  attempts: number;
  max_attempts: number;
  block_count: number;
  asset_count: number;
  total_asset_bytes: string;
  copied_asset_bytes: string;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  next_attempt_at: string;
  completed_at: string | null;
}

export interface CourseOutlineTransferDestinationOptions {
  source_block_type: string;
  next_level: CourseOutlineTransferDestinationLevel;
  options: Array<{ id: string; display_name: string; block_type: string }>;
  has_more: boolean;
  next_cursor: string | null;
}
