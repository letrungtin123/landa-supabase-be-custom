import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import {
  canManageLessonAuthorSession,
  LessonAuthorSessionError,
  lessonAuthorSessionOwnerName,
  lessonAuthorSessionPermissions,
  type LessonAuthorSessionPermissions,
  type LessonAuthorSessionScope,
} from './lesson-author-session-access.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_WORKSPACE_STATUSES = ['queued', 'designing', 'drafting'];
const DELETE_LEASE_SECONDS = 15 * 60;

/** The authenticated caller acting on the sessions of one course. */
export interface LessonAuthorSessionOwner {
  tenantId: string;
  userId: string;
  role: string;
  courseId: string;
}

export interface LessonAuthorSessionSummary {
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Session creator. Every course editor of the tenant sees every session. */
  owner: { user_id: string; display_name: string };
  is_mine: boolean;
  permissions: LessonAuthorSessionPermissions;
  workspace: null | {
    workspace_id: string;
    conversation_id: string;
    correlation_id: string;
    content_locale: 'vi' | 'en';
    status: string;
    /** Only the creator edits/continues; others open it read-only and may Apply. */
    can_edit: boolean;
  };
}

interface DeleteJobRow {
  id: string;
  tenant_id: string;
  course_id: string;
  conversation_id: string;
  requested_by: string;
  status: 'queued' | 'running' | 'failed' | 'succeeded';
  attempts: number;
  is_terminal: boolean;
}

function assertOwner(owner: LessonAuthorSessionOwner): void {
  if (!UUID.test(owner.tenantId) || !UUID.test(owner.userId) || !owner.courseId.trim()
    || owner.courseId.length > 255 || /[\x00-\x1f\x7f]/.test(owner.courseId)) {
    throw new LessonAuthorSessionError('INPUT_INVALID');
  }
}

/**
 * Creator of a session of this tenant/course. Another tenant's or another
 * course's conversation is simply not found (tenant isolation). `lock` takes
 * the conversation row lock when called inside a transaction.
 */
async function sessionCreator(owner: LessonAuthorSessionOwner, conversationId: string, lock = false): Promise<string> {
  const result = await query<{ owner_id: string }>(`SELECT c.user_id::text AS owner_id
    FROM chat_conversations c JOIN courses course ON course.id=c.course_id AND course.tenant_id=c.tenant_id AND course.deleted_at IS NULL
    WHERE c.id=$1::uuid AND c.tenant_id=$2::uuid AND c.course_id=$3 AND c.target='lesson_author'${lock ? ' FOR UPDATE OF c' : ''}`,
  [conversationId, owner.tenantId, owner.courseId]);
  const creator = result.rows[0]?.owner_id;
  if (result.rows.length !== 1 || typeof creator !== 'string') throw new LessonAuthorSessionError('NOT_FOUND');
  return creator;
}

function assertCanManage(owner: LessonAuthorSessionOwner, creatorId: string): void {
  if (!canManageLessonAuthorSession({ id: owner.userId, role: owner.role }, creatorId)) {
    throw new LessonAuthorSessionError('MANAGE_FORBIDDEN');
  }
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): [string, string] | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 512) throw new Error('too long');
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string'
      || !Number.isFinite(new Date(parsed[0]).getTime()) || typeof parsed[1] !== 'string' || !UUID.test(parsed[1])) throw new Error('invalid');
    // Keep the exact PostgreSQL text representation. Normalizing through a
    // JavaScript Date truncates microseconds and breaks keyset/optimistic
    // comparisons against timestamptz values stored with six-digit precision.
    return [parsed[0], parsed[1]];
  } catch {
    throw new LessonAuthorSessionError('CURSOR_INVALID');
  }
}

