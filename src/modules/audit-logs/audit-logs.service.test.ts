import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../middleware/error-handler.js';
import {
  appendAuditLogViewerScopeFilter,
  assertLegacyAuditOffset,
  canViewAuditLogSensitivePii,
  getAuditLogDetailPiiColumns,
} from './audit-logs.service.js';

test('tenant viewers receive only explicitly tenant-visible audit rows', () => {
  const params: unknown[] = ['tenant-id', 30];
  const conditions = ['a.tenant_id = $1'];

  appendAuditLogViewerScopeFilter('staff', params, conditions);

  assert.deepEqual(params, ['tenant-id', 30, 'tenant']);
  assert.deepEqual(conditions, ['a.tenant_id = $1', 'a.viewer_scope = $3']);
});

test('superuser does not bypass audit event visibility', () => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  appendAuditLogViewerScopeFilter('superuser', params, conditions);

  assert.deepEqual(params, ['tenant']);
  assert.deepEqual(conditions, ['a.viewer_scope = $1']);
});

test('superadmin receives all persisted viewer scopes, including legacy rows', () => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  appendAuditLogViewerScopeFilter('superadmin', params, conditions);

  assert.deepEqual(params, []);
  assert.deepEqual(conditions, []);
});

test('legacy paging rejects deep offsets so stale clients cannot trigger an expensive scan', () => {
  assert.doesNotThrow(() => assertLegacyAuditOffset(9_999));
  assert.throws(
    () => assertLegacyAuditOffset(10_000),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});

test('tenant staff never receive actor or deleted-user email fields', () => {
  assert.equal(canViewAuditLogSensitivePii('staff'), false);
  assert.equal(getAuditLogDetailPiiColumns('staff'), 'NULL::text AS actor_email,\n            NULL::text AS subject_email');
});

test('only superuser and superadmin receive audit-detail email fields', () => {
  assert.equal(canViewAuditLogSensitivePii('superuser'), true);
  assert.equal(canViewAuditLogSensitivePii('superadmin'), true);
  assert.match(getAuditLogDetailPiiColumns('superuser'), /a\.subject_email/);
  assert.match(getAuditLogDetailPiiColumns('superadmin'), /lower\(actor\.email\)/);
});
