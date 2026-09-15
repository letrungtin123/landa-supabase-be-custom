import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../middleware/error-handler.js';
import {
  appendAuditLogViewerScopeFilter,
  assertLegacyAuditOffset,
  canViewAuditLogSensitivePii,
  DEFAULT_AUDIT_LOG_PAGE_SIZE,
  getAuditLogDetailPiiColumns,
  getAuditLogDetailPiiProjection,
  parseAuditLogPageSize,
} from './audit-logs.service.js';

test('audit logs default to 10 rows and accept only the supported page sizes', () => {
  assert.equal(parseAuditLogPageSize(undefined), DEFAULT_AUDIT_LOG_PAGE_SIZE);
  for (const pageSize of ['5', '10', '15', '20']) {
    assert.equal(parseAuditLogPageSize(pageSize), Number(pageSize));
  }
});

test('audit logs reject an unsupported or malformed page size before querying', () => {
  for (const pageSize of ['', '1', '20.0', '21', '50', '100', ['10', '20'], 10, null]) {
    assert.throws(
      () => parseAuditLogPageSize(pageSize),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  }
});

test('tenant viewers receive only explicitly tenant-visible audit rows', () => {
  const params: unknown[] = ['tenant-id', 30];
  const conditions = ['a.tenant_id = $1'];

  appendAuditLogViewerScopeFilter('staff', params, conditions);

  assert.deepEqual(params, ['tenant-id', 30, 'tenant', 'superadmin']);
  assert.deepEqual(conditions, [
    'a.tenant_id = $1',
    'a.viewer_scope = $3',
    'NOT EXISTS (SELECT 1 FROM users audit_actor WHERE audit_actor.id = a.actor_id AND audit_actor.role = $4)',
  ]);
});

test('superuser does not bypass audit event visibility', () => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  appendAuditLogViewerScopeFilter('superuser', params, conditions);

  assert.deepEqual(params, ['tenant', 'superadmin']);
  assert.deepEqual(conditions, [
    'a.viewer_scope = $1',
    'NOT EXISTS (SELECT 1 FROM users audit_actor WHERE audit_actor.id = a.actor_id AND audit_actor.role = $2)',
  ]);
});

test('tenant viewers do not receive tenant-scoped audit rows created by superadmin', () => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  appendAuditLogViewerScopeFilter('staff', params, conditions, 'g');

  assert.deepEqual(params, ['tenant', 'superadmin']);
  assert.deepEqual(conditions, [
    'g.viewer_scope = $1',
    'NOT EXISTS (SELECT 1 FROM users audit_actor WHERE audit_actor.id = g.actor_id AND audit_actor.role = $2)',
  ]);
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

test('authorized operators receive email fields only in the audit detail projection', () => {
  assert.equal(canViewAuditLogSensitivePii('staff'), true);
  assert.equal(canViewAuditLogSensitivePii('superuser'), true);
  assert.equal(canViewAuditLogSensitivePii('superadmin'), true);
  assert.match(getAuditLogDetailPiiColumns('staff'), /a\.subject_email/);
  assert.match(getAuditLogDetailPiiColumns('superuser'), /a\.subject_email/);
  assert.match(getAuditLogDetailPiiColumns('superadmin'), /lower\(actor\.email\)/);
});

test('authorized staff detail projection may fall back only to their own email for an unresolved legacy actor', () => {
  const params: unknown[] = ['tenant-id', 30];
  const projection = getAuditLogDetailPiiProjection({
    id: 'viewer-id',
    username: 'viewer',
    role: 'staff',
  }, params);

  assert.deepEqual(params, ['tenant-id', 30, 'viewer-id', 'viewer']);
  assert.match(projection.viewerJoin, /audit_viewer\.id = \$3::uuid/);
  assert.match(projection.columns, /a\.actor_username = \$4::text/);
  assert.match(projection.columns, /NULLIF\(lower\(audit_viewer\.email\), ''\)/);
});

test('privileged detail projection can fall back only to the current viewer email for an unresolved legacy actor', () => {
  const params: unknown[] = ['tenant-id', 30];
  const projection = getAuditLogDetailPiiProjection({
    id: 'viewer-id',
    username: 'viewer',
    role: 'superuser',
  }, params);

  assert.deepEqual(params, ['tenant-id', 30, 'viewer-id', 'viewer']);
  assert.match(projection.viewerJoin, /audit_viewer\.id = \$3::uuid/);
  assert.match(projection.columns, /NULLIF\(a\.actor_email, ''\)/);
  assert.match(projection.columns, /NULLIF\(lower\(actor\.email\), ''\)/);
  assert.match(projection.columns, /a\.actor_username = \$4::text/);
  assert.match(projection.columns, /NULLIF\(lower\(audit_viewer\.email\), ''\)/);
});
