// Pure message-query contracts used by the lesson-author conversation flow.
// Keeping this SQL text isolated makes tenant-scoped hydration regressions
// testable without opening a database connection in unit tests.

export const LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY = `SELECT id::text, status, proposal, error_reason, created_block_ids, source_documents,
        blueprint_id::text
 FROM lesson_author_jobs laj
 WHERE laj.conversation_id = $1
   AND laj.tenant_id = $2
   AND laj.id = ANY($3::uuid[])`;
