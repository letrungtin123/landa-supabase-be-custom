import { AppError } from '../../../middleware/error-handler.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../../tenants/tenant-data-quota.constants.js';

export type KbDocumentDeletionFailure = {
  statusCode: number;
  code: string;
  message: string;
  /** KB_DOCUMENT_IN_USE_BY_AI_ID: the refused documents (sent as `document_ids`). */
  documentIds?: string[];
};

type ErrorWithCode = Error & { code?: unknown };

export const KB_DOCUMENT_IN_USE_BY_AI_ID_CODE = 'KB_DOCUMENT_IN_USE_BY_AI_ID';
/** Names listed in the refusal; the rest are counted. */
const IN_USE_NAMES_SHOWN = 5;

function inUseMessage(documents: ReadonlyArray<{ name: string }>, locale: 'vi' | 'en'): string {
  const shown = documents.slice(0, IN_USE_NAMES_SHOWN).map(document => `“${document.name}”`);
  const more = documents.length - shown.length;
  if (locale === 'en') {
    const list = shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
    return documents.length > 1
      ? `AI ID is designing a course from these documents, so they cannot be deleted yet: ${list}. Please try again when AI ID has finished.`
      : `AI ID is designing a course from this document, so it cannot be deleted yet: ${list}. Please try again when AI ID has finished.`;
  }
  const list = shown.join(', ') + (more > 0 ? ` và ${more} tài liệu khác` : '');
  return documents.length > 1
    ? `AI ID đang dùng các tài liệu này để soạn khoá học nên chưa xoá được: ${list}. Vui lòng thử lại khi AI ID soạn xong.`
    : `AI ID đang dùng tài liệu này để soạn khoá học nên chưa xoá được: ${list}. Vui lòng thử lại khi AI ID soạn xong.`;
}

/**
 * A deletion refused because AI ID is still designing a course from the documents (a source of a
 * workspace whose V2 run is active). A bulk deletion is refused as a whole: nothing is deleted.
 */
export class KbDocumentInUseByAiIdError extends AppError {
  constructor(readonly documents: ReadonlyArray<{ document_id: string; name: string }>) {
    super(inUseMessage(documents, 'vi'), 409, KB_DOCUMENT_IN_USE_BY_AI_ID_CODE);
    this.name = 'KbDocumentInUseByAiIdError';
  }

  localized(locale: 'vi' | 'en'): string {
    return inUseMessage(this.documents, locale);
  }
}

export const KB_IN_USE_BY_AI_ID_CODE = 'KB_IN_USE_BY_AI_ID';

/** DELETE /kb/:id refused: an active AI ID run still designs a course from documents of this knowledge base. */
export class KbInUseByAiIdError extends AppError {
  constructor() {
    super(KbInUseByAiIdError.text('vi'), 409, KB_IN_USE_BY_AI_ID_CODE);
    this.name = 'KbInUseByAiIdError';
  }

  static text(locale: 'vi' | 'en'): string {
    return locale === 'en'
      ? 'AI ID is designing a course from documents of this knowledge base, so it cannot be deleted yet. '
        + 'Please try again when AI ID has finished.'
      : 'AI ID đang dùng tài liệu của Kho tri thức này để soạn khoá học nên chưa xoá được. '
        + 'Vui lòng thử lại khi AI ID soạn xong.';
  }

  localized(locale: 'vi' | 'en'): string {
    return KbInUseByAiIdError.text(locale);
  }
}

/** Keeps database diagnostics server-side while the UI receives a stable error contract. */
export function describeKbDocumentDeletionFailure(error: unknown, locale: 'vi' | 'en' = 'vi'): KbDocumentDeletionFailure {
  if (error instanceof KbDocumentInUseByAiIdError) {
    return {
      statusCode: 409,
      code: KB_DOCUMENT_IN_USE_BY_AI_ID_CODE,
      message: error.localized(locale),
      documentIds: error.documents.map(document => document.document_id),
    };
  }
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
