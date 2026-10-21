// SQL of the exclusive knowledge base rule (kb-usage.logic.ts). Every statement is tenant-scoped.

import type { QueryResult, QueryResultRow } from 'pg';
import { LESSON_AUTHOR_CONTEXT_KB_TARGET, LESSON_AUTHOR_TARGET } from './chat.constants.js';
import { kbUsageLockKey, type KbUsageRow } from './kb-usage.logic.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface KbUsageDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export function createKbUsageRepository(db: KbUsageDb) {
  return {
    /** Held until the caller's transaction ends: one knowledge base usage write per tenant at a time. */
    async lockTenant(tenantId: string): Promise<void> {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [kbUsageLockKey(tenantId)]);
    },

    /** The admin and learner page bots with their knowledge base, and the AI ID knowledge base assignments (at most 4 rows). */
    async selectUsages(tenantId: string): Promise<KbUsageRow[]> {
      const result = await db.query<KbUsageRow>(
        `SELECT tba.target::text AS slot, tba.bot_id::text AS bot_id, c.kb_id::text AS kb_id, kb.name AS kb_name
         FROM tenant_bot_assignments tba
         JOIN chatbots c ON c.id = tba.bot_id AND c.tenant_id = tba.tenant_id
         LEFT JOIN knowledgebases kb ON kb.id = c.kb_id AND kb.tenant_id = c.tenant_id
         WHERE tba.tenant_id = $1 AND tba.target IN ('admin', 'learner')
         UNION ALL
         SELECT CASE WHEN tka.target = $2 THEN 'ai_id' ELSE 'ai_id_context' END, NULL, tka.kb_id::text, kb.name
         FROM tenant_kb_assignments tka
         LEFT JOIN knowledgebases kb ON kb.id = tka.kb_id AND kb.tenant_id = tka.tenant_id
         WHERE tka.tenant_id = $1 AND tka.target IN ($2, $3)`,
        [tenantId, LESSON_AUTHOR_TARGET, LESSON_AUTHOR_CONTEXT_KB_TARGET],
      );
      return result.rows;
    },

    /** The bot's knowledge base; undefined when the bot is not this tenant's. */
    async selectBotKb(tenantId: string, botId: string): Promise<{ kb_id: string | null } | undefined> {
      const result = await db.query<{ kb_id: string | null }>(
        'SELECT kb_id::text AS kb_id FROM chatbots WHERE id = $1 AND tenant_id = $2',
        [botId, tenantId],
      );
      return result.rows[0];
    },
  };
}
