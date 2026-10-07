import { pool, query, withDatabaseTransaction } from '../config/database.js';
import { enqueueKbOperation } from '../modules/ai-chatbot/kb-operation.service.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CONFIRMATION = 'REINDEX_LEGACY_RAG_EVIDENCE';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LegacyDocument = {
  tenant_id: string;
  kb_id: string;
  document_id: string;
  document_name: string;
  index_id: string;
  chunk_count: string;
};

function readRequiredUuid(args: readonly string[], name: string): string {
  const value = args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`--${name}=<uuid> is required`);
  return value;
}

function readOptionalUuid(args: readonly string[], name: string): string | null {
  const value = args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
  if (!value) return null;
  if (!UUID_PATTERN.test(value)) throw new Error(`--${name} must be a UUID`);
  return value;
}

function readLimit(args: readonly string[]): number {
  const raw = args.find(arg => arg.startsWith('--limit='))?.slice('--limit='.length);
  if (!raw) return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

async function findLegacyDocuments(input: {
  tenantId: string;
  kbId: string | null;
  documentId: string | null;
  limit: number;
}): Promise<LegacyDocument[]> {
  const result = await query<LegacyDocument>(
    `SELECT document.tenant_id::text,
            document.kb_id::text,
            document.id::text AS document_id,
            document.name AS document_name,
            index_row.id::text AS index_id,
            evidence.chunk_count::bigint::text
     FROM kb_documents document
     JOIN tenant_ai_settings settings
       ON settings.tenant_id = document.tenant_id
      AND settings.active_engine = 'self_built_rag'
     JOIN rag_document_indexes index_row
       ON index_row.document_id = document.id
      AND index_row.engine = 'self_built_rag'
      AND index_row.status = 'learned'
      AND index_row.is_active = true
     CROSS JOIN LATERAL (
       SELECT COUNT(*) AS chunk_count,
              COUNT(*) FILTER (
                WHERE chunk.metadata->>'source_evidence_revision' ~ '^[0-9a-f]{64}$'
              ) AS revisioned_chunk_count
       FROM rag_chunks chunk
       WHERE chunk.index_id = index_row.id
     ) evidence
     WHERE document.tenant_id = $1::uuid
       AND document.status = 'learned'
       AND (document.file_path IS NOT NULL OR NULLIF(BTRIM(document.content), '') IS NOT NULL)
       AND ($2::uuid IS NULL OR document.kb_id = $2::uuid)
       AND ($3::uuid IS NULL OR document.id = $3::uuid)
       AND evidence.chunk_count > 0
       AND evidence.revisioned_chunk_count = 0
       AND NOT EXISTS (
         SELECT 1
         FROM kb_operation_jobs operation_job
         WHERE operation_job.tenant_id = document.tenant_id
           AND operation_job.kb_id = document.kb_id
           AND operation_job.target_document_id = document.id
           AND operation_job.operation = 'document_reindex'
           AND operation_job.status IN ('queued', 'running')
       )
     ORDER BY document.updated_at ASC, document.id ASC
     LIMIT $4::int`,
    [input.tenantId, input.kbId, input.documentId, input.limit],
  );
  return result.rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantId = readRequiredUuid(args, 'tenant-id');
  const kbId = readOptionalUuid(args, 'kb-id');
  const documentId = readOptionalUuid(args, 'document-id');
  const limit = readLimit(args);
  const apply = args.includes('--apply');
  const confirmed = args.includes(`--confirm=${CONFIRMATION}`);
  const candidates = await findLegacyDocuments({ tenantId, kbId, documentId, limit });

  console.log(`[RagEvidenceReindex] Found ${candidates.length} legacy active index(es) (limit ${limit}).`);
  for (const candidate of candidates) {
    console.log(`[RagEvidenceReindex] ${candidate.document_id} chunks=${candidate.chunk_count} name=${candidate.document_name}`);
  }
  if (!apply) {
    console.log(`[RagEvidenceReindex] Dry run only. Enqueue with --apply --confirm=${CONFIRMATION}.`);
    return;
  }
  if (!confirmed) throw new Error(`Refusing to enqueue without --confirm=${CONFIRMATION}`);

  for (const candidate of candidates) {
    await withDatabaseTransaction(async () => {
      await enqueueKbOperation({
        tenantId: candidate.tenant_id,
        kbId: candidate.kb_id,
        documentId: candidate.document_id,
        operation: 'document_reindex',
        payload: {
          reason: 'structured_source_evidence_upgrade',
          previous_index_id: candidate.index_id,
          requested_contract: 'source-evidence-propagation-v1',
        },
      });
    });
  }
  console.log(`[RagEvidenceReindex] Enqueued ${candidates.length} zero-downtime reindex operation(s).`);
}

main()
  .then(() => pool.end())
  .catch(async error => {
    console.error('[RagEvidenceReindex] Failed:', error instanceof Error ? error.message : String(error));
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
