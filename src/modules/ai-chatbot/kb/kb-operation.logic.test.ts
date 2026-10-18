import assert from 'node:assert/strict';
import test from 'node:test';
import {
  kbOperationIndexEngine,
  shouldMarkKbDocumentErrorOnTerminalFailure,
} from './kb-operation.service.js';

test('document_reindex always targets self-built RAG without changing the tenant active engine', () => {
  assert.equal(kbOperationIndexEngine('document_reindex', 'gemini_file_search'), 'self_built_rag');
  assert.equal(kbOperationIndexEngine('document_reindex', 'self_built_rag'), 'self_built_rag');
  assert.equal(kbOperationIndexEngine('document_upload', 'gemini_file_search'), 'gemini_file_search');
});

test('a failed zero-downtime reindex never marks the still-usable KB document as error', () => {
  assert.equal(shouldMarkKbDocumentErrorOnTerminalFailure('document_reindex'), false);
  assert.equal(shouldMarkKbDocumentErrorOnTerminalFailure('document_upload'), true);
  assert.equal(shouldMarkKbDocumentErrorOnTerminalFailure('document_reupload'), true);
});
