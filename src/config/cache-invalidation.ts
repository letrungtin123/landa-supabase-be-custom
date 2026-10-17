import { afterCommit, query } from './database.js';
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

export async function invalidateTenantModuleCaches(tenantId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.tenantModules(tenantId)]);
}

export async function invalidateTenantNewsCaches(tenantId: string): Promise<void> {
  await bumpCacheVersions([cacheVersions.tenantNews(tenantId)]);
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

/**
 * After a change of what a user's badge overview depends on (completed
 * courses, profile fields, user_badges). Inside withDatabaseTransaction() the
 * bump waits for the commit; after a legacy getClient() transaction, call it
 * after COMMIT.
 */
export async function invalidateUserBadgeCaches(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await afterCommit(() => bumpCacheVersions(userIds.map((userId) => cacheVersions.userBadges(userId))));
}

/** After notifications of the tenant were created or deleted (all recipients' unread counts). */
export async function invalidateTenantNotificationCaches(tenantId: string): Promise<void> {
  await afterCommit(() => bumpCacheVersions([cacheVersions.tenantNotifications(tenantId)]));
}

/** After a user marked notifications as read. */
export async function invalidateUserNotificationCaches(userId: string): Promise<void> {
  await afterCommit(() => bumpCacheVersions([cacheVersions.userNotifications(userId)]));
}
