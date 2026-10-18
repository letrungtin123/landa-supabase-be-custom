import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRagHmacHeaders } from './ai-rag-client.service.js';

const vector = {
  keyId: 'kid1',
  secret: 'test-secret-0123456789',
  timestamp: '1791417600',
  method: 'POST',
  path: '/v1/lesson-author/orchestration-v2/unit',
  requestBody: '{"hello":"xin chào","count":2}',
  requestId: 'cb7785da-c8b4-4d5b-a02f-30b17e074ccc',
};

test('HMAC signer matches the Python cross-language vector', () => {
  assert.deepEqual(buildRagHmacHeaders(vector), {
    'X-Landa-Key-Id': 'kid1',
    'X-Landa-Timestamp': '1791417600',
    'X-Landa-Signature': '6b211dacc5906ae64263200f3777a8f22c0839486b50f2c6297a73845fff8e1d',
    'X-Landa-Request-Id': 'cb7785da-c8b4-4d5b-a02f-30b17e074ccc',
  });
});

test('HMAC signer binds the exact request body and path', () => {
  const baseline = buildRagHmacHeaders(vector)['X-Landa-Signature'];
  const changedBody = buildRagHmacHeaders({ ...vector, requestBody: '{"hello":"altered"}' })[
    'X-Landa-Signature'
  ];
  const changedPath = buildRagHmacHeaders({ ...vector, path: '/v1/chat' })['X-Landa-Signature'];
  assert.notEqual(changedBody, baseline);
  assert.notEqual(changedPath, baseline);
});

test('HMAC headers are omitted unless the key pair is complete', () => {
  assert.deepEqual(buildRagHmacHeaders({ ...vector, secret: '' }), {});
  assert.deepEqual(buildRagHmacHeaders({ ...vector, keyId: '' }), {});
});
