import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOrchestrationV2UnitRequestBudgets } from './ai-rag-client.service.js';
import { normalizeKbDocumentDisplayName } from './kb.validator.js';

test('KB document display names cannot carry filesystem traversal syntax', () => {
  assert.equal(normalizeKbDocumentDisplayName('../../x.py'), 'x.py');
  assert.equal(normalizeKbDocumentDisplayName('C:/x/y.py'), 'y.py');
  assert.equal(normalizeKbDocumentDisplayName('/abs/x'), 'x');
  assert.equal(normalizeKbDocumentDisplayName("folder\\secret\u0000.pdf"), 'secret.pdf');
});

test('unit transport headroom remains separate from the workflow budget sent in the body', () => {
  assert.deepEqual(resolveOrchestrationV2UnitRequestBudgets(45_000, 55_000), {
    remainingWorkflowBudgetMs: 45_000,
    transportTimeoutMs: 55_000,
  });
});
