import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCourseMentorLogoOwnership } from './course-mentor-logo-ownership.logic.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const otherTenantId = '22222222-2222-2222-2222-222222222222';
const courseId = 'course-v1:Nesso+OWNERSHIP+2026';

test('mentor logo ownership accepts only the exact tenant and course prefixes', () => {
  assert.deepEqual(
    classifyCourseMentorLogoOwnership(`${tenantId}/courses/${courseId}/mentor-section/light.png`, tenantId, courseId),
    { kind: 'course-owned', storagePath: `${tenantId}/courses/${courseId}/mentor-section/light.png` },
  );
  assert.deepEqual(
    classifyCourseMentorLogoOwnership(`${tenantId}/courses/${courseId}-copy/mentor-section/light.png`, tenantId, courseId),
    {
      kind: 'unknown',
      reason: 'unrecognized-tenant-path',
      storagePath: `${tenantId}/courses/${courseId}-copy/mentor-section/light.png`,
    },
  );
  assert.deepEqual(
    classifyCourseMentorLogoOwnership(`${otherTenantId}/courses/${courseId}/mentor-section/light.png`, tenantId, courseId),
    {
      kind: 'unknown',
      reason: 'foreign-or-untrusted-tenant-path',
      storagePath: `${otherTenantId}/courses/${courseId}/mentor-section/light.png`,
    },
  );
});

test('tenant branding is a shared reference and is never course-owned', () => {
  assert.deepEqual(
    classifyCourseMentorLogoOwnership(`${tenantId}/branding/header_logo.png`, tenantId, courseId),
    { kind: 'tenant-branding', storagePath: `${tenantId}/branding/header_logo.png` },
  );
});

test('invalid and unrecognized logo references are retained rather than trusted for deletion', () => {
  assert.deepEqual(
    classifyCourseMentorLogoOwnership(`${tenantId}/courses/../${courseId}/mentor-section/light.png`, tenantId, courseId),
    { kind: 'unknown', reason: 'invalid-storage-path' },
  );
  assert.deepEqual(
    classifyCourseMentorLogoOwnership(`${tenantId}/avatars/someone.png`, tenantId, courseId),
    {
      kind: 'unknown',
      reason: 'unrecognized-tenant-path',
      storagePath: `${tenantId}/avatars/someone.png`,
    },
  );
});
