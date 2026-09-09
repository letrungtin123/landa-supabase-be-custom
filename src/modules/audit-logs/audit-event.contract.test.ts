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

test('unregistered events cannot be normalized or exposed', () => {
  assert.throws(() => getAuditEventViewerScope('unreviewed.event'));
  assert.throws(() => normalizeStructuredAuditEvent({ code: 'unreviewed.event' }));
});
