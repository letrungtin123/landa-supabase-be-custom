import { cacheKey, stableHash } from './cache.js';

export const CACHE_TTL = {
  publicConfig: 300,
  ssoPublic: 300,
  demoPublic: 8,
  tenantLabels: 300,
  modules: 600,
  tenantList: 120,
  learnerCourses: 120,
  courseDetail: 300,
  courseBlocks: 300,
  blockDetail: 300,
  courseFiles: 300,
  library: 120,
  courseModal: 600,
  badges: 600,
  emailTemplates: 300,
  aiConfig: 300,
  aiCourseOutline: 300,
  kbStoreName: 3600,
} as const;

export function normalizeCacheDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function queryHash(value: unknown): string {
  return stableHash(value ?? {});
}

export const cacheVersions = {
  publicDomain: (domain: string, resource: string) =>
    ['public', 'domain', stableHash(normalizeCacheDomain(domain)), resource] as const,
  tenantResource: (tenantId: string, resource: string) =>
    ['tenant', tenantId, resource] as const,
  tenantLibrary: (tenantId: string) =>
    ['tenant', tenantId, 'library'] as const,
  tenantCourses: (tenantId: string) =>
    ['tenant', tenantId, 'courses'] as const,
  tenantCourseCategories: (tenantId: string) =>
    ['tenant', tenantId, 'course-categories'] as const,
  tenantBadges: (tenantId: string) =>
    ['tenant', tenantId, 'badges'] as const,
  emailTemplates: () =>
    ['system', 'email-templates'] as const,
  tenantEmailTemplates: (tenantId: string) =>
    ['tenant', tenantId, 'email-templates'] as const,
  tenantEmailTemplate: (tenantId: string, templateKey: string) =>
    ['tenant', tenantId, 'email-template', templateKey] as const,
  tenantAi: (tenantId: string) =>
    ['tenant', tenantId, 'ai-chatbot'] as const,
  tenantLabels: (tenantId: string, kind: 'role' | 'group') =>
    ['tenant', tenantId, `${kind}-labels`] as const,
  courseContent: (courseId: string) =>
    ['course', courseId, 'content'] as const,
  courseAssets: (courseId: string) =>
    ['course', courseId, 'assets'] as const,
  courseModal: (courseId: string) =>
    ['course', courseId, 'modal'] as const,
  blockContent: (blockId: string) =>
    ['block', blockId, 'content'] as const,
  userMembership: (userId: string) =>
    ['user', userId, 'membership'] as const,
  userCourseProgress: (userId: string, courseId: string) =>
    ['user', userId, 'course', courseId, 'progress'] as const,
  bot: (botId: string) =>
    ['bot', botId] as const,
  modules: () =>
    ['system', 'modules'] as const,
};

export const cacheKeys = {
  publicDomain: (domain: string, resource: string, version: string) =>
    cacheKey('public', 'domain', stableHash(normalizeCacheDomain(domain)), resource, `v${version}`),
  tenantResource: (tenantId: string, resource: string, version: string, extra?: unknown) =>
    cacheKey('tenant', tenantId, resource, `v${version}`, queryHash(extra)),
  learnerResource: (
    tenantId: string,
    userId: string,
    resource: string,
    versions: readonly string[],
    extra?: unknown,
  ) => cacheKey('tenant', tenantId, 'learner', userId, resource, ...versions.map((version) => `v${version}`), queryHash(extra)),
  courseResource: (courseId: string, resource: string, version: string, extra?: unknown) =>
    cacheKey('course', courseId, resource, `v${version}`, queryHash(extra)),
  blockResource: (blockId: string, version: string) =>
    cacheKey('block', blockId, 'detail', `v${version}`),
  emailTemplate: (tenantId: string, templateKey: string, version: string) =>
    cacheKey('tenant', tenantId, 'email-template', templateKey, `v${version}`),
  aiTenantResource: (tenantId: string, resource: string, version: string, extra?: unknown) =>
    cacheKey('tenant', tenantId, 'ai-chatbot', resource, `v${version}`, queryHash(extra)),
  botResource: (tenantId: string, botId: string, resource: string, version: string, extra?: unknown) =>
    cacheKey('tenant', tenantId, 'bot', botId, resource, `v${version}`, queryHash(extra)),
};
