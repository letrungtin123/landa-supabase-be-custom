// ═══════════════════════════════════════════════════════════════
// Exclusive knowledge bases: the write guards and the conflict list.
//
// Every guard runs inside the caller's write transaction (the callers wrap
// their work in withDatabaseTransaction, nest-safe): it takes the tenant's
// transaction advisory lock first, then reads the usages, so two writes of
// one tenant (bot assignment, AI ID knowledge base assignment, a bot's
// knowledge base change) are serialized and the second sees the first one
// committed. The lock is released when that transaction ends.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../../config/database.js';
import { AppError } from '../../../middleware/error-handler.js';
import { LESSON_AUTHOR_TARGET, type ChatTarget } from './chat.constants.js';
import {
  AI_CHATBOT_KB_ALREADY_USED_CODE,
  findKbUsageClash,
  kbUsageClashMessage,
  kbUsageConflicts,
  type KbUsageClash,
  type KbUsageConflict,
} from './kb-usage.logic.js';
import { createKbUsageRepository, type KbUsageDb } from './kb-usage.repository.js';

/** A write refused by the exclusive knowledge base rule: 409, message in Vietnamese (localized() for the UI language). */
export class KbUsageClashError extends AppError {
  constructor(readonly clash: KbUsageClash) {
    super(kbUsageClashMessage(clash, 'vi'), 409, AI_CHATBOT_KB_ALREADY_USED_CODE);
    this.name = 'KbUsageClashError';
  }

  localized(locale: 'vi' | 'en'): string {
    return kbUsageClashMessage(this.clash, locale);
  }
}

export function createKbUsageGuard(db: KbUsageDb) {
  const repository = createKbUsageRepository(db);

  return {
    /**
     * PUT /bots/assignments: the bot's knowledge base must not be used by the other chat page or AI ID.
     * Target 'lesson_author' does not count (its bot's knowledge base is never read). Re-assigning the
     * bot a page already has creates nothing new and passes.
     */
    async assertBotAssignment(tenantId: string, target: ChatTarget, botId: string): Promise<void> {
      if (target === LESSON_AUTHOR_TARGET) return;
      await repository.lockTenant(tenantId);
      const usages = await repository.selectUsages(tenantId);
      if (usages.some(row => row.slot === target && row.bot_id === botId)) return;
      const bot = await repository.selectBotKb(tenantId, botId);
      if (!bot) return; // the caller answers 404
      const clash = findKbUsageClash(usages, { slots: [target], kbId: bot.kb_id });
      if (clash) throw new KbUsageClashError(clash);
    },

    /** PUT /lesson-author/kb-assignment: the AI ID knowledge base must not be a chat page's. */
    async assertAiIdKbAssignment(tenantId: string, kbId: string): Promise<void> {
      await repository.lockTenant(tenantId);
      const usages = await repository.selectUsages(tenantId);
      if (usages.some(row => row.slot === 'ai_id' && row.kb_id === kbId)) return;
      const clash = findKbUsageClash(usages, { slots: ['ai_id'], kbId });
      if (clash) throw new KbUsageClashError(clash);
    },

    /**
     * PUT /bots/:id with a kb_id: when the bot serves the admin and/or learner page, its new knowledge base
     * must not be used anywhere else (nor shared by both pages). An unchanged kb_id passes.
     */
    async assertBotKbChange(tenantId: string, botId: string, kbId: string): Promise<void> {
      await repository.lockTenant(tenantId);
      const usages = await repository.selectUsages(tenantId);
      const pages = usages.filter(row => row.bot_id === botId && (row.slot === 'admin' || row.slot === 'learner'));
      if (pages.length === 0 || pages.every(row => row.kb_id === kbId)) return;
      const clash = findKbUsageClash(usages, { slots: pages.map(row => row.slot as 'admin' | 'learner'), kbId });
      if (clash) throw new KbUsageClashError(clash);
    },

    /** GET /kb-usage-conflicts: the clashes that already exist (read only, nothing is fixed). */
    async listConflicts(tenantId: string): Promise<KbUsageConflict[]> {
      return kbUsageConflicts(await repository.selectUsages(tenantId));
    },
  };
}

/** The guard on the pool query(), which joins the caller's transaction. */
export const kbUsageGuard = createKbUsageGuard({ query });
