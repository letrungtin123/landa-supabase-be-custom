// The production organization context service: the real database, knowledge base, AI settings and
// AI points behind createOrgContextService. One instance per process, created on first use (importing
// this module starts nothing).

import { query, withDatabaseTransaction } from '../../../../config/database.js';
import { invalidateTenantAiCaches } from '../../../../config/cache-invalidation.js';
import { env } from '../../../../config/env.js';
import { runAuditedTransaction } from '../../../../middleware/audit-log.js';
import { isAiCreditMonthExhausted } from '../../../ai-credits/ai-credit.service.js';
import { getTenantAiRuntimeSettings } from '../../ai-platform/ai-settings.service.js';
import { getActiveBot, getActiveKbAssignmentFresh } from '../../chat/chat.service.js';
import * as kbService from '../../kb/kb.service.js';
import { createOrgContextRepository } from './lesson-author-org-context.repository.js';
import { createOrgContextService, type OrgContextService, type OrgContextSettings } from './lesson-author-org-context.service.js';

export function orgContextSettings(): OrgContextSettings {
  return { enabled: env.LESSON_AUTHOR_ORG_CONTEXT_ENABLED, tenant_allowlist: env.LESSON_AUTHOR_ORG_CONTEXT_TENANT_ALLOWLIST,
    max_bytes: env.LESSON_AUTHOR_ORG_CONTEXT_MAX_BYTES };
}

/** AI engine and provider key (tenant_ai_settings) and the deployed lesson_author bot + knowledge base. */
export async function orgContextReadiness(tenantId: string): Promise<{ engine: string | null; deployed: boolean;
  providerKey: boolean }> {
  const settings = await getTenantAiRuntimeSettings(tenantId);
  const bot = await getActiveBot(tenantId, 'lesson_author');
  const assignment = await getActiveKbAssignmentFresh(tenantId);
  return { engine: settings.activeEngine, deployed: Boolean(bot && assignment), providerKey: settings.hasGoogleAiStudioKey };
}

let service: OrgContextService | null = null;

export function productionOrgContextService(): OrgContextService {
  service ??= createOrgContextService({
    repository: createOrgContextRepository({ query }),
    transaction: work => withDatabaseTransaction(() => work()),
    audited: (work, entry) => runAuditedTransaction(work, entry),
    settings: orgContextSettings,
    readiness: orgContextReadiness,
    documents: {
      stage: (kbId, tenantId, file) => kbService.stageDocumentSource(kbId, tenantId, file),
      createQueued: (kbId, tenantId, userId, staged) => kbService.createQueuedDocumentFromStagedSource(kbId, tenantId,
        userId, staged),
      discard: staged => kbService.discardStagedKbSource(staged),
      queueDeletion: (documentId, kbId, tenantId) => kbService.queueDocumentDeletion(documentId, kbId, tenantId),
    },
    knowledgebaseCreated: tenantId => invalidateTenantAiCaches(tenantId),
    creditExhausted: tenantId => isAiCreditMonthExhausted(tenantId),
  });
  return service;
}
