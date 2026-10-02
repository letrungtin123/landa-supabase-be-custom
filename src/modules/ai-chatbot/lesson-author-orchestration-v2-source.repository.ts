import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { OrchestrationV2SourceScope } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { normalizeSourceFactPageV2, sourceFactPageDigestV2, type SourceFactCandidateV2 } from './lesson-author-orchestration-v2-source.logic.js';

export interface SourceSnapshotTargetV2 {
  snapshotId: string;
  workspaceId: string;
  tenantId: string;
  courseId: string;
}

export class SourceSnapshotRepositoryV2Error extends Error {
  constructor(readonly code:
    | 'SOURCE_SNAPSHOT_NOT_BUILDING'
    | 'SOURCE_FACT_PAGE_CONFLICT'
    | 'SOURCE_FACT_PAGE_WRITE_UNCONFIRMED'
    | 'SOURCE_SCOPE_CATALOG_INVALID'
    | 'SOURCE_SNAPSHOT_SEAL_UNCONFIRMED') {
    super(code);
  }
}

export function createSourceSnapshotRepositoryV2() {
  async function appendPage(tx: GenerationJobSql, target: SourceSnapshotTargetV2, startOrdinal: number,
    candidates: readonly SourceFactCandidateV2[]) {
    const rows = normalizeSourceFactPageV2(startOrdinal, candidates);
    const snapshot = await tx.query(`SELECT status,fact_count FROM lesson_author_workspace_source_snapshots
      WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 FOR UPDATE`,
    [target.snapshotId, target.workspaceId, target.tenantId, target.courseId]);
    if (snapshot.rows.length !== 1 || snapshot.rows[0].status !== 'building') {
      throw new SourceSnapshotRepositoryV2Error('SOURCE_SNAPSHOT_NOT_BUILDING');
    }
    const existing = await tx.query(`SELECT ordinal,fact_key,scope_key,fact_hash,document_id::text
      FROM lesson_author_workspace_source_facts WHERE snapshot_id=$1 AND ordinal BETWEEN $2 AND $3 ORDER BY ordinal`,
    [target.snapshotId, startOrdinal, startOrdinal + rows.length - 1]);
    if (existing.rows.length) {
      const expected = sourceFactPageDigestV2(rows);
      const actual = sourceFactPageDigestV2(existing.rows.map((row) => ({
        ordinal: Number(row.ordinal), fact_key: String(row.fact_key), scope_key: String(row.scope_key),
        fact_hash: String(row.fact_hash), document_id: String(row.document_id), fact_text: '', locator: {},
      })));
      if (existing.rows.length !== rows.length || actual !== expected) {
        throw new SourceSnapshotRepositoryV2Error('SOURCE_FACT_PAGE_CONFLICT');
      }
      return { inserted: false, count: rows.length, next_ordinal: startOrdinal + rows.length, page_digest: expected };
    }
    const current = await tx.query(`SELECT count(*)::integer AS count,coalesce(max(ordinal),-1)::integer AS last
      FROM lesson_author_workspace_source_facts WHERE snapshot_id=$1`, [target.snapshotId]);
    if (Number(current.rows[0]?.count) !== startOrdinal || Number(current.rows[0]?.last) !== startOrdinal - 1) {
      throw new SourceSnapshotRepositoryV2Error('SOURCE_FACT_PAGE_CONFLICT');
    }
    const inserted = await tx.query(`INSERT INTO lesson_author_workspace_source_facts(snapshot_id,workspace_id,tenant_id,course_id,
      document_id,ordinal,fact_key,scope_key,source_ref,source_page,source_chunk,fact_hash,fact_text,locator)
      SELECT $1,$2,$3,$4,x.document_id::uuid,x.ordinal,x.fact_key,x.scope_key,x.source_ref,x.source_page,x.source_chunk,
        x.fact_hash,x.fact_text,x.locator
      FROM jsonb_to_recordset($5::jsonb) AS x(document_id text,ordinal integer,fact_key text,scope_key text,
        source_ref text,source_page integer,source_chunk integer,fact_hash text,fact_text text,locator jsonb)
      ORDER BY x.ordinal RETURNING ordinal`,
    [target.snapshotId, target.workspaceId, target.tenantId, target.courseId, JSON.stringify(rows)]);
    if (inserted.rows.length !== rows.length) throw new SourceSnapshotRepositoryV2Error('SOURCE_FACT_PAGE_WRITE_UNCONFIRMED');
    return { inserted: true, count: rows.length, next_ordinal: startOrdinal + rows.length, page_digest: sourceFactPageDigestV2(rows) };
  }

  async function seal(tx: GenerationJobSql, target: SourceSnapshotTargetV2) {
    const result = await tx.query(`WITH totals AS (
        SELECT count(*)::integer AS facts,count(DISTINCT scope_key)::integer AS scopes,
          coalesce(sum(octet_length(fact_text)),0)::bigint AS bytes
        FROM lesson_author_workspace_source_facts WHERE snapshot_id=$1
      ) UPDATE lesson_author_workspace_source_snapshots s SET status='sealed',fact_count=t.facts,
        scope_count=t.scopes,content_bytes=t.bytes,sealed_at=clock_timestamp()
      FROM totals t WHERE s.id=$1 AND s.workspace_id=$2 AND s.tenant_id=$3 AND s.course_id=$4
        AND s.status='building' AND t.facts>0 AND t.scopes>0 AND t.bytes>0
      RETURNING s.fact_count,s.scope_count,s.content_bytes`,
    [target.snapshotId, target.workspaceId, target.tenantId, target.courseId]);
    if (result.rows.length !== 1) throw new SourceSnapshotRepositoryV2Error('SOURCE_SNAPSHOT_SEAL_UNCONFIRMED');
    return { fact_count: Number(result.rows[0].fact_count), scope_count: Number(result.rows[0].scope_count),
      content_bytes: Number(result.rows[0].content_bytes) };
  }

  async function loadCatalog(tx: GenerationJobSql, target: SourceSnapshotTargetV2): Promise<OrchestrationV2SourceScope[]> {
    const result = await tx.query(`SELECT scope_key,min(nullif(source_ref,'')) AS source_ref,
        min(nullif(locator->>'scope_title','')) AS scope_title,count(*)::integer AS fact_count,
        sum(char_length(fact_text))::bigint AS content_chars,min(ordinal)::integer AS first_ordinal
      FROM lesson_author_workspace_source_facts
      WHERE snapshot_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4
      GROUP BY scope_key ORDER BY first_ordinal`,
    [target.snapshotId, target.workspaceId, target.tenantId, target.courseId]);
    if (result.rows.length < 1 || result.rows.length > 4_096) {
      throw new SourceSnapshotRepositoryV2Error('SOURCE_SCOPE_CATALOG_INVALID');
    }
    return result.rows.map(row => {
      const scopeKey = String(row.scope_key ?? '');
      const title = String(row.scope_title ?? row.source_ref ?? scopeKey);
      const factCount = Number(row.fact_count);
      const contentChars = Number(row.content_chars);
      if (!scopeKey || scopeKey.length > 255 || !title || title.length > 500
        || !Number.isSafeInteger(factCount) || factCount < 1 || factCount > 1_000_000
        || !Number.isSafeInteger(contentChars) || contentChars < 1 || contentChars > 100_000_000) {
        throw new SourceSnapshotRepositoryV2Error('SOURCE_SCOPE_CATALOG_INVALID');
      }
      return { scope_key: scopeKey, title, source_ref: row.source_ref ? String(row.source_ref) : null,
        fact_count: factCount, content_chars: contentChars };
    });
  }
  return { appendPage, seal, loadCatalog };
}
