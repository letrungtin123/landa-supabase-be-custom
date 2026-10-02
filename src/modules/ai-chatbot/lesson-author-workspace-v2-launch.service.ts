import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../../types/express.js';
import type { AppError as AppErrorType } from '../../middleware/error-handler.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceLaunchInput, WorkspaceLaunchResult } from './lesson-author-workspace-launch.controller.js';
import type { prepareDurableBlueprint, withLessonAuthorConversationLock } from './chat.service.js';
import type { OrchestrationV2AdmissionReceipt } from './lesson-author-orchestration-v2-admission.repository.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
type ExistingWorkspace = {
  id: string;
  conversation_id: string;
  correlation_id: string;
  content_locale: 'en' | 'vi';
  status: string;
  request_hash: string;
  source_document_ids: string[];
};

export interface WorkspaceV2LaunchDependencies {
  query: Query;
  db: GenerationJobDatabase;
  AppError: typeof AppErrorType;
  prepareDurableBlueprint: typeof prepareDurableBlueprint;
  withLessonAuthorConversationLock: typeof withLessonAuthorConversationLock;
  admit(user: AuthUser, target: {
    workspaceId: string;
    tenantId: string;
    courseId: string;
    conversationId: string;
    userId: string;
  }): Promise<OrchestrationV2AdmissionReceipt>;
  id?: () => string;
  report?(event: Record<string, unknown>): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

function sameIds(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Server-owned V2 launch. The public workspace Create request stays unchanged:
 * workspace shell and the first durable V2 task/outbox row commit atomically.
 * No V1 generation job, whole-course token reservation or provider call occurs.
 */
export function createWorkspaceV2LaunchService(deps: WorkspaceV2LaunchDependencies) {
  const id = deps.id ?? randomUUID;
  const fail = (code: string, status = 409): never => {
    throw new deps.AppError('Workspace operation could not be completed.', status, code);
  };
  const report = (event: Record<string, unknown>) => { try { deps.report?.(event); } catch { /* diagnostics never decide commits */ } };

  async function findReplay(tenantId: string, userId: string, input: WorkspaceLaunchInput): Promise<ExistingWorkspace | null> {
    const found = await deps.query(`SELECT id::text,conversation_id::text,correlation_id::text,content_locale,status,request_hash,source_document_ids
      FROM lesson_author_workspaces
      WHERE tenant_id=$1 AND course_id=$2 AND conversation_id=$3 AND requested_by=$4 AND idempotency_key=$5
        AND contract_version=1 AND engine='self_built_rag'`,
    [tenantId, input.courseId, input.conversationId, userId, input.operationId]);
    if (found.rows.length > 1) fail('WORKSPACE_CREATE_CONFLICT');
    return (found.rows[0] as ExistingWorkspace | undefined) ?? null;
  }

  function validInput(user: AuthUser, input: WorkspaceLaunchInput): user is AuthUser & { tenantId: string } {
    return user.sessionMode === 'normal' && typeof user.tenantId === 'string'
      && ['staff', 'superuser', 'superadmin'].includes(user.role)
      && [user.id, user.tenantId, input.conversationId, input.operationId].every(value => UUID.test(value))
      && typeof input.courseId === 'string' && input.courseId.trim().length > 0 && input.courseId.length <= 255
      && !/[\x00-\x1f\x7f]/.test(input.courseId)
      && input.sourceDocumentIds.length >= 1 && input.sourceDocumentIds.length <= 5
      && input.sourceDocumentIds.every(value => UUID.test(value))
      && new Set(input.sourceDocumentIds).size === input.sourceDocumentIds.length
      && ['en', 'vi'].includes(input.locale);
  }

  return async function launch(user: AuthUser, input: WorkspaceLaunchInput): Promise<WorkspaceLaunchResult> {
    if (!validInput(user, input)) fail('WORKSPACE_CREATE_INPUT_INVALID', 400);
    const tenantId = user.tenantId!;
    const content = input.locale === 'en'
      ? 'Create lesson content from the selected documents.'
      : 'Tạo nội dung bài học từ tài liệu đã chọn.';

    return deps.withLessonAuthorConversationLock(input.conversationId, async () => {
      const replay = await findReplay(tenantId, user.id, input);
      const candidate = await deps.prepareDurableBlueprint(input.conversationId, user.id, tenantId, content, {
        target: 'lesson_author', courseId: input.courseId, mode: 'course_blueprint', locale: input.locale,
        sourceDocuments: input.sourceDocumentIds.map(document_id => ({ document_id })),
      }, replay ? { source_document_ids: replay.source_document_ids, user_message_id: null } : undefined);
      if (!candidate) fail('WORKSPACE_ENGINE_UNSUPPORTED');
      const prepared = candidate!;
      if (!replay) await prepared.filterInput();

      const root = replay?.correlation_id ?? id();
      if (!UUID.test(root)) fail('WORKSPACE_CREATE_CONFLICT');
      let admittedRunId: string | null = null;
      const result = await deps.db.transaction(async (tx: GenerationJobSql) => {
        const authority = createWorkspaceAuthority(user);
        const target = { tenantId, userId: user.id, conversationId: input.conversationId,
          courseId: input.courseId, workspaceId: replay?.id ?? input.operationId };
        const course = await tx.query('SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE',
          [input.courseId, tenantId]);
        if (course.rows.length !== 1 || !await authority.canEdit(tx, target)) fail('WORKSPACE_RUNTIME_FORBIDDEN', 403);
        const active = await tx.query(`SELECT id FROM lesson_author_workspaces
          WHERE tenant_id=$1 AND course_id=$2 AND requested_by=$3
            AND status IN ('queued','designing','drafting') AND idempotency_key<>$4 FOR UPDATE`,
        [tenantId, input.courseId, user.id, input.operationId]);
        if (active.rows.length) fail('WORKSPACE_ALREADY_ACTIVE');

        const locked = await tx.query(`SELECT id::text,conversation_id::text,correlation_id::text,content_locale,status,request_hash,source_document_ids
          FROM lesson_author_workspaces
          WHERE tenant_id=$1 AND course_id=$2 AND conversation_id=$3 AND requested_by=$4 AND idempotency_key=$5
            AND contract_version=1 AND engine='self_built_rag' FOR UPDATE`,
        [tenantId, input.courseId, input.conversationId, user.id, input.operationId]);
        if (locked.rows.length > 1) fail('WORKSPACE_CREATE_CONFLICT');
        let workspace = locked.rows[0] as ExistingWorkspace | undefined;
        let replayed = true;
        if (workspace) {
          if (workspace.correlation_id !== root || workspace.request_hash !== prepared.identity.requestHash
            || workspace.content_locale !== input.locale
            || !sameIds(workspace.source_document_ids, prepared.identity.sourceDocumentIds)) fail('WORKSPACE_CREATE_CONFLICT');
        } else {
          replayed = false;
          const workspaceId = id();
          if (!UUID.test(workspaceId) || !HASH.test(prepared.identity.requestHash)
            || !HASH.test(prepared.identity.sourceSnapshotHash)) fail('WORKSPACE_CREATE_CONFLICT');
          const inserted = await tx.query(`INSERT INTO lesson_author_workspaces(id,tenant_id,course_id,conversation_id,requested_by,bot_id,kb_id,
              content_locale,correlation_id,idempotency_key,request_hash,source_snapshot_hash,source_document_ids,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid[],'queued')
            RETURNING id::text,conversation_id::text,correlation_id::text,content_locale,status,request_hash,source_document_ids`,
          [workspaceId, tenantId, input.courseId, input.conversationId, user.id, prepared.identity.botId,
            prepared.identity.kbId, input.locale, root, input.operationId, prepared.identity.requestHash,
            prepared.identity.sourceSnapshotHash, prepared.identity.sourceDocumentIds]);
          workspace = inserted.rows[0] as ExistingWorkspace | undefined;
          if (!workspace || workspace.id !== workspaceId || workspace.status !== 'queued') fail('WORKSPACE_CREATE_CONFLICT');
          // The installed workspace guard requires every shell to start queued.
          // Advance it with the same guarded state transition as V1 before V2
          // admission validates the workspace. The surrounding transaction keeps
          // the shell, event and V2 bootstrap evidence all-or-nothing.
          const designing = await tx.query(`UPDATE lesson_author_workspaces SET status='designing'
            WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status='queued'
            RETURNING id::text,conversation_id::text,correlation_id::text,content_locale,status,request_hash,source_document_ids`,
          [workspaceId, tenantId, input.courseId]);
          workspace = designing.rows[0] as ExistingWorkspace | undefined;
          if (designing.rows.length !== 1 || !workspace || workspace.id !== workspaceId
            || workspace.status !== 'designing') fail('WORKSPACE_CREATE_CONFLICT');
          const event = await tx.query(`INSERT INTO lesson_author_workspace_events(workspace_id,tenant_id,course_id,event_kind,operation_id)
            VALUES($1,$2,$3,'architecture_started',$4) RETURNING sequence`,
          [workspaceId, tenantId, input.courseId, input.operationId]);
          if (event.rows.length !== 1) fail('WORKSPACE_CREATE_CONFLICT');
        }

        const confirmedWorkspace = workspace!;
        const existingRun = await tx.query(`SELECT id::text FROM lesson_author_workspace_v2_runs
          WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 FOR UPDATE`, [confirmedWorkspace.id, tenantId, input.courseId]);
        if (existingRun.rows.length > 1) fail('WORKSPACE_CREATE_CONFLICT');
        if (existingRun.rows[0]?.id) {
          if (!UUID.test(String(existingRun.rows[0].id))) fail('WORKSPACE_CREATE_CONFLICT');
          admittedRunId = String(existingRun.rows[0].id);
        } else {
          // Atomic V2 creation cannot leave a shell without its run. Refuse to
          // take over a pre-existing V1 workspace after a rollout-mode change.
          if (replayed) fail('WORKSPACE_CREATE_CONFLICT');
          if (!['designing', 'needs_action'].includes(confirmedWorkspace.status)) fail('WORKSPACE_CREATE_CONFLICT');
          const admitted = await deps.admit(user, { workspaceId: confirmedWorkspace.id, tenantId, courseId: input.courseId,
            conversationId: input.conversationId, userId: user.id });
          admittedRunId = admitted.run_id;
        }
        return { workspace_id: confirmedWorkspace.id, conversation_id: confirmedWorkspace.conversation_id,
          correlation_id: confirmedWorkspace.correlation_id, content_locale: confirmedWorkspace.content_locale,
          status: confirmedWorkspace.status, replayed } satisfies WorkspaceLaunchResult;
      });
      if (!result.replayed) prepared.markAccepted();
      report({ event: 'workspace_v2_launch_admitted', workspace_id: result.workspace_id,
        correlation_id: result.correlation_id, run_id: admittedRunId, replayed: result.replayed });
      return result;
    });
  };
}
