// SQL of the AI ID organization context (SQL file 20261020_2200_lesson_author_org_context.sql): the
// hidden context knowledge base, its documents and size, the per-tenant state row and the append-only
// profile versions. Every statement filters by tenant. `db.query` joins the caller's transaction
// (config/database.ts query()), so the service decides what runs in one transaction.

import type { GenerationJobSql } from '../shared/lesson-author-generation-job.repository.js';
import {
  readOrgContextProfile, type OrgContextProfileV1,
} from '../contracts/lesson-author-org-context.contract.js';
import {
  ORG_CONTEXT_KB_DESCRIPTION, ORG_CONTEXT_KB_NAME, ORG_CONTEXT_KB_TARGET, orgContextUsageLockKey,
  type OrgContextDistillStatus, type OrgContextProfileOrigin,
} from './lesson-author-org-context.logic.js';

export type OrgContextDb = Pick<GenerationJobSql, 'query'>;

const NAME_OF = (alias: string) => `coalesce(nullif(btrim(${alias}.full_name), ''), nullif(btrim(${alias}.username), ''))`;
/** `source_info.size` of a document in bytes (0 when it is not a plain number). */
const SIZE_OF = (alias: string) => `CASE WHEN (${alias}.source_info->>'size') ~ '^[0-9]{1,15}$'
  THEN (${alias}.source_info->>'size')::bigint ELSE 0 END`;

export interface OrgContextDocumentRow {
  id: string;
  name: string;
  status: string;
  error_reason: string | null;
  size_bytes: number;
  created_at: string;
  created_by_name: string | null;
}

export interface OrgContextStateRow {
  revision: number;
  current_version: number | null;
  confirmed_version: number | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
  distill_status: OrgContextDistillStatus;
  distill_requested_at: string | null;
  distill_finished_at: string | null;
  distill_error_code: string | null;
}

export interface OrgContextVersionRow {
  version: number;
  origin: OrgContextProfileOrigin;
  profile: OrgContextProfileV1;
  char_count: number;
  profile_hash: string;
  created_at: string;
  created_by_name: string | null;
}

export interface OrgContextHistoryRow {
  version: number;
  origin: OrgContextProfileOrigin;
  char_count: number;
  created_at: string;
  created_by_name: string | null;
}

/** A stored row of another shape: fails closed with this code. */
export class OrgContextRowError extends Error {
  readonly code = 'ORG_CONTEXT_ROW_INVALID';
  constructor(readonly path: string) {
    super('ORG_CONTEXT_ROW_INVALID');
    this.name = 'OrgContextRowError';
  }
}

const rowInvalid = (path: string): never => { throw new OrgContextRowError(path); };
const iso = (value: unknown): string | null => value === null || value === undefined ? null
  : new Date(value instanceof Date ? value : String(value)).toISOString();
const whole = (value: unknown, path: string): number => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : rowInvalid(path);
};
const nullableWhole = (value: unknown, path: string): number | null => value === null ? null : whole(value, path);
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const ORIGINS = new Set<OrgContextProfileOrigin>(['ai_draft', 'author_edit', 'restore']);
const STATUSES = new Set<OrgContextDistillStatus>(['idle', 'queued', 'running', 'failed']);
const origin = (value: unknown): OrgContextProfileOrigin => ORIGINS.has(value as OrgContextProfileOrigin)
  ? value as OrgContextProfileOrigin : rowInvalid('origin');

function versionRow(row: Record<string, unknown>): OrgContextVersionRow {
  return { version: whole(row.version, 'version'), origin: origin(row.origin),
    profile: readOrgContextProfile(row.profile, 'profile', rowInvalid), char_count: whole(row.char_count, 'char_count'),
    profile_hash: typeof row.profile_hash === 'string' ? row.profile_hash : rowInvalid('profile_hash'),
    created_at: iso(row.created_at)!, created_by_name: text(row.created_by_name) };
}

const DOCUMENT_COLUMNS = `d.id::text AS id,d.name,d.status,d.error_reason,${SIZE_OF('d')}::text AS size_bytes,
  d.created_at,${NAME_OF('u')} AS created_by_name`;

function documentRow(row: Record<string, unknown>): OrgContextDocumentRow {
  return { id: String(row.id), name: String(row.name), status: String(row.status), error_reason: text(row.error_reason),
    size_bytes: whole(row.size_bytes, 'size_bytes'), created_at: iso(row.created_at)!,
    created_by_name: text(row.created_by_name) };
}

