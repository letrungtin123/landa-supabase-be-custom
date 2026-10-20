// The AI credit reservation of a KB index request: an unchanged index kept by the AI service (no
// provider call) releases it; every other learned answer is charged with the usage it reports.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRagIndexRequestBody,
  ragIndexKeptUnchangedIndex,
  settleRagIndexReservation,
  type RagIndexResponse,
} from './ai-rag-client.service.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, totalTokens: 0 };
const learned: RagIndexResponse = {
  status: 'learned',
  chunk_count: 3,
  usage: { inputTokens: 0, outputTokens: 0, embeddingTokens: 21, totalTokens: 21 },
};
const skipped: RagIndexResponse = {
  status: 'learned',
  chunk_count: 3,
  usage: ZERO_USAGE,
  skipped: true,
  skip_reason: 'INDEX_UNCHANGED',
};

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    settle: {
      finalize: async () => {
        calls.push('finalize');
      },
      release: async () => {
        calls.push('release');
      },
    },
  };
}

test('a kept unchanged index releases the reservation and is never charged', async () => {
  const { calls, settle } = recorder();
  assert.equal(await settleRagIndexReservation(skipped, settle), 'released');
  assert.deepEqual(calls, ['release']);
});

test('a rebuilt index is charged with the usage the AI service reported', async () => {
  const { calls, settle } = recorder();
  assert.equal(await settleRagIndexReservation(learned, settle), 'finalized');
  assert.deepEqual(calls, ['finalize']);
});

test('only a learned, skipped answer with zero usage counts as kept', () => {
  assert.equal(ragIndexKeptUnchangedIndex(skipped), true);
  assert.equal(ragIndexKeptUnchangedIndex({ ...skipped, usage: undefined }), true);
  assert.equal(ragIndexKeptUnchangedIndex(learned), false);
  assert.equal(ragIndexKeptUnchangedIndex({ ...learned, skipped: false }), false);
  // A skipped answer that reports usage is charged: the reported usage wins over the flag.
  assert.equal(ragIndexKeptUnchangedIndex({ ...skipped, usage: { ...ZERO_USAGE, embeddingTokens: 5 } }), false);
  assert.equal(ragIndexKeptUnchangedIndex({ ...skipped, usage: { ...ZERO_USAGE, cachedInputTokens: 1 } }), false);
  assert.equal(ragIndexKeptUnchangedIndex({ ...skipped, status: 'error', error_reason: 'INDEX_DOCUMENT_FAILED' }),
    false);
});

test('a failed settlement propagates, so the worker retries the operation', async () => {
  await assert.rejects(
    settleRagIndexReservation(skipped, {
      finalize: async () => assert.fail('a kept index is never charged'),
      release: async () => {
        throw new Error('connection reset');
      },
    }),
    /connection reset/,
  );
});

test('the index request asks for a rebuild only when forced', () => {
  const input = { tenantId: 't', kbId: 'k', documentId: 'd', embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: 768 };
  assert.equal('force' in buildRagIndexRequestBody(input, 'key'), false);
  assert.equal('force' in buildRagIndexRequestBody({ ...input, force: false }, 'key'), false);
  assert.deepEqual(buildRagIndexRequestBody({ ...input, force: true }, 'key'), {
    api_key: 'key', tenant_id: 't', kb_id: 'k', document_id: 'd', embedding_model: 'gemini-embedding-001',
    embedding_dimensions: 768, force: true,
  });
});
