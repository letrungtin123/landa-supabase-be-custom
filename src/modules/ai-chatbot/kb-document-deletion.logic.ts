import { AppError } from '../../middleware/error-handler.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../tenants/tenant-data-quota.constants.js';

export type KbDocumentDeletionFailure = {
  statusCode: number;
  code: string;
  message: string;
};

type ErrorWithCode = Error & { code?: unknown };

/** Keeps database diagnostics server-side while the UI receives a stable error contract. */
export function describeKbDocumentDeletionFailure(error: unknown): KbDocumentDeletionFailure {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code || 'KB_DOCUMENT_DELETE_REJECTED',
      message: error.message,
    };
  }

  const code = typeof (error as ErrorWithCode | null)?.code === 'string'
    ? (error as ErrorWithCode).code
    : null;
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) {
    return { statusCode: 409, code: TENANT_DATA_LIMIT_REACHED_CODE, message: TENANT_DATA_LIMIT_REACHED_MESSAGE };
  }
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) {
    return { statusCode: 503, code: TENANT_DATA_QUOTA_RECONCILING_CODE, message: TENANT_DATA_QUOTA_RECONCILING_MESSAGE };
  }
  if (code === '23503' || code === '23505' || code === '40001' || code === '40P01') {
    return {
      statusCode: 409,
      code: 'KB_DOCUMENT_DELETE_CONFLICT',
      message: 'Tài liệu đang được thay đổi bởi một tác vụ khác. Vui lòng tải lại và thử lại.',
    };
  }

  return {
    statusCode: 500,
    code: 'KB_DOCUMENT_DELETE_FAILED',
    message: 'Không thể xóa tài liệu lúc này. Vui lòng thử lại sau.',
  };
}
