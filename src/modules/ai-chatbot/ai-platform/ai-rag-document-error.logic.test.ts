import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RAG_DOCUMENT_ERROR_TEXT,
  ragDocumentErrorReasonFor,
  ragDocumentErrorStoredText,
  type RagDocumentErrorCode,
} from './ai-rag-document-error.logic.js';

const LIMIT_VI = RAG_DOCUMENT_ERROR_TEXT.DOCUMENT_LIMIT_EXCEEDED[0];
const LIMIT_EN = RAG_DOCUMENT_ERROR_TEXT.DOCUMENT_LIMIT_EXCEEDED[1];
// What releases before the security review 2026-10-24 (L-6) stored for DOCUMENT_LIMIT_EXCEEDED.
const EARLIER_LIMIT_VI = 'Tài liệu vượt giới hạn xử lý an toàn. Vui lòng giảm dung lượng hoặc độ dài tài liệu.';

test('every text is plain Vietnamese and English words, without codes or jargon', () => {
  for (const [code, texts] of Object.entries(RAG_DOCUMENT_ERROR_TEXT)) {
    assert.equal(texts.length, 2, code);
    for (const text of texts) {
      assert.ok(text.trim().length > 20, `${code}: ${text}`);
      assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+|\b\d{3}\b|\b(?:KB|RAG|OOXML|XML|MB|limit exceeded)\b/,
        `${code}: ${text}`);
    }
    assert.notEqual(texts[0], texts[1], code);
  }
});

test('a document over the AI limit tells the person to split it into smaller files', () => {
  assert.match(LIMIT_VI, /chia tài liệu thành nhiều tệp nhỏ hơn/);
  assert.match(LIMIT_EN, /[Ss]plit it into several smaller files/);
  assert.equal(ragDocumentErrorStoredText('DOCUMENT_LIMIT_EXCEEDED'), LIMIT_VI, 'the worker stores Vietnamese');
});

test('a stored text is given back in the request language, the earlier wording included', () => {
  for (const stored of [LIMIT_VI, LIMIT_EN, EARLIER_LIMIT_VI, `  ${LIMIT_VI}  `]) {
    assert.equal(ragDocumentErrorReasonFor(stored, 'vi'), LIMIT_VI, stored);
    assert.equal(ragDocumentErrorReasonFor(stored, 'en'), LIMIT_EN, stored);
  }
});

test('any other stored text and an empty reason are returned as they are', () => {
  for (const stored of ['Không tìm thấy tệp nguồn của tài liệu trong kho lưu trữ.', 'Gemini API key changed.', '']) {
    assert.equal(ragDocumentErrorReasonFor(stored, 'en'), stored);
    assert.equal(ragDocumentErrorReasonFor(stored, 'vi'), stored);
  }
  assert.equal(ragDocumentErrorReasonFor(null, 'en'), null);
});

test('the codes are the AI service ones', () => {
  const codes: RagDocumentErrorCode[] = ['DOCUMENT_LIMIT_EXCEEDED'];
  assert.deepEqual(Object.keys(RAG_DOCUMENT_ERROR_TEXT), codes);
});