/** Startup gate for the manually installed durable deletion authority. */
export async function assertLessonAuthorSessionDeletionSchema(): Promise<void> {
  const result = await query<{ relation_ready: boolean; active_index_ready: boolean; recovery_index_ready: boolean;
    retention_index_ready: boolean; rls_enabled: boolean }>(`SELECT
      to_regclass('public.lesson_author_session_deletion_jobs') IS NOT NULL AS relation_ready,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='lesson_author_session_deletion_jobs'
        AND indexname='uq_la_session_delete_active') AS active_index_ready,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='lesson_author_session_deletion_jobs'
        AND indexname='idx_la_session_delete_recovery') AS recovery_index_ready,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='lesson_author_session_deletion_jobs'
        AND indexname='idx_la_session_delete_terminal_retention') AS retention_index_ready,
      COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.lesson_author_session_deletion_jobs')),false) AS rls_enabled`);
  const status = result.rows[0];
  if (!status || !Object.values(status).every(value => value === true)) {
    throw new Error('LESSON_AUTHOR_SESSION_DELETION_SCHEMA_NOT_READY');
  }
}

/**
 * Every session of the course for any course editor of the tenant (owner
 * decision 2026-10-09), newest first, with its creator. `scope=mine` narrows
 * to the caller's own sessions. Served by idx_chat_conversations_course_id;
 * sessions per course are bounded by the per-user conversation cap.
 */
export async function listLessonAuthorSessions(
  owner: LessonAuthorSessionOwner,
  options: { limit?: number; cursor?: string; scope?: LessonAuthorSessionScope } = {},
): Promise<{ items: LessonAuthorSessionSummary[]; next_cursor: string | null }> {
  assertOwner(owner);
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)));
  const cursor = decodeCursor(options.cursor);
  const result = await query<{
    conversation_id: string; title: string; created_at: Date | string; updated_at: string;
    owner_id: string; owner_full_name: string | null; owner_username: string | null;
    workspace_id: string | null; correlation_id: string | null; content_locale: 'vi' | 'en' | null; workspace_status: string | null;
  }>(`SELECT c.id::text AS conversation_id,c.title,c.created_at,c.updated_at::text AS updated_at,
      c.user_id::text AS owner_id,creator.full_name AS owner_full_name,creator.username AS owner_username,
      latest.id::text AS workspace_id,latest.correlation_id::text,latest.content_locale,latest.status AS workspace_status
    FROM chat_conversations c
    JOIN courses course ON course.id=c.course_id AND course.tenant_id=c.tenant_id AND course.deleted_at IS NULL
    JOIN tenant_bot_assignments assignment ON assignment.tenant_id=c.tenant_id AND assignment.bot_id=c.bot_id AND assignment.target='lesson_author'
    LEFT JOIN users creator ON creator.id=c.user_id
    LEFT JOIN LATERAL (
      SELECT w.id,w.correlation_id,w.content_locale,w.status
      FROM lesson_author_workspaces w
      WHERE w.tenant_id=c.tenant_id AND w.course_id=c.course_id AND w.requested_by=c.user_id
        AND w.conversation_id=c.id AND w.contract_version=1 AND w.engine='self_built_rag'
      ORDER BY w.created_at DESC,w.id DESC LIMIT 1
    ) latest ON true
    WHERE c.tenant_id=$1::uuid AND c.course_id=$3 AND c.target='lesson_author'
      AND ($7::boolean IS FALSE OR c.user_id=$2::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM lesson_author_session_deletion_jobs deletion
        WHERE deletion.tenant_id=c.tenant_id AND deletion.course_id=c.course_id AND deletion.conversation_id=c.id
          AND deletion.is_terminal=false AND deletion.status IN ('queued','running','failed')
      )
      AND ($4::timestamptz IS NULL OR (c.updated_at,c.id)<($4::timestamptz,$5::uuid))
    ORDER BY c.updated_at DESC,c.id DESC LIMIT $6`,
  [owner.tenantId, owner.userId, owner.courseId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1, options.scope === 'mine']);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const actor = { id: owner.userId, role: owner.role };
  const items = rows.map((row): LessonAuthorSessionSummary => {
    const permissions = lessonAuthorSessionPermissions(actor, row.owner_id);
    return {
      conversation_id: row.conversation_id,
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 200) : 'Bản thảo khóa học',
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at,
      owner: { user_id: row.owner_id, display_name: lessonAuthorSessionOwnerName(row.owner_full_name, row.owner_username) },
      is_mine: permissions.is_owner,
      permissions,
      workspace: row.workspace_id && row.correlation_id && row.content_locale && row.workspace_status ? {
        workspace_id: row.workspace_id,
        conversation_id: row.conversation_id,
        correlation_id: row.correlation_id,
        content_locale: row.content_locale,
        status: row.workspace_status,
        can_edit: permissions.can_continue,
      } : null,
    };
  });
  const last = rows.at(-1);
  return { items, next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.conversation_id) : null };
}

