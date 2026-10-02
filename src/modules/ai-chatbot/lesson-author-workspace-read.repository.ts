import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import {
  readWorkspaceContent, workspaceEventCursor, workspaceLocale,
  WORKSPACE_CONTRACT_VERSION, WORKSPACE_EVENT_PAGE_SIZE, WorkspaceContractError,
} from './lesson-author-workspace.logic.js';

export interface WorkspaceReadOwner {
  tenantId: string;
  userId: string;
  conversationId: string;
  courseId: string;
}
export type WorkspaceReadCode = 'WORKSPACE_READ_FORBIDDEN' | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NODE_NOT_FOUND' | 'WORKSPACE_READ_UNAVAILABLE' | 'WORKSPACE_READ_CONTRACT_INVALID';
export class WorkspaceReadError extends Error {
  constructor(readonly code: WorkspaceReadCode) { super(code); this.name = 'WorkspaceReadError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ['queued', 'designing', 'drafting', 'ready', 'needs_action', 'failed', 'canceled'] as const;
const KINDS = ['course', 'chapter', 'lesson', 'unit', 'component', 'media_brief'] as const;
const CONTENT_STATES = ['planned', 'generating', 'content_ready', 'needs_action'] as const;
const COMPONENT_TYPES = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;
const MEDIA_TYPES = ['video', 'static_infographic'] as const;
const FAILURE_STAGES = ['source_snapshot', 'course_skeleton', 'chapter_blueprint', 'validate_architecture',
  'publish_inventory', 'generate_unit', 'validate_chapter', 'finalize_course'] as const;
export const WORKSPACE_GRAPH_PAGE_SIZE = 100;
const EVENTS = ['workspace_created', 'architecture_started', 'overview_ready', 'structure_ready',
  'unit_started', 'unit_ready', 'node_revision_saved', 'node_reset', 'scope_apply_started',
  'scope_applied', 'run_needs_action', 'run_ready', 'run_failed', 'run_canceled'] as const;

// One SELECT statement per read: ownership, payload/counts and cursor share the
// same PostgreSQL statement snapshot, without locking a running worker.
const OWNED = `WITH owned AS (
  SELECT w.id,w.tenant_id,w.course_id,w.conversation_id,w.correlation_id,w.contract_version,
    w.content_locale,w.status,w.event_head,w.updated_at
  FROM lesson_author_workspaces w
  JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id
    AND c.user_id=w.requested_by AND c.course_id=w.course_id AND c.bot_id=w.bot_id
    AND c.target='lesson_author'
  JOIN courses course ON course.id=w.course_id AND course.tenant_id=w.tenant_id AND course.deleted_at IS NULL
  JOIN chatbots bot ON bot.id=w.bot_id AND bot.tenant_id=w.tenant_id
  JOIN knowledgebases kb ON kb.id=w.kb_id AND kb.tenant_id=w.tenant_id
  WHERE w.id=$1 AND w.tenant_id=$2 AND w.conversation_id=$3 AND w.requested_by=$4 AND w.course_id=$5
    AND EXISTS (SELECT 1 FROM tenant_bot_assignments a WHERE a.tenant_id=w.tenant_id
      AND a.target='lesson_author' AND a.bot_id=w.bot_id)
    AND EXISTS (SELECT 1 FROM tenant_kb_assignments a WHERE a.tenant_id=w.tenant_id
      AND a.target='lesson_author' AND a.kb_id=w.kb_id)
    AND cardinality(w.source_document_ids)=(SELECT count(DISTINCT d.id) FROM kb_documents d
      WHERE d.id=ANY(w.source_document_ids) AND d.tenant_id=w.tenant_id AND d.kb_id=w.kb_id)
)`;

function invalid(): never { throw new WorkspaceReadError('WORKSPACE_READ_CONTRACT_INVALID'); }
function integer(value: unknown): number {
  // pg returns BIGINT as strings; never round unsafe cursor/revision values.
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) invalid();
  return number;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid();
  return value as T;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') invalid();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) invalid();
  return date.toISOString();
}
function workspace(row: Record<string, unknown>) {
  if (row.contract_version !== WORKSPACE_CONTRACT_VERSION) invalid();
  return {
    workspace_id: id(row.id), contract_version: WORKSPACE_CONTRACT_VERSION,
    correlation_id: id(row.correlation_id), content_locale: workspaceLocale(row.content_locale),
    status: enumeration(row.status, STATES), last_event_sequence: integer(row.event_head),
    updated_at: timestamp(row.updated_at),
  };
}

/** Connection-free read boundary: no worker, write or provider on import.
 * canRead MUST reuse current course RBAC/editor access, on EVERY read. The
 * HTTP adapter supplies authenticated identity (never accepts owner fields from a
 * request body), feature gate, no-store and locale-aware code rendering.
 * SQL joins add current ownership/assignment/source-existence checks; they do NOT
 * certify source-content freshness or authorize generation/Save/Reset/Apply.
 */
export function createWorkspaceReadRepository(deps: {
  db: GenerationJobSql;
  canRead: (owner: Readonly<WorkspaceReadOwner>) => Promise<boolean>;
}) {
  async function read(owner: WorkspaceReadOwner, workspaceId: string, suffix: string, extra: unknown[] = []) {
    const scope = Object.freeze({ ...owner });
    if (![workspaceId, scope.tenantId, scope.userId, scope.conversationId].every(value => UUID.test(value))
      || typeof scope.courseId !== 'string' || !scope.courseId || scope.courseId.length > 255) invalid();
    try {
      if (!await deps.canRead(scope)) throw new WorkspaceReadError('WORKSPACE_READ_FORBIDDEN');
      const { rows } = await deps.db.query(OWNED + suffix,
        [workspaceId, scope.tenantId, scope.conversationId, scope.userId, scope.courseId, ...extra]);
      if (!rows.length) throw new WorkspaceReadError('WORKSPACE_NOT_FOUND');
      if (rows.length !== 1) invalid();
      return rows[0];
    } catch (error) {
      if (error instanceof WorkspaceReadError) throw error;
      // Never surface raw SQL, credentials or private content in exception messages.
      throw new WorkspaceReadError('WORKSPACE_READ_UNAVAILABLE');
    }
  }
  return {
    /** Keyset-paged metadata snapshot. Pages must use the first page's sequence;
     * a concurrent commit requires restarting the snapshot, never mixing trees.
     * Inventory is invisible until structure_ready seals it. No payload fetch.
     */
    async graph(owner: WorkspaceReadOwner, workspaceId: string,
      cursor: { snapshot_sequence?: number; after_node_id?: string } = {}) {
      if (cursor.after_node_id !== undefined) id(cursor.after_node_id);
      if ((cursor.snapshot_sequence !== undefined && (!Number.isSafeInteger(cursor.snapshot_sequence) || cursor.snapshot_sequence < 0))
        || (cursor.after_node_id !== undefined && cursor.snapshot_sequence === undefined)) invalid();
      const row = await read(owner, workspaceId, `
        , visible AS (SELECT w.*,
          EXISTS (SELECT 1 FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id AND e.event_kind='overview_ready') AS overview_ready,
          EXISTS (SELECT 1 FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id AND e.event_kind='structure_ready') AS structure_ready
          FROM owned w)
        SELECT w.*,
          (SELECT count(*) FROM lesson_author_workspace_nodes n WHERE n.workspace_id=w.id AND w.structure_ready
            AND (n.kind IN ('course','chapter','lesson') OR n.content_state='content_ready')) AS graph_node_count,
          ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM lesson_author_workspace_nodes n WHERE n.workspace_id=w.id AND n.id=$6)) AS cursor_exists,
          COALESCE((SELECT jsonb_agg(page ORDER BY page.node_id) FROM (
            SELECT n.id AS node_id,n.parent_id,n.kind,n.canonical_path,n.sort_order,n.content_state,n.current_revision,
              CASE WHEN n.kind='component' THEN n.protected_contract->>'component_type' END AS component_type,
              CASE WHEN n.kind='media_brief' THEN n.protected_contract->>'media_type' END AS media_type,
              CASE WHEN n.current_revision IS NULL THEN n.protected_contract->>'display_title' ELSE r.content->>'title' END AS title,
              COALESCE(r.user_modified,false) AS user_modified,
              EXISTS (SELECT 1 FROM lesson_author_workspace_apply_mappings m
                WHERE m.workspace_id=n.workspace_id AND m.node_id=n.id
                  AND m.tenant_id=n.tenant_id AND m.course_id=n.course_id
                  AND m.applied_revision=n.current_revision
                  AND m.applied_content_hash=r.content_hash) AS applied
            FROM lesson_author_workspace_nodes n LEFT JOIN lesson_author_workspace_revisions r
              ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=n.current_revision
            WHERE n.workspace_id=w.id AND n.tenant_id=w.tenant_id AND n.course_id=w.course_id AND w.structure_ready
              AND (n.kind IN ('course','chapter','lesson') OR n.content_state='content_ready')
              AND ($6::uuid IS NULL OR n.id>$6) AND ($7::bigint IS NULL OR w.event_head=$7)
            ORDER BY n.id LIMIT $8
          ) page),'[]'::jsonb) AS nodes FROM visible w`,
      [cursor.after_node_id ?? null, cursor.snapshot_sequence ?? null, WORKSPACE_GRAPH_PAGE_SIZE + 1]);
      const view = workspace(row);
      if ((cursor.snapshot_sequence !== undefined && view.last_event_sequence !== cursor.snapshot_sequence) || row.cursor_exists !== true) {
        throw new WorkspaceContractError('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
      }
      if (typeof row.overview_ready !== 'boolean' || typeof row.structure_ready !== 'boolean'
        || (row.structure_ready && !row.overview_ready) || !Array.isArray(row.nodes)
        || row.nodes.length > WORKSPACE_GRAPH_PAGE_SIZE + 1) invalid();
      const total = integer(row.graph_node_count);
      if ((!row.structure_ready && (row.nodes.length || total)) || (row.structure_ready && total === 0)
        || (!cursor.after_node_id && row.nodes.length !== Math.min(total, WORKSPACE_GRAPH_PAGE_SIZE + 1))) invalid();
      let previousId = cursor.after_node_id?.toLowerCase() ?? '';
      const parsed = row.nodes.map(value => {
        const node = record(value), nodeId = id(node.node_id).toLowerCase();
        if (nodeId <= previousId) invalid();
        previousId = nodeId;
        const kind = enumeration(node.kind, KINDS), state = enumeration(node.content_state, CONTENT_STATES);
        const componentType = node.component_type === null ? null : enumeration(node.component_type, COMPONENT_TYPES);
        const mediaType = node.media_type === null ? null : enumeration(node.media_type, MEDIA_TYPES);
        const parentId = node.parent_id === null ? null : id(node.parent_id);
        const revision = node.current_revision === null ? null : integer(node.current_revision);
        if ((kind === 'course') !== (parentId === null) || parentId === nodeId
          || (state === 'content_ready') !== (revision !== null)
          || typeof node.canonical_path !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,239}$/.test(node.canonical_path)
          || typeof node.user_modified !== 'boolean' || (revision === null && node.user_modified)
          || typeof node.applied !== 'boolean' || (revision === null && node.applied)
          || (kind === 'component') !== (componentType !== null)
          || (kind === 'media_brief') !== (mediaType !== null)
          || (node.title !== null && (typeof node.title !== 'string' || !node.title.trim() || node.title.length > 500))
          || (revision !== null && node.title === null)) invalid();
        return { node_id: nodeId, parent_id: parentId, kind, canonical_path: node.canonical_path,
          sort_order: integer(node.sort_order), content_state: state, current_revision: revision,
          component_type: componentType, media_type: mediaType, title: node.title as string | null,
          user_modified: node.user_modified, applied: node.applied };
      });
      const hasMore = parsed.length > WORKSPACE_GRAPH_PAGE_SIZE;
      const nodes = parsed.slice(0, WORKSPACE_GRAPH_PAGE_SIZE);
      return { ...view, snapshot_sequence: view.last_event_sequence, overview_ready: row.overview_ready,
        structure_ready: row.structure_ready, total_nodes: total, nodes, has_more: hasMore,
        next_after_node_id: hasMore ? nodes.at(-1)!.node_id : null };
    },
    /** Summary only, NOT the graph resnapshot or an Apply-readiness certificate. */
    async status(owner: WorkspaceReadOwner, workspaceId: string) {
      const row = await read(owner, workspaceId, `
        SELECT w.*,
          CASE WHEN failure.run_status IN ('needs_action','failed','canceled')
              AND w.status IN ('queued','designing','drafting') THEN failure.run_status ELSE w.status END AS status,
          (SELECT count(*) FROM lesson_author_workspace_nodes n WHERE n.workspace_id=w.id) AS node_count,
          (SELECT count(*) FROM lesson_author_workspace_nodes n WHERE n.workspace_id=w.id AND n.kind='unit') AS unit_count,
          (SELECT count(*) FROM lesson_author_workspace_nodes n WHERE n.workspace_id=w.id
            AND n.kind='unit' AND n.content_state='content_ready') AS ready_unit_count,
          failure.failure_code,failure.failure_stage,failure.failure_chapter_key
        FROM owned w LEFT JOIN LATERAL (
          SELECT run.status::text AS run_status,coalesce(task.failure_code,run.failure_code) AS failure_code,
            task.kind::text AS failure_stage,task.chapter_key AS failure_chapter_key
          FROM lesson_author_workspace_v2_runs run
          LEFT JOIN LATERAL (
            SELECT candidate.failure_code,candidate.kind,candidate.chapter_key
            FROM lesson_author_workspace_v2_tasks candidate
            WHERE candidate.run_id=run.id
              AND (candidate.status IN ('failed','timed_out','outcome_unknown') OR candidate.attempt_count>0)
            ORDER BY CASE WHEN candidate.status IN ('failed','timed_out','outcome_unknown') THEN 0 ELSE 1 END,
              CASE WHEN candidate.failure_code=run.failure_code THEN 0 ELSE 1 END,
              candidate.finished_at DESC NULLS LAST,candidate.ordinal,candidate.id LIMIT 1
          ) task ON true
          WHERE run.workspace_id=w.id AND run.tenant_id=w.tenant_id AND run.course_id=w.course_id
            AND run.status IN ('needs_action','failed','canceled')
          ORDER BY run.created_at DESC,run.id DESC LIMIT 1
        ) failure ON true`);
      const total = integer(row.node_count), units = integer(row.unit_count), ready = integer(row.ready_unit_count);
      if (ready > units || units > total) invalid();
      const failureCode = row.failure_code === null || row.failure_code === undefined ? null
        : typeof row.failure_code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(row.failure_code) ? row.failure_code : invalid();
      const failureStage = row.failure_stage === null || row.failure_stage === undefined ? null
        : enumeration(row.failure_stage, FAILURE_STAGES);
      const failureChapterKey = row.failure_chapter_key === null || row.failure_chapter_key === undefined ? null
        : typeof row.failure_chapter_key === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(row.failure_chapter_key)
          ? row.failure_chapter_key : invalid();
      if (!failureCode && (failureStage || failureChapterKey) || !failureStage && failureChapterKey) invalid();
      return { ...workspace(row), node_count: total, unit_count: units, ready_unit_count: ready,
        failure_code: failureCode, failure_stage: failureStage, failure_chapter_key: failureChapterKey };
    },

    async events(owner: WorkspaceReadOwner, workspaceId: string, afterSequence: number) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new WorkspaceContractError('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
      }
      const row = await read(owner, workspaceId, `
        SELECT w.*, (SELECT min(e.sequence) FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id) AS first_sequence,
          COALESCE((SELECT jsonb_agg(page ORDER BY page.sequence) FROM (
            SELECT e.sequence,e.event_kind,e.node_id,e.node_revision,e.operation_id,e.created_at
            FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id AND e.sequence>$6
              AND e.sequence<=w.event_head ORDER BY e.sequence LIMIT $7
          ) page),'[]'::jsonb) AS events FROM owned w`, [afterSequence, WORKSPACE_EVENT_PAGE_SIZE]);
      const view = workspace(row);
      const first = row.first_sequence === null ? view.last_event_sequence + 1 : integer(row.first_sequence);
      workspaceEventCursor(afterSequence, first, view.last_event_sequence);
      if (!Array.isArray(row.events) || row.events.length > WORKSPACE_EVENT_PAGE_SIZE) invalid();
      const events = row.events.map((value, index) => {
        const event = record(value), sequence = integer(event.sequence);
        if (sequence !== afterSequence + index + 1 || sequence > view.last_event_sequence) {
          throw new WorkspaceContractError('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
        }
        const nodeId = event.node_id === null ? null : id(event.node_id);
        const revision = event.node_revision === null ? null : integer(event.node_revision);
        const kind = enumeration(event.event_kind, EVENTS);
        if ((revision !== null && nodeId === null)
          || (['node_revision_saved', 'node_reset'].includes(kind) && (revision === null || nodeId === null))) invalid();
        return { sequence, event_kind: kind, node_id: nodeId, node_revision: revision,
          operation_id: id(event.operation_id), created_at: timestamp(event.created_at) };
      });
      // Missing middle or tail records must not silently advance the client cursor.
      if (events.length !== Math.min(WORKSPACE_EVENT_PAGE_SIZE, view.last_event_sequence - afterSequence)) {
        throw new WorkspaceContractError('WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
      }
      const next = events.at(-1)?.sequence ?? afterSequence;
      return { ...view, events, next_sequence: next, has_more: next < view.last_event_sequence };
    },

    async detail(owner: WorkspaceReadOwner, workspaceId: string, nodeId: string, expectedRevision: number | null) {
      id(nodeId);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) invalid();
      const row = await read(owner, workspaceId, `
        SELECT w.*, n.id AS node_id,n.parent_id,n.kind,n.content_state,n.current_revision,
          CASE WHEN n.kind='component' THEN n.protected_contract->>'component_type' END AS component_type,
          CASE WHEN n.kind='component' THEN n.protected_contract->'metadata'->'author_review' END AS author_review,
          CASE WHEN n.kind='media_brief' THEN n.protected_contract->>'media_type' END AS media_type,
          r.content,r.content_hash,r.user_modified,r.validation_contract
        FROM owned w LEFT JOIN lesson_author_workspace_nodes n ON n.workspace_id=w.id
          AND n.tenant_id=w.tenant_id AND n.course_id=w.course_id AND n.id=$6
        LEFT JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id
          AND r.node_id=n.id AND r.tenant_id=n.tenant_id AND r.course_id=n.course_id AND r.revision=n.current_revision`, [nodeId]);
      if (row.node_id === null) throw new WorkspaceReadError('WORKSPACE_NODE_NOT_FOUND');
      const revision = row.current_revision === null ? null : integer(row.current_revision);
      if (revision !== expectedRevision) throw new WorkspaceContractError('WORKSPACE_REVISION_CONFLICT');
      const state = enumeration(row.content_state, CONTENT_STATES);
      if ((state === 'content_ready') !== (revision !== null)) invalid();
      let content = null;
      if (revision !== null) {
        content = readWorkspaceContent(row.content);
        if (generationSnapshotHash(content) !== row.content_hash || typeof row.user_modified !== 'boolean'
          || typeof row.validation_contract !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(row.validation_contract)) invalid();
      } else if (row.content !== null || row.content_hash !== null) invalid();
      const componentType = row.component_type == null ? null : enumeration(row.component_type, COMPONENT_TYPES);
      const mediaType = row.media_type == null ? null : enumeration(row.media_type, MEDIA_TYPES);
      if ((componentType && row.kind !== 'component') || (mediaType && row.kind !== 'media_brief')) invalid();
      type AuthorReview = { purpose: string | null; example_scenario: string | null;
        visual_asset: string | null; user_behavior_navigation: string | null };
      let authorReview: AuthorReview | null = null;
      if (row.author_review != null) {
        const review = record(row.author_review);
        const reviewKeys = ['purpose', 'example_scenario', 'visual_asset', 'user_behavior_navigation'] as const;
        if (Object.keys(review).length !== reviewKeys.length
          || reviewKeys.some(key => !Object.prototype.hasOwnProperty.call(review, key))) invalid();
        const output = {} as AuthorReview;
        for (const key of reviewKeys) {
          const value = review[key];
          if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 2_000)) invalid();
          output[key] = value as string | null;
        }
        authorReview = output;
      }
      return { ...workspace(row), node_id: id(row.node_id), parent_id: row.parent_id === null ? null : id(row.parent_id),
        kind: enumeration(row.kind, KINDS), content_state: state, current_revision: revision,
        content, component_type: componentType, media_type: mediaType, user_modified: revision !== null ? row.user_modified as boolean : false,
        validation_contract: revision !== null ? row.validation_contract as string : null,
        author_review: authorReview };
    },
  };
}
