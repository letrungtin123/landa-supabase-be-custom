// SQL of the report PDF export: the stored chat narrative of a report message
// (same ownership predicates as the snapshot loader) and the export audit row.
import { query, withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';

export interface StoredReportChatNarrative {
  narrative: unknown;
  locale: 'vi' | 'en';
  snapshotHash: string | null;
}

/** Reads only the narrative fields; integrity of the snapshot is checked by loadStoredReportSnapshot. */
export async function loadStoredReportChatNarrative(input: {
  assistantMessageId: string;
  conversationId: string;
  userId: string;
  tenantId: string;
}): Promise<StoredReportChatNarrative | null> {
  const result = await query<{ narrative: unknown; locale: string | null; snapshot_hash: string | null }>(
    `SELECT message.metadata -> 'report_narrative' AS narrative,
            message.metadata ->> 'locale' AS locale,
            message.metadata ->> 'report_snapshot_hash' AS snapshot_hash
     FROM chat_messages message
     JOIN chat_conversations conversation ON conversation.id = message.conversation_id
     WHERE message.id = $1::uuid
       AND message.conversation_id = $2::uuid
       AND message.role = 'assistant'
       AND conversation.user_id = $3::uuid
       AND conversation.tenant_id = $4::uuid
       AND conversation.target = 'admin'
     LIMIT 1`,
    [input.assistantMessageId, input.conversationId, input.userId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row || row.narrative === null || row.narrative === undefined) return null;
  return { narrative: row.narrative, locale: row.locale === 'en' ? 'en' : 'vi', snapshotHash: row.snapshot_hash };
}

/** One audit row per delivered export (own short transaction, no other I/O inside). */
export async function appendReportPdfExportAudit(entry: TransactionalAuditEntry): Promise<void> {
  await withDatabaseTransaction((client) => appendAuditLog(client, entry));
}
