import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routes = readFileSync(new URL('./course-authoring.routes.ts', import.meta.url), 'utf8');
const controller = readFileSync(new URL('./course-authoring.controller.ts', import.meta.url), 'utf8');
const governanceController = readFileSync(new URL('./course-publish-governance.controller.ts', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
const pm2 = readFileSync(new URL('../../../ecosystem.config.cjs', import.meta.url), 'utf8');

test('reviewer approval needs view authority but not edit authority', () => {
  assert.match(routes, /publish-governance\/candidates\/:candidateId\/approve', checkPermission\('courses', 'can_view'\)/);
  assert.doesNotMatch(routes, /publish-governance\/candidates\/:candidateId\/approve', checkPermission\('courses', 'can_edit'\)/);
  assert.match(governanceController, /approveCoursePublishCandidate\([\s\S]*assignmentId, reason/);
});

test('policy and reviewer assignment remain privileged edit operations', () => {
  assert.match(routes, /publish-governance\/courses\/:courseId\/policy', checkPermission\('courses', 'can_edit'\)/);
  assert.match(routes, /publish-governance\/courses\/:courseId\/reviewer-assignments', checkPermission\('courses', 'can_edit'\)/);
  assert.match(routes, /publish-governance\/courses\/:courseId\/reviewer-options', checkPermission\('courses', 'can_edit'\)/);
  assert.match(governanceController, /function assertPolicyAdmin/);
});

test('eligibility is read-only and derived by the backend for course viewers', () => {
  assert.match(routes, /publish-governance\/candidates\/:candidateId\/eligibility', checkPermission\('courses', 'can_view'\)/);
  assert.match(governanceController, /getCoursePublishCandidateEligibility\(req\.user!, req\.params\.candidateId\)/);
});

test('an enrolled course cannot use the ordinary publish path without an exact candidate UUID', () => {
  assert.match(controller, /const enrolledPolicy =[\s\S]*getCoursePublishPolicyForBlock/);
  assert.match(controller, /typeof candidate_id !== 'string' \|\| !UUID\.test\(candidate_id\)/);
  assert.match(controller, /COURSE_PUBLISH_CANDIDATE_REQUIRED/);
  assert.match(controller, /candidateId: candidate_id/);
});

test('governance stays opt-in for local examples and is enabled in the approved PM2 rollout', () => {
  assert.match(envExample, /^COURSE_PUBLISH_GOVERNANCE_ENABLED=false$/m);
  assert.equal((pm2.match(/COURSE_PUBLISH_GOVERNANCE_ENABLED: "true"/g) ?? []).length, 2);
});
