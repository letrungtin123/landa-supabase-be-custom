import { query } from './database.js';
import { bumpCacheVersions } from './cache.js';
import { cacheVersions, normalizeCacheDomain } from './cache-keys.js';

type TenantDomainRow = {
  domain_admin: string | null;
  domain_learner: string | null;
};

function uniqueDomains(row?: TenantDomainRow): string[] {
  const domains = [row?.domain_admin, row?.domain_learner]
    .map((domain) => (domain ? normalizeCacheDomain(domain) : ''))
    .filter(Boolean);
  return [...new Set(domains)];
}

export async function invalidatePublicDomainCachesForDomains(
  domains: readonly (string | null | undefined)[],
  resources: readonly string[],
): Promise<void> {
  const unique = [...new Set(domains.map((domain) => (domain ? normalizeCacheDomain(domain) : '')).filter(Boolean))];
  await bumpCacheVersions(unique.flatMap((domain) =>
    resources.map((resource) => cacheVersions.publicDomain(domain, resource)),
  ));
}

export async function invalidateTenantPublicDomainCaches(
  tenantId: string,
  resources: readonly string[],
): Promise<void> {
  const result = await query<TenantDomainRow>(
    'SELECT domain_admin, domain_learner FROM tenants WHERE id = $1',
    [tenantId],
  );
  const domains = uniqueDomains(result.rows[0]);
  await bumpCacheVersions(domains.flatMap((domain) =>
    resources.map((resource) => cacheVersions.publicDomain(domain, resource)),
  ));
}

export async function invalidateTenantCourseCaches(tenantId: string): Promise<void> {
  await bumpCacheVersions([
    cacheVersions.tenantCourses(tenantId),
    cacheVersions.tenantCourseCategories(tenantId),
  ]);
}

export async function invalidateCourseReadCaches(courseId: string, tenantId?: string | null): Promise<void> {
  const namespaces: (readonly unknown[])[] = [
    cacheVersions.courseContent(courseId),
    cacheVersions.courseAssets(courseId),
    cacheVersions.courseModal(courseId),
  ];
  if (tenantId) namespaces.push(cacheVersions.tenantCourses(tenantId));
  await bumpCacheVersions(namespaces);
}

export async function invalidateBlockReadCaches(blockIds: readonly string[]): Promise<void> {
  await bumpCacheVersions(blockIds.map((blockId) => cacheVersions.blockContent(blockId)));
}

export async function invalidateTenantLibraryCaches(tenantId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.tenantLibrary(tenantId)]);
}

export async function invalidateTenantBadgeCaches(tenantId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.tenantBadges(tenantId)]);
}

export async function invalidateTenantAiCaches(tenantId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.tenantAi(tenantId)]);
}

export async function invalidateBotCaches(botId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.bot(botId)]);
}

export async function invalidateUserMembershipCaches(userIds: readonly string[]): Promise<void> {
  await bumpCacheVersions(userIds.map((userId) => cacheVersions.userMembership(userId)));
}

export async function invalidateUserCourseProgressCache(userId: string, courseId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.userCourseProgress(userId, courseId)]);
}