const STATE_COLUMNS =`s.revision::text AS revision,s.current_version,s.confirmed_version,s.confirmed_at,
  s.distill_status,s.distill_requested_at,s.distill_finished_at,s.distill_error_code`;

function stateRow(row: Record<string, unknown>): OrgContextStateRow {
  const status = row.distill_status as OrgContextDistillStatus;
  return { revision: whole(row.revision, 'revision'),
    current_version: nullableWhole(row.current_version, 'current_version'),
    confirmed_version: nullableWhole(row.confirmed_version, 'confirmed_version'),
    confirmed_at: iso(row.confirmed_at), confirmed_by_name: text(row.confirmed_by_name),
    distill_status: STATUSES.has(status) ? status : rowInvalid('distill_status'),
    distill_requested_at: iso(row.distill_requested_at), distill_finished_at: iso(row.distill_finished_at),
    distill_error_code: text(row.distill_error_code) };
}

export function createOrgContextRepository(db: OrgContextDb) {
  return {
    /** Whether the SQL file's tables, workspace column and assignment target exist (SELECT-only catalog check). */
    async schemaReady(): Promise<boolean> {
      const result = await db.query<{ ready: boolean }>(`SELECT
          to_regclass('public.lesson_author_org_context_profiles') IS NOT NULL
          AND to_regclass('public.lesson_author_org_context_states') IS NOT NULL
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='lesson_author_workspaces' AND column_name='organization_context')
          AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.tenant_kb_assignments'::regclass
            AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%${ORG_CONTEXT_KB_TARGET}%') AS ready`);
      return result.rows[0]?.ready === true;
    },

    /** The tenant's context knowledge base, or null before the first upload. */
    async contextKbId(tenantId: string): Promise<string | null> {
      const result = await db.query<{ kb_id: string }>(`SELECT a.kb_id::text AS kb_id FROM tenant_kb_assignments a
        JOIN knowledgebases kb ON kb.id=a.kb_id AND kb.tenant_id=a.tenant_id
        WHERE a.tenant_id=$1 AND a.target='${ORG_CONTEXT_KB_TARGET}'`, [tenantId]);
      return result.rows[0]?.kb_id ?? null;
    },

    /** Inserts the context knowledge base and its assignment (one transaction: the caller's). */
    async insertContextKb(tenantId: string, userId: string): Promise<string> {
      const created = await db.query<{ id: string }>(`INSERT INTO knowledgebases (tenant_id,name,description,created_by)
        VALUES ($1,$2,$3,$4) RETURNING id::text AS id`, [tenantId, ORG_CONTEXT_KB_NAME, ORG_CONTEXT_KB_DESCRIPTION, userId]);
      const kbId = created.rows[0]?.id ?? rowInvalid('knowledgebase');
      await db.query(`INSERT INTO tenant_kb_assignments (tenant_id,target,kb_id,updated_at)
        VALUES ($1,'${ORG_CONTEXT_KB_TARGET}',$2,now())`, [tenantId, kbId]);
      return kbId;
    },

    /** Serializes the size check of the tenant's uploads until the caller's transaction ends. */
    async lockUsage(tenantId: string): Promise<void> {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orgContextUsageLockKey(tenantId)]);
    },

    async usedBytes(tenantId: string, kbId: string): Promise<number> {
      const result = await db.query<{ used_bytes: string }>(`SELECT coalesce(sum(${SIZE_OF('d')}),0)::text AS used_bytes
        FROM kb_documents d WHERE d.tenant_id=$1 AND d.kb_id=$2`, [tenantId, kbId]);
      return whole(result.rows[0]?.used_bytes ?? '0', 'used_bytes');
    },

    async listDocuments(tenantId: string, kbId: string, limit: number): Promise<OrgContextDocumentRow[]> {
      const result = await db.query(`SELECT ${DOCUMENT_COLUMNS}
        FROM kb_documents d LEFT JOIN users u ON u.id=d.created_by
        WHERE d.tenant_id=$1 AND d.kb_id=$2 ORDER BY d.created_at DESC,d.id DESC LIMIT $3`, [tenantId, kbId, limit]);
      return result.rows.map(documentRow);
    },

    async readDocument(tenantId: string, kbId: string, documentId: string): Promise<OrgContextDocumentRow | null> {
      const result = await db.query(`SELECT ${DOCUMENT_COLUMNS}
        FROM kb_documents d LEFT JOIN users u ON u.id=d.created_by
        WHERE d.id=$1 AND d.tenant_id=$2 AND d.kb_id=$3`, [documentId, tenantId, kbId]);
      return result.rows[0] ? documentRow(result.rows[0]) : null;
    },

    async findDocument(tenantId: string, kbId: string, documentId: string): Promise<{ id: string; name: string; status: string } | null> {
      const result = await db.query<{ id: string; name: string; status: string }>(`SELECT d.id::text AS id,d.name,d.status
        FROM kb_documents d WHERE d.id=$1 AND d.tenant_id=$2 AND d.kb_id=$3`, [documentId, tenantId, kbId]);
      return result.rows[0] ?? null;
    },

    /** Learned files of the context knowledge base, oldest first (the order a draft reads them in). */
    async learnedDocuments(tenantId: string, kbId: string, limit: number): Promise<Array<{ id: string; size_bytes: number }>> {
      const result = await db.query(`SELECT d.id::text AS id,${SIZE_OF('d')}::text AS size_bytes FROM kb_documents d
        WHERE d.tenant_id=$1 AND d.kb_id=$2 AND d.type='file' AND d.status='learned'
        ORDER BY d.created_at,d.id LIMIT $3`, [tenantId, kbId, limit]);
      return result.rows.map(row => ({ id: String(row.id), size_bytes: whole(row.size_bytes, 'size_bytes') }));
    },

    /** Learned files the given draft did not read. */
    async unreadDocumentCount(tenantId: string, kbId: string, readIds: readonly string[]): Promise<number> {
      const result = await db.query<{ unread: string }>(`SELECT count(*)::text AS unread FROM kb_documents d
        WHERE d.tenant_id=$1 AND d.kb_id=$2 AND d.type='file' AND d.status='learned'
          AND NOT (d.id=ANY($3::uuid[]))`, [tenantId, kbId, [...readIds]]);
      return whole(result.rows[0]?.unread ?? '0', 'unread');
    },

    async readState(tenantId: string): Promise<OrgContextStateRow | null> {
      const result = await db.query(`SELECT ${STATE_COLUMNS},${NAME_OF('u')} AS confirmed_by_name
        FROM lesson_author_org_context_states s LEFT JOIN users u ON u.id=s.confirmed_by WHERE s.tenant_id=$1`, [tenantId]);
      return result.rows[0] ? stateRow(result.rows[0]) : null;
    },

    /** Creates the state row on the first change, then locks it for the caller's transaction. */
    async lockState(tenantId: string): Promise<OrgContextStateRow> {
      await db.query(`INSERT INTO lesson_author_org_context_states (tenant_id) VALUES ($1)
        ON CONFLICT (tenant_id) DO NOTHING`, [tenantId]);
      const result = await db.query(`SELECT ${STATE_COLUMNS},NULL::text AS confirmed_by_name
        FROM lesson_author_org_context_states s WHERE s.tenant_id=$1 FOR UPDATE OF s`, [tenantId]);
      return stateRow(result.rows[0] ?? rowInvalid('state'));
    },

    async readVersion(tenantId: string, version: number): Promise<OrgContextVersionRow | null> {
      const result = await db.query(`SELECT p.version,p.origin,p.profile,p.char_count,p.profile_hash,p.created_at,
          ${NAME_OF('u')} AS created_by_name
        FROM lesson_author_org_context_profiles p LEFT JOIN users u ON u.id=p.created_by
        WHERE p.tenant_id=$1 AND p.version=$2`, [tenantId, version]);
      return result.rows[0] ? versionRow(result.rows[0]) : null;
    },

    async history(tenantId: string, limit: number): Promise<OrgContextHistoryRow[]> {
      const result = await db.query(`SELECT p.version,p.origin,p.char_count,p.created_at,${NAME_OF('u')} AS created_by_name
        FROM lesson_author_org_context_profiles p LEFT JOIN users u ON u.id=p.created_by
        WHERE p.tenant_id=$1 ORDER BY p.version DESC LIMIT $2`, [tenantId, limit]);
      return result.rows.map(row => ({ version: whole(row.version, 'version'), origin: origin(row.origin),
        char_count: whole(row.char_count, 'char_count'), created_at: iso(row.created_at)!,
        created_by_name: text(row.created_by_name) }));
    },

    /** Source documents of the latest AI draft, or null when there is none. */
    async latestDraftSources(tenantId: string): Promise<string[] | null> {
      const result = await db.query<{ ids: string[] | null }>(`SELECT p.source_document_ids::text[] AS ids
        FROM lesson_author_org_context_profiles p WHERE p.tenant_id=$1 AND p.origin='ai_draft'
        ORDER BY p.version DESC LIMIT 1`, [tenantId]);
      if (!result.rows[0]) return null;
      return Array.isArray(result.rows[0].ids) ? result.rows[0].ids.map(String) : [];
    },

    /** Appends the next version (call with the state row locked: it serializes the numbering). */
    async insertVersion(tenantId: string, input: {
      origin: OrgContextProfileOrigin; profile: OrgContextProfileV1; profileHash: string; charCount: number;
      createdBy: string | null; sourceDocumentIds?: readonly string[]; sourceChars?: number; sourceTruncated?: boolean;
      restoredFromVersion?: number;
    }): Promise<number> {
      const result = await db.query<{ version: number }>(`INSERT INTO lesson_author_org_context_profiles
          (tenant_id,version,origin,profile,profile_hash,char_count,source_document_ids,source_chars,source_truncated,
           restored_from_version,created_by)
        SELECT $1::uuid,coalesce(max(p.version),0)+1,$2,$3::jsonb,$4,$5,$6::uuid[],$7::bigint,$8::boolean,$9::integer,$10::uuid
        FROM lesson_author_org_context_profiles p WHERE p.tenant_id=$1::uuid
        RETURNING version`, [tenantId, input.origin, JSON.stringify(input.profile), input.profileHash, input.charCount,
        input.sourceDocumentIds ? [...input.sourceDocumentIds] : null, input.sourceChars ?? null,
        input.sourceTruncated ?? null, input.restoredFromVersion ?? null, input.createdBy]);
      return whole(result.rows[0]?.version, 'version');
    },

    /** A profile change: current version (and, when asked, the confirmed one); bumps the revision. */
    async updateVersions(tenantId: string, input: { currentVersion: number; confirm: boolean; actorId: string }):
      Promise<{ revision: number; confirmed_version: number | null }> {
      const result = await db.query(`UPDATE lesson_author_org_context_states SET revision=revision+1,current_version=$2,
          confirmed_version=CASE WHEN $3::boolean THEN $2 ELSE confirmed_version END,
          confirmed_by=CASE WHEN $3::boolean THEN $4::uuid ELSE confirmed_by END,
          confirmed_at=CASE WHEN $3::boolean THEN now() ELSE confirmed_at END,
          updated_by=$4::uuid,updated_at=now()
        WHERE tenant_id=$1 RETURNING revision::text AS revision,confirmed_version`,
      [tenantId, input.currentVersion, input.confirm, input.actorId]);
      const row = result.rows[0] ?? rowInvalid('state');
      return { revision: whole(row.revision, 'revision'), confirmed_version: nullableWhole(row.confirmed_version, 'confirmed_version') };
    },

    /** Queues a profile draft (a change: bumps the revision; clears the previous attempt). */
    async queueDistill(tenantId: string, input: { locale: 'vi' | 'en'; actorId: string }): Promise<OrgContextStateRow> {
      const result = await db.query(`UPDATE lesson_author_org_context_states s SET revision=s.revision+1,
          distill_status='queued',distill_locale=$2,distill_requested_by=$3::uuid,distill_requested_at=now(),
          distill_lease_token=NULL,distill_lease_until=NULL,distill_attempts=0,distill_error_code=NULL,
          distill_finished_at=NULL,updated_by=$3::uuid,updated_at=now()
        WHERE s.tenant_id=$1 RETURNING ${STATE_COLUMNS},NULL::text AS confirmed_by_name`, [tenantId, input.locale, input.actorId]);
      return stateRow(result.rows[0] ?? rowInvalid('state'));
    },

    /** The confirmed version as the wire object, or null (FOR SHARE in a launch transaction). */
    async confirmedContext(tenantId: string, lock: boolean): Promise<{ version: number; profile: OrgContextProfileV1;
      profile_hash: string } | null> {
      const result = await db.query(`SELECT p.version,p.profile,p.profile_hash FROM lesson_author_org_context_states s
        JOIN lesson_author_org_context_profiles p ON p.tenant_id=s.tenant_id AND p.version=s.confirmed_version
        WHERE s.tenant_id=$1${lock ? ' FOR SHARE OF s' : ''}`, [tenantId]);
      const row = result.rows[0];
      if (!row) return null;
      return { version: whole(row.version, 'version'), profile: readOrgContextProfile(row.profile, 'profile', rowInvalid),
        profile_hash: typeof row.profile_hash === 'string' ? row.profile_hash : rowInvalid('profile_hash') };
    },
  };
}

export type OrgContextRepository = ReturnType<typeof createOrgContextRepository>;
