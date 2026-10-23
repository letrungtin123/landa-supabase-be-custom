// What a person reads for a document the AI service would not learn (kb_documents.error_reason), in the UI
// language. The KB operation worker stores the Vietnamese text (the default language, and what every other
// reader of the column shows); the knowledge base document list gives it back in the request language
// (X-UI-Locale). Plain words, no codes (UI copy rule). Any other stored text is returned as it is.

export type RagDocumentErrorLocale = 'vi' | 'en';

/** [Vietnamese, English] by AI service error code. */
export const RAG_DOCUMENT_ERROR_TEXT = Object.freeze({
  // A size, length, page or cell limit of the AI service (security review 2026-10-24, L-6). A small file can
  // hit it too (many pages or cells), so the advice is to split the document, not to make the file smaller.
  DOCUMENT_LIMIT_EXCEEDED: Object.freeze([
    'Tài liệu này quá lớn hoặc quá dài để AI học trong một lần. Hãy chia tài liệu thành nhiều tệp nhỏ hơn rồi tải lên lại.',
    'This document is too large or too long for the AI to learn in one go. Split it into several smaller files and upload them again.',
  ] as const),
});

export type RagDocumentErrorCode = keyof typeof RAG_DOCUMENT_ERROR_TEXT;

/** Texts stored by earlier releases, read as the code they were written for. */
const EARLIER_STORED_TEXT: ReadonlyMap<string, RagDocumentErrorCode> = new Map([
  ['Tài liệu vượt giới hạn xử lý an toàn. Vui lòng giảm dung lượng hoặc độ dài tài liệu.', 'DOCUMENT_LIMIT_EXCEEDED'],
]);

const STORED_TEXT: ReadonlyMap<string, RagDocumentErrorCode> = new Map([
  ...(Object.entries(RAG_DOCUMENT_ERROR_TEXT) as Array<[RagDocumentErrorCode, readonly [string, string]]>)
    .flatMap(([code, texts]) => texts.map(text => [text, code] as const)),
  ...EARLIER_STORED_TEXT,
]);

/** The Vietnamese text the worker stores for this AI service error code. */
export function ragDocumentErrorStoredText(code: RagDocumentErrorCode): string {
  return RAG_DOCUMENT_ERROR_TEXT[code][0];
}

/** A stored error_reason in the request language: known texts are translated, anything else is kept. */
export function ragDocumentErrorReasonFor(stored: string | null, locale: RagDocumentErrorLocale): string | null {
  if (stored === null) return null;
  const code = STORED_TEXT.get(stored.trim());
  if (!code) return stored;
  return RAG_DOCUMENT_ERROR_TEXT[code][locale === 'en' ? 1 : 0];
}
