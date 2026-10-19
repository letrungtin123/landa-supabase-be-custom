// Assignment rules without I/O: deadline and unlock modes, the deadline
// written on save, and the file and row shapes answered to clients. Moved
// unchanged from assignments.service.ts.

import { AppError } from '../../utils/errors.js';
import type { AssignmentFileMeta } from './assignments.types.js';

const DEADLINE_MODES = ['none', 'absolute', 'relative_to_enrollment'] as const;
const SUBMISSION_UNLOCK_MODES = ['after_content_complete', 'anytime'] as const;

type AssignmentDeadlineMode = typeof DEADLINE_MODES[number];
type AssignmentSubmissionUnlockMode = typeof SUBMISSION_UNLOCK_MODES[number];

export function fileDownloadUrl(id: string): string {
  return `/api/assignments/files/${id}`;
}

export function normalizeFiles(value: unknown): AssignmentFileMeta[] {
  if (!Array.isArray(value)) return [];
  return value.map((file: any) => ({
    id: String(file.id),
    original_name: String(file.original_name || file.originalName || 'file'),
    mime_type: String(file.mime_type || file.mimeType || 'application/octet-stream'),
    size_bytes: Number(file.size_bytes || file.size || 0),
    download_url: fileDownloadUrl(String(file.id)),
    created_at: file.created_at,
  }));
}

export function normalizeAttachmentFile(value: unknown): AssignmentFileMeta | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as Record<string, unknown>;
  const id = typeof file.id === 'string' ? file.id : '';
  if (!id) return null;
  return {
    id,
    original_name: String(file.original_name || file.originalName || 'file'),
    mime_type: String(file.mime_type || file.mimeType || 'application/octet-stream'),
    size_bytes: Number(file.size_bytes || file.size || 0),
    download_url: fileDownloadUrl(id),
    created_at: typeof file.created_at === 'string' ? file.created_at : undefined,
  };
}

export function attachmentStoragePath(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const storagePath = (value as Record<string, unknown>).storage_path;
  return typeof storagePath === 'string' && storagePath ? storagePath : null;
}

export function normalizeAssignmentRow<T extends Record<string, any>>(row: T): Omit<T, 'is_published'> & { attachment_file: AssignmentFileMeta | null } {
  const rest = { ...row };
  delete rest.is_published;
  return {
    ...rest,
    attachment_file: normalizeAttachmentFile(row.attachment_file),
  };
}

export function isDeadlineExpired(deadlineAt?: string | Date | null): boolean {
  if (!deadlineAt) return false;
  const deadlineTime = new Date(deadlineAt).getTime();
  return Number.isFinite(deadlineTime) && deadlineTime <= Date.now();
}

export function normalizeDeadlineMode(value: unknown, fallback: AssignmentDeadlineMode = 'none'): AssignmentDeadlineMode {
  return DEADLINE_MODES.includes(value as AssignmentDeadlineMode) ? value as AssignmentDeadlineMode : fallback;
}

export function normalizeSubmissionUnlockMode(value: unknown): AssignmentSubmissionUnlockMode {
  return SUBMISSION_UNLOCK_MODES.includes(value as AssignmentSubmissionUnlockMode)
    ? value as AssignmentSubmissionUnlockMode
    : 'after_content_complete';
}

export function normalizeDeadlineForWrite(input: {
  deadline_mode?: string;
  deadline_enabled?: boolean;
  deadline_at?: string | null;
  deadline_after_days?: number | null;
}) {
  if (input.deadline_at) {
    throw new AppError('Không còn hỗ trợ hạn cụ thể cho bài tập', 400);
  }
  if (input.deadline_mode === 'absolute') {
    throw new AppError('Không còn hỗ trợ hạn cụ thể cho bài tập', 400);
  }

  const mode = input.deadline_mode === 'none' || input.deadline_enabled === false
    ? 'none'
    : 'relative_to_enrollment';

  if (mode === 'none') {
    return {
      deadlineEnabled: false,
      deadlineMode: 'none' as const,
      deadlineAt: null,
      deadlineAfterDays: null,
    };
  }

  const afterDays = input.deadline_after_days || 7;
  if (!Number.isInteger(afterDays) || afterDays < 1 || afterDays > 3650) {
    throw new AppError('Vui lòng nhập số ngày từ 1 đến 3650', 400);
  }
  return {
    deadlineEnabled: true,
    deadlineMode: 'relative_to_enrollment' as const,
    deadlineAt: null,
    deadlineAfterDays: afterDays,
  };
}