export async function renameLessonAuthorSession(
  owner: LessonAuthorSessionOwner,
  conversationId: string,
  title: string,
  expectedUpdatedAt?: string,
): Promise<{ conversation_id: string; title: string; updated_at: string }> {
  assertOwner(owner);
  const normalized = title.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!UUID.test(conversationId) || !normalized || normalized.length > 200
    || expectedUpdatedAt !== undefined && !Number.isFinite(new Date(expectedUpdatedAt).getTime())) {
    throw new LessonAuthorSessionError('INPUT_INVALID');
  }
  assertCanManage(owner, await sessionCreator(owner, conversationId));
  const result = await query<{ id: string; title: string; updated_at: string }>(`UPDATE chat_conversations c
    SET title=$4,updated_at=clock_timestamp()
    FROM courses course
    WHERE c.id=$3::uuid AND c.tenant_id=$1::uuid AND c.course_id=$2 AND c.target='lesson_author'
      AND course.id=c.course_id AND course.tenant_id=c.tenant_id AND course.deleted_at IS NULL
      AND ($5::timestamptz IS NULL OR c.updated_at=$5::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM lesson_author_session_deletion_jobs deletion
        WHERE deletion.tenant_id=c.tenant_id AND deletion.course_id=c.course_id
          AND deletion.conversation_id=c.id AND deletion.is_terminal=false AND deletion.status IN ('queued','running','failed'))
    RETURNING c.id::text,c.title,c.updated_at::text AS updated_at`,
  [owner.tenantId, owner.courseId, conversationId, normalized, expectedUpdatedAt ?? null]);
  const row = result.rows[0];
  if (!row) throw new LessonAuthorSessionError('CONFLICT');
  return { conversation_id: row.id, title: row.title, updated_at: row.updated_at };
}

export async function getLessonAuthorSessionDeleteImpact(owner: LessonAuthorSessionOwner, conversationId: string) {
  assertOwner(owner);
  if (!UUID.test(conversationId)) throw new LessonAuthorSessionError('INPUT_INVALID');
  assertCanManage(owner, await sessionCreator(owner, conversationId));
  const result = await query<{ total_nodes: number | string; applied_nodes: number | string; active: boolean }>(`SELECT
      COUNT(DISTINCT n.id)::int AS total_nodes,
      COUNT(DISTINCT m.node_id)::int AS applied_nodes,
      COALESCE(bool_or(w.status=ANY($4::text[])),false)
        OR EXISTS (SELECT 1 FROM lesson_author_generation_jobs g WHERE g.tenant_id=$1::uuid
          AND g.conversation_id=$3::uuid AND g.status IN ('queued','running')) AS active
    FROM chat_conversations c
    JOIN courses course ON course.id=c.course_id AND course.tenant_id=c.tenant_id AND course.deleted_at IS NULL
    LEFT JOIN lesson_author_workspaces w ON w.conversation_id=c.id AND w.tenant_id=c.tenant_id AND w.course_id=c.course_id
    LEFT JOIN lesson_author_workspace_nodes n ON n.workspace_id=w.id AND n.tenant_id=w.tenant_id AND n.course_id=w.course_id
    LEFT JOIN lesson_author_workspace_apply_mappings m ON m.workspace_id=n.workspace_id AND m.node_id=n.id
      AND m.tenant_id=n.tenant_id AND m.course_id=n.course_id
    WHERE c.tenant_id=$1::uuid AND c.course_id=$2 AND c.id=$3::uuid AND c.target='lesson_author'
    GROUP BY c.id`, [owner.tenantId, owner.courseId, conversationId, ACTIVE_WORKSPACE_STATUSES]);
  const row = result.rows[0];
  if (!row) throw new LessonAuthorSessionError('NOT_FOUND');
  const total = Number(row.total_nodes) || 0, applied = Math.min(total, Number(row.applied_nodes) || 0);
  return { conversation_id: conversationId, total_nodes: total, applied_nodes: applied, unapplied_nodes: total - applied, active: row.active === true };
}

