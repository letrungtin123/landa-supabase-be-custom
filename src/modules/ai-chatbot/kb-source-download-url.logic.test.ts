import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../middleware/error-handler.js';
import {
  assertKbSourcePathOwnedByTenant,
  rewriteSignedUrlOrigin,
  signKbDocumentSourceUrl,
} from './kb-source-download-url.logic.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const OBJECT = `${TENANT}/kb-files/20261008/1791417600_bao_cao.pdf`;
const SIGNED = `http://127.0.0.1:54321/storage/v1/object/sign/landa-storage/${OBJECT}?token=secret.jwt.token`;

test('source paths must belong to the tenant and cannot traverse', () => {
  assert.equal(assertKbSourcePathOwnedByTenant(OBJECT, TENANT), OBJECT);
  assert.equal(assertKbSourcePathOwnedByTenant(`/${TENANT}\\kb-files\\a.pdf`, TENANT), `${TENANT}/kb-files/a.pdf`);
  for (const path of [`${OTHER_TENANT}/kb-files/a.pdf`, `${TENANT}/../${OTHER_TENANT}/a.pdf`,
    `https://${TENANT}/a.pdf`, `${TENANT}`, '']) {
    assert.throws(() => assertKbSourcePathOwnedByTenant(path, TENANT),
      (error: unknown) => error instanceof AppError && error.code === 'KB_SOURCE_PATH_INVALID' && error.statusCode === 422);
  }
  assert.throws(() => assertKbSourcePathOwnedByTenant(OBJECT, ''));
});

test('the signed URL origin can be rewritten for the AI server without touching path or token', () => {
  assert.equal(rewriteSignedUrlOrigin(SIGNED, ''), SIGNED);
  const rewritten = new URL(rewriteSignedUrlOrigin(SIGNED, 'https://storage.internal:8443'));
  assert.equal(rewritten.origin, 'https://storage.internal:8443');
  assert.equal(rewritten.pathname, `/storage/v1/object/sign/landa-storage/${OBJECT}`);
  assert.equal(rewritten.searchParams.get('token'), 'secret.jwt.token');
  assert.equal(new URL(rewriteSignedUrlOrigin(SIGNED, 'https://storage.internal')).port, '');
});

test('signing asks for one object in the bucket with the configured TTL', async () => {
  const calls: Array<[string, string, number]> = [];
  const url = await signKbDocumentSourceUrl({
    filePath: OBJECT, tenantId: TENANT, bucket: 'landa-storage', ttlSeconds: 600, origin: '',
    sign: async (bucket, objectPath, ttl) => { calls.push([bucket, objectPath, ttl]); return SIGNED; },
  });
  assert.equal(url, SIGNED);
  assert.deepEqual(calls, [['landa-storage', OBJECT, 600]]);
});

test('signing failures become a retryable safe code and foreign paths are never signed', async () => {
  for (const sign of [async () => { throw new Error(`storage said no for ${OBJECT}`); }, async () => '']) {
    await assert.rejects(signKbDocumentSourceUrl({
      filePath: OBJECT, tenantId: TENANT, bucket: 'landa-storage', ttlSeconds: 600, origin: '', sign,
    }), (error: unknown) => error instanceof AppError && error.code === 'KB_SOURCE_SIGNED_URL_FAILED'
      && error.statusCode === 503 && !error.message.includes(OBJECT));
  }
  let signed = false;
  await assert.rejects(signKbDocumentSourceUrl({
    filePath: `${OTHER_TENANT}/kb-files/a.pdf`, tenantId: TENANT, bucket: 'landa-storage', ttlSeconds: 600,
    origin: '', sign: async () => { signed = true; return SIGNED; },
  }), (error: unknown) => error instanceof AppError && error.code === 'KB_SOURCE_PATH_INVALID');
  assert.equal(signed, false);
});
