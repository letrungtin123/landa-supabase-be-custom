import { readFileSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTANCE_DATABASE_NAME = /(acceptance|test|testing|staging|ci)/i;
const CONFIRMATION = 'DESTROY_DISPOSABLE_COURSE_PUBLISH_FIXTURES';
const CONTRACT = 'course-publish-acceptance-fixture-1';

export const COURSE_PUBLISH_ACCEPTANCE_SCENARIOS = [
  'editVsApproval',
  'editVsPublish',
  'permissionRevokeVsPublish',
  'evidenceVsPublish',
  'staleCandidate',
  'idempotentReplay',
  'courseCascade',
] as const;

type ScenarioName = typeof COURSE_PUBLISH_ACCEPTANCE_SCENARIOS[number];

export interface BaseAcceptanceFixture {
  tenantId: string;
  courseId: string;
  targetBlockId?: string;
  candidateId?: string;
  actorId?: string;
  editBlockId?: string;
}

export interface CoursePublishAcceptanceManifest {
  contract: typeof CONTRACT;
  scenarios: Record<ScenarioName, BaseAcceptanceFixture & {
    reviewerId?: string;
    assignmentId?: string;
    permissionGroupId?: string;
    mappingId?: string;
  }>;
}

function normalizedEndpoint(input: string): string {
  const url = new URL(input);
  url.password = '';
  url.username = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '').toLowerCase();
}

export function requireDisposableAcceptanceDatabase(environment: NodeJS.ProcessEnv): string {
  const connectionString = environment.COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL?.trim();
  if (!connectionString) throw new Error('COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL is required.');
  if (environment.COURSE_PUBLISH_ACCEPTANCE_CONFIRM !== CONFIRMATION) {
    throw new Error(`COURSE_PUBLISH_ACCEPTANCE_CONFIRM must equal ${CONFIRMATION}.`);
  }
  if (environment.NODE_ENV === 'production') throw new Error('Production runtime is forbidden.');

  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error('Acceptance database URL is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Acceptance database must use PostgreSQL.');
  if (/supabase\.(co|com)$/i.test(url.hostname) || /pooler\.supabase\.com$/i.test(url.hostname)) {
    throw new Error('Supabase-hosted endpoints are forbidden for destructive acceptance.');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!ACCEPTANCE_DATABASE_NAME.test(databaseName)) {
    throw new Error('Acceptance database name must contain acceptance/test/testing/staging/ci.');
  }
  const runtimeDatabase = environment.DATABASE_URL?.trim();
  if (runtimeDatabase && normalizedEndpoint(runtimeDatabase) === normalizedEndpoint(connectionString)) {
    throw new Error('Acceptance database must differ from DATABASE_URL.');
  }
  return connectionString;
}

function requiredUuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${path} must be a UUID.`);
  return value;
}

function requiredCourseId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^course-v1:[^\s]+$/i.test(value)
    || !/(acceptance|test)/i.test(value)) {
    throw new Error(`${path} must be a disposable course-v1 ID containing acceptance/test.`);
  }
  return value;
}

export function readCoursePublishAcceptanceManifest(path: string): CoursePublishAcceptanceManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CoursePublishAcceptanceManifest>;
  if (parsed.contract !== CONTRACT || !parsed.scenarios || typeof parsed.scenarios !== 'object') {
    throw new Error(`Acceptance manifest contract must equal ${CONTRACT}.`);
  }

  const scenarios = parsed.scenarios as unknown as Record<string, Record<string, unknown>>;
  const courseIds = new Set<string>();
  for (const name of COURSE_PUBLISH_ACCEPTANCE_SCENARIOS) {
    const fixture = scenarios[name];
    if (!fixture || typeof fixture !== 'object') throw new Error(`Missing acceptance scenario ${name}.`);
    requiredUuid(fixture.tenantId, `${name}.tenantId`);
    const courseId = requiredCourseId(fixture.courseId, `${name}.courseId`);
    if (courseIds.has(courseId)) throw new Error('Every destructive scenario requires a separate disposable course.');
    courseIds.add(courseId);

    if (name !== 'courseCascade') {
      requiredUuid(fixture.targetBlockId, `${name}.targetBlockId`);
      requiredUuid(fixture.candidateId, `${name}.candidateId`);
      requiredUuid(fixture.actorId, `${name}.actorId`);
    }
    if (name === 'editVsApproval' || name === 'editVsPublish' || name === 'staleCandidate') {
      requiredUuid(fixture.editBlockId, `${name}.editBlockId`);
    }
    if (name === 'editVsApproval') {
      requiredUuid(fixture.reviewerId, `${name}.reviewerId`);
      requiredUuid(fixture.assignmentId, `${name}.assignmentId`);
    }
    if (name === 'permissionRevokeVsPublish') {
      requiredUuid(fixture.reviewerId, `${name}.reviewerId`);
      requiredUuid(fixture.permissionGroupId, `${name}.permissionGroupId`);
    }
    if (name === 'evidenceVsPublish') requiredUuid(fixture.mappingId, `${name}.mappingId`);
  }
  return parsed as CoursePublishAcceptanceManifest;
}

export const COURSE_PUBLISH_ACCEPTANCE_CONFIRMATION = CONFIRMATION;
