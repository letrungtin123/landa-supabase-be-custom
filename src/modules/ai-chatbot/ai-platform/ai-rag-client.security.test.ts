import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { buildRagHmacHeaders } from './ai-rag-client.service.js';

// The test vector of the HMAC v2 spec, shared with the AI service's own test (security audit 2026-10-24, M1).
const vector = {
  keyId: 'k1',
  secret: 'test-secret-0123456789abcdef0123456789abcdef',
  timestamp: '1792900000',
  method: 'POST',
  path: '/v1/chat',
  requestBody: '{"tenant_id":"t-1","question":"Xin chào"}',
  requestId: '2b7e1516-28ae-4d2a-8b0f-6c1e9f1a2b3c',
};
const V1_SIGNATURE = 'fad90ac1c9b5c73e6c4cc02e07df41d1341b21f69e75a2a96e71838aa7b26822';

test('HMAC signer reproduces the v2 test vector of the shared spec', () => {
  assert.equal(createHash('sha256').update(vector.requestBody, 'utf8').digest('hex'),
    '49afe22aa1e95b79611ccaabc43cd20dbac65675b714b31269d111a496f4b9a3');
  assert.deepEqual(buildRagHmacHeaders(vector), {
    'X-Landa-Key-Id': 'k1',
    'X-Landa-Timestamp': '1792900000',
    'X-Landa-Signature': '7c7514c97b51daf6fe0991ba901a5289aaf0ade8a36f1063d9cd48f4a79c891d',
    'X-Landa-Signature-Version': '2',
    'X-Landa-Request-Id': '2b7e1516-28ae-4d2a-8b0f-6c1e9f1a2b3c',
  });
});

test('HMAC signer no longer sends the v1 signature', () => {
  const { timestamp, method, path, requestBody, secret } = vector;
  const bodyHash = createHash('sha256').update(requestBody, 'utf8').digest('hex');
  const v1 = createHmac('sha256', secret).update(`${timestamp}\n${method}\n${path}\n${bodyHash}`, 'utf8').digest('hex');
  assert.equal(v1, V1_SIGNATURE, 'the v1 value of the spec');
  assert.notEqual(buildRagHmacHeaders(vector)['X-Landa-Signature'], V1_SIGNATURE);
});

test('HMAC signer binds the request id and the key id (a replay under a fresh request id fails)', () => {
  const baseline = buildRagHmacHeaders(vector)['X-Landa-Signature'];
  const freshRequestId = buildRagHmacHeaders({ ...vector, requestId: '3c8f2627-39bf-4e3b-9c1f-7d2fa02b3c4d' })[
    'X-Landa-Signature'
  ];
  const otherKeyId = buildRagHmacHeaders({ ...vector, keyId: 'k2' })['X-Landa-Signature'];
  assert.notEqual(freshRequestId, baseline);
  assert.notEqual(otherKeyId, baseline);
});

test('HMAC signer binds the exact request body, path, method and timestamp', () => {
  const baseline = buildRagHmacHeaders(vector)['X-Landa-Signature'];
  for (const changed of [
    { requestBody: '{"tenant_id":"t-1","question":"Xin chao"}' },
    { path: '/v1/kb/delete' },
    { method: 'GET' },
    { timestamp: '1792900001' },
  ]) {
    assert.notEqual(buildRagHmacHeaders({ ...vector, ...changed })['X-Landa-Signature'], baseline,
      JSON.stringify(changed));
  }
  // The method is signed upper-case, whatever case the caller passes.
  assert.equal(buildRagHmacHeaders({ ...vector, method: 'post' })['X-Landa-Signature'], baseline);
});

test('HMAC headers are omitted unless the key pair is complete', () => {
  assert.deepEqual(buildRagHmacHeaders({ ...vector, secret: '' }), {});
  assert.deepEqual(buildRagHmacHeaders({ ...vector, keyId: '' }), {});
});
