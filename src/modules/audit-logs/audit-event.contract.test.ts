import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAuditEventViewerScope,
  normalizeStructuredAuditEvent,
} from './audit-event.contract.js';

test('tenant operations remain visible to authorized tenant roles', () => {
  assert.equal(getAuditEventViewerScope('course.component.updated'), 'tenant');
  assert.equal(getAuditEventViewerScope('group.team_member.added'), 'tenant');
  assert.equal(getAuditEventViewerScope('badge.rule.updated'), 'tenant');
  assert.equal(getAuditEventViewerScope('news.archived'), 'tenant');
  assert.equal(getAuditEventViewerScope('report.pdf.exported'), 'tenant');
});

test('superadmin-only feature events fail closed for tenant viewers', () => {
  assert.equal(getAuditEventViewerScope('tenant.updated'), 'superadmin_only');
  assert.equal(getAuditEventViewerScope('sso_config.updated'), 'superadmin_only');
  assert.equal(getAuditEventViewerScope('help_page.deleted'), 'superadmin_only');
  assert.equal(getAuditEventViewerScope('badge.image.updated'), 'superadmin_only');
  assert.equal(getAuditEventViewerScope('prompt_template.updated'), 'superadmin_only');
});

test('structured audit normalization persists the server-owned viewer scope', () => {
  assert.equal(normalizeStructuredAuditEvent({
    code: 'course.created',
  }).viewerScope, 'tenant');

  assert.equal(normalizeStructuredAuditEvent({
    code: 'tenant.modules.updated',
    context: { affected_count: 3 },
  }).viewerScope, 'superadmin_only');
});

test('a delivered report PDF is a tenant-visible event (rows keep the exporter tenant_id)', () => {
  const normalized = normalizeStructuredAuditEvent({ code: 'report.pdf.exported', context: { file_name: 'report.pdf', file_size_bytes: 2048 } });
  assert.equal(normalized.viewerScope, 'tenant');
});

test('unregistered events cannot be normalized or exposed', () => {
  assert.throws(() => getAuditEventViewerScope('unreviewed.event'));
  assert.throws(() => normalizeStructuredAuditEvent({ code: 'unreviewed.event' }));
});