async function publishSessionDelete(jobId: string): Promise<void> {
  try { await publish(QUEUES.LESSON_AUTHOR_SESSION_DELETE, { jobId }); }
  catch (error) { console.error('[LessonAuthorSessionDelete] publish failed', { job_id: jobId, error: error instanceof Error ? error.message : String(error) }); }
}

/**
 * The deletion job records the REQUESTER (`requested_by`); the worker deletes
 * the session of its creator. One active job per conversation regardless of
 * who asked: the conversation row lock serializes concurrent requests.
 */
export async function requestLessonAuthorSessionDeletion(owner: LessonAuthorSessionOwner, conversationId: string): Promise<{ job_id: string; replayed: boolean; creator_id: string }> {
  assertOwner(owner);
  if (!UUID.test(conversationId)) throw new LessonAuthorSessionError('INPUT_INVALID');
  const result = await withDatabaseTransaction(async tx => {
    const creatorId = await sessionCreator(owner, conversationId, true);
    assertCanManage(owner, creatorId);
    const existing = await tx.query<{ id: string }>(`SELECT id FROM lesson_author_session_deletion_jobs
      WHERE tenant_id=$1::uuid AND course_id=$2 AND conversation_id=$3::uuid
        AND is_terminal=false AND status IN ('queued','running','failed') ORDER BY requested_at,id LIMIT 1 FOR UPDATE`,
    [owner.tenantId, owner.courseId, conversationId]);
    if (existing.rows[0]) return { job_id: existing.rows[0].id, replayed: true, creator_id: creatorId };
    const active = await tx.query<{ active: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM lesson_author_workspaces w WHERE w.tenant_id=$1::uuid AND w.requested_by=$2::uuid
        AND w.course_id=$3 AND w.conversation_id=$4::uuid AND w.status=ANY($5::text[]))
      OR EXISTS (SELECT 1 FROM lesson_author_generation_jobs g WHERE g.tenant_id=$1::uuid
        AND g.conversation_id=$4::uuid AND g.status IN ('queued','running'))
      OR EXISTS (SELECT 1 FROM lesson_author_workspace_v2_tasks task JOIN lesson_author_workspace_v2_runs run ON run.id=task.run_id
        JOIN lesson_author_workspaces w ON w.id=run.workspace_id
        WHERE w.tenant_id=$1::uuid AND w.requested_by=$2::uuid AND w.course_id=$3 AND w.conversation_id=$4::uuid
          AND task.status IN ('blocked','queued','running')) AS active`,
    [owner.tenantId, creatorId, owner.courseId, conversationId, ACTIVE_WORKSPACE_STATUSES]);
    if (active.rows[0]?.active) throw new LessonAuthorSessionError('ACTIVE');
    const inserted = await tx.query<{ id: string }>(`INSERT INTO lesson_author_session_deletion_jobs
      (tenant_id,course_id,conversation_id,requested_by) VALUES ($1::uuid,$2,$3::uuid,$4::uuid) RETURNING id`,
    [owner.tenantId, owner.courseId, conversationId, owner.userId]);
    return { job_id: inserted.rows[0].id, replayed: false, creator_id: creatorId };
  });
  await publishSessionDelete(result.job_id);
  return result;
}

async function claimDeleteJob(jobId: string): Promise<DeleteJobRow | null> {
  const result = await query<DeleteJobRow>(`UPDATE lesson_author_session_deletion_jobs SET status='running',attempts=attempts+1,
      started_at=COALESCE(started_at,clock_timestamp()),lease_expires_at=clock_timestamp()+($2::int*interval '1 second'),updated_at=clock_timestamp()
    WHERE id=$1::uuid AND is_terminal=false AND next_attempt_at<=clock_timestamp()
      AND (status IN ('queued','failed') OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp())))
    RETURNING id,tenant_id,course_id,conversation_id,requested_by,status,attempts,is_terminal`, [jobId, DELETE_LEASE_SECONDS]);
  return result.rows[0] ?? null;
}

export async function runLessonAuthorSessionDeletion(jobId: string): Promise<void> {
  if (!UUID.test(jobId)) throw new Error('Invalid session deletion jobId');
  const job = await claimDeleteJob(jobId);
  if (!job) return;
  const heartbeat = setInterval(() => { void query(`UPDATE lesson_author_session_deletion_jobs
    SET lease_expires_at=clock_timestamp()+($2::int*interval '1 second'),updated_at=clock_timestamp()
    WHERE id=$1::uuid AND status='running' AND is_terminal=false`, [job.id, DELETE_LEASE_SECONDS]).catch(() => undefined); }, 60_000);
  heartbeat.unref();
  try {
    const stats = await withDatabaseTransaction(async tx => {
      // The requester may be an admin of the tenant; private session rows are
      // owned by the session creator, read from the locked conversation.
      const locked = await tx.query<{ creator_id: string }>(`SELECT c.user_id::text AS creator_id FROM chat_conversations c
        WHERE c.id=$1::uuid AND c.tenant_id=$2::uuid AND c.course_id=$3 AND c.target='lesson_author'
        FOR UPDATE`, [job.conversation_id, job.tenant_id, job.course_id]);
      const creatorId = locked.rows[0]?.creator_id;
      if (locked.rows.length === 0 || !creatorId) return { conversations_deleted: 0, blueprints_deleted: 0,
        workspaces_deleted: 0, nodes_deleted: 0, applied_course_blocks_preserved: 0 };
      const counts = await tx.query<{ blueprints: number | string; workspaces: number | string;
        nodes: number | string; course_blocks: number | string }>(`SELECT
        (SELECT COUNT(*)::int FROM lesson_author_blueprints b
          WHERE b.tenant_id=$1::uuid AND b.course_id=$2 AND b.requested_by=$3::uuid
            AND b.conversation_id=$4::uuid) AS blueprints,
        COUNT(DISTINCT w.id)::int AS workspaces,COUNT(DISTINCT n.id)::int AS nodes,
        COUNT(DISTINCT m.target_block_id)::int AS course_blocks
        FROM lesson_author_workspaces w
        LEFT JOIN lesson_author_workspace_nodes n ON n.workspace_id=w.id AND n.tenant_id=w.tenant_id AND n.course_id=w.course_id
        LEFT JOIN lesson_author_workspace_apply_mappings m ON m.workspace_id=n.workspace_id AND m.node_id=n.id
        WHERE w.tenant_id=$1::uuid AND w.course_id=$2 AND w.requested_by=$3::uuid AND w.conversation_id=$4::uuid`,
      [job.tenant_id, job.course_id, creatorId, job.conversation_id]);
      const row = counts.rows[0];
      // Blueprint's legacy FK is ON DELETE SET NULL, so delete the private
      // session artifact explicitly. Its dependent generation/workspace rows
      // cascade. Billing ledgers and other audit authorities intentionally
      // remain and only lose their conversation link through existing FKs.
      await tx.query(`DELETE FROM lesson_author_blueprints
        WHERE tenant_id=$1::uuid AND course_id=$2 AND requested_by=$3::uuid AND conversation_id=$4::uuid`,
      [job.tenant_id, job.course_id, creatorId, job.conversation_id]);
      // The conversation then cascades remaining private draft/runtime rows.
      // course_blocks have no FK to this lifecycle and are never touched.
      const deleted = await tx.query(`DELETE FROM chat_conversations WHERE id=$1::uuid AND tenant_id=$2::uuid AND user_id=$3::uuid AND course_id=$4`,
      [job.conversation_id, job.tenant_id, creatorId, job.course_id]);
      return { conversations_deleted: deleted.rowCount ?? 0, blueprints_deleted: Number(row?.blueprints) || 0,
        workspaces_deleted: Number(row?.workspaces) || 0,
        nodes_deleted: Number(row?.nodes) || 0, applied_course_blocks_preserved: Number(row?.course_blocks) || 0 };
    });
    await query(`UPDATE lesson_author_session_deletion_jobs SET status='succeeded',is_terminal=true,finished_at=clock_timestamp(),
      lease_expires_at=NULL,last_error=NULL,stats=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1::uuid`, [job.id, JSON.stringify(stats)]);
  } finally { clearInterval(heartbeat); }
}

export async function markLessonAuthorSessionDeletionRetryable(jobId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  await query(`UPDATE lesson_author_session_deletion_jobs SET
      status=CASE WHEN attempts >= $2::int THEN 'failed' ELSE 'queued' END,
      is_terminal=attempts >= $2::int,lease_expires_at=NULL,
      next_attempt_at=CASE WHEN attempts >= $2::int THEN clock_timestamp()
        ELSE clock_timestamp()+(LEAST($3::numeric*power(2::numeric,GREATEST(attempts-1,0)),$4::numeric)*interval '1 millisecond') END,
      last_error=$5,updated_at=clock_timestamp(),finished_at=CASE WHEN attempts >= $2::int THEN clock_timestamp() ELSE NULL END
    WHERE id=$1::uuid AND status='running'`, [jobId, env.DELETION_MAX_ATTEMPTS, env.DELETION_RETRY_BASE_MS, env.DELETION_RETRY_MAX_MS, message]);
}

export async function requeueLessonAuthorSessionDeletionJobs(limit = 100): Promise<void> {
  const table = await query<{ exists: boolean }>(`SELECT to_regclass('public.lesson_author_session_deletion_jobs') IS NOT NULL AS exists`);
  if (!table.rows[0]?.exists) return;
  const jobs = await query<{ id: string }>(`SELECT id FROM lesson_author_session_deletion_jobs
    WHERE is_terminal=false AND ((status IN ('queued','failed') AND next_attempt_at<=clock_timestamp())
      OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp())))
    ORDER BY requested_at,id LIMIT $1`, [Math.min(500, Math.max(1, limit))]);
  for (const job of jobs.rows) await publishSessionDelete(job.id);
}

/** The person who asked for the deletion follows its status. */
export async function getLessonAuthorSessionDeletionStatus(owner: LessonAuthorSessionOwner, jobId: string) {
  assertOwner(owner);
  if (!UUID.test(jobId)) throw new LessonAuthorSessionError('INPUT_INVALID');
  const result = await query(`SELECT id,status,attempts,is_terminal,requested_at,started_at,finished_at,next_attempt_at,last_error,stats
    FROM lesson_author_session_deletion_jobs WHERE id=$1::uuid AND tenant_id=$2::uuid AND requested_by=$3::uuid AND course_id=$4`,
  [jobId, owner.tenantId, owner.userId, owner.courseId]);
  if (!result.rows[0]) throw new LessonAuthorSessionError('DELETE_NOT_FOUND');
  return result.rows[0];
}
