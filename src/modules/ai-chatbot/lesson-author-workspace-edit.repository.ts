import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';
import { WorkspaceComponentError } from './lesson-author-workspace-component.logic.js';
import { WORKSPACE_AGGREGATE_EDIT, WORKSPACE_MEDIA_EDIT } from './lesson-author-workspace-storyboard.logic.js';
import { prepareWorkspaceEdit, prepareWorkspaceReset, readWorkspaceContent, workspaceLocale, WorkspaceContractError,
  type WorkspaceNodeSnapshot, type WorkspaceRevisionCandidate } from './lesson-author-workspace.logic.js';

export type WorkspaceEditCode = 'WORKSPACE_EDIT_FORBIDDEN' | 'WORKSPACE_EDIT_NOT_FOUND'
  | 'WORKSPACE_EDIT_STATE_INVALID' | 'WORKSPACE_EDIT_CONTRACT_INVALID' | 'WORKSPACE_EDIT_VALIDATION_REQUIRED'
  | 'WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT' | 'WORKSPACE_EDIT_COMMIT_INVALID' | 'WORKSPACE_EDIT_UNAVAILABLE';
export class WorkspaceEditError extends Error {
  constructor(readonly code: WorkspaceEditCode) { super(code); this.name = 'WorkspaceEditError'; }
}
export interface WorkspaceEditTarget extends WorkspaceReadOwner {
  workspaceId: string;
  nodeId: string;
  operationId: string;
}
export interface WorkspaceEditContext {
  target: Readonly<WorkspaceEditTarget>;
  correlation_id: string;
  content_locale: 'vi' | 'en';
  source_snapshot_hash: string;
  contract_hash: string;
  protected_contract: Readonly<Record<string, unknown>>;
  node: WorkspaceNodeSnapshot;
}
/** INTERNAL validation receipt only, never accepted from the browser.
 * Save is not Apply or factual verification of user-authored prose.
 */
export interface WorkspaceEditAcceptance {
  workspace_id: string;
  node_id: string;
  expected_revision: number;
  content_hash: string;
  source_snapshot_hash: string;
  contract_hash: string;
  validation_contract: string;
  checks: Record<'schema' | 'security' | 'references' | 'pedagogy' | 'registry', 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_APPLICABLE'>;
}

/** Metadata Save is not learner-content acceptance. These exact versioned
 * receipts cannot be used for components or Apply. Never turn a deferred
 * pedagogy check into PASS merely because the node is author-only metadata.
 */
export function workspaceEditChecksAccepted(kind: WorkspaceNodeSnapshot['kind'], acceptance: WorkspaceEditAcceptance): boolean {
  const keys = ['schema', 'security', 'references', 'pedagogy', 'registry'] as const;
  if (!acceptance?.checks || Object.keys(acceptance.checks).length !== keys.length) return false;
  if (kind === 'component') {
    if (acceptance.validation_contract === 'workspace-component-edit-v2-ready-1') {
      return ['schema', 'security', 'references', 'registry'].every(key => acceptance.checks[key as keyof typeof acceptance.checks] === 'PASS')
        && acceptance.checks.pedagogy === 'NOT_RUN';
    }
    return ![WORKSPACE_AGGREGATE_EDIT, WORKSPACE_MEDIA_EDIT].includes(acceptance.validation_contract)
      && keys.every(key => acceptance.checks[key] === 'PASS');
  }
  const expected = kind === 'media_brief' ? WORKSPACE_MEDIA_EDIT : WORKSPACE_AGGREGATE_EDIT;
  return ['course', 'chapter', 'lesson', 'unit', 'media_brief'].includes(kind) && acceptance.validation_contract === expected
    && ['schema', 'security', 'references'].every(key => acceptance.checks[key as keyof typeof acceptance.checks] === 'PASS')
    && acceptance.checks.pedagogy === 'NOT_RUN' && acceptance.checks.registry === 'NOT_APPLICABLE';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const KINDS = ['course', 'chapter', 'lesson', 'unit', 'component', 'media_brief'];
function fail(code: WorkspaceEditCode): never { throw new WorkspaceEditError(code); }
function integer(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
  return number;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
type Row = Record<string, unknown>;
function checkedContent(row: Row) {
  const content = readWorkspaceContent(row.content);
  if (generationSnapshotHash(content) !== row.content_hash) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
  return content;
}

/** Not wired to HTTP or a live database. Injected boundaries keep tests offline.
 * Application callbacks MUST use tx for current RBAC/source/registry checks and
 * deterministic validation only: no provider/HTTP waits inside this transaction.
 * Lock order matches installed guards: active course -> workspace -> node.
 * SQL triggers atomically publish the revision pointer/event; never duplicate them.
 */
export function createWorkspaceEditRepository(deps: {
  db: GenerationJobDatabase;
  canEdit: (tx: GenerationJobSql, owner: Readonly<WorkspaceReadOwner>) => Promise<boolean>;
  currentSourceHash: (tx: GenerationJobSql, context: WorkspaceEditContext) => Promise<string>;
  validate: (tx: GenerationJobSql, context: WorkspaceEditContext, candidate: WorkspaceRevisionCandidate) => Promise<WorkspaceEditAcceptance>;
  /** Safe request-local diagnostic only; no protected contract/content leaves the repository. */
  onAuthorizedCorrelation?: (correlationId: string) => void;
}) {
  async function execute(targetInput: WorkspaceEditTarget, request: unknown, reset: boolean) {
    const target = freeze({ ...targetInput });
    if (![target.tenantId, target.userId, target.conversationId, target.workspaceId, target.nodeId, target.operationId]
      .every(value => typeof value === 'string' && UUID.test(value)) || !target.courseId || target.courseId.length > 255) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
    try {
      return await deps.db.transaction(async tx => {
        if (!await deps.canEdit(tx, target)) fail('WORKSPACE_EDIT_FORBIDDEN');
        const course = await tx.query(`SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [target.courseId, target.tenantId]);
        if (course.rows.length !== 1) fail('WORKSPACE_EDIT_NOT_FOUND');
        const workspaces = await tx.query(`SELECT w.id,w.status,w.contract_version,w.content_locale,w.correlation_id,w.source_snapshot_hash
          FROM lesson_author_workspaces w JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id
            AND c.user_id=w.requested_by AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
          JOIN chatbots b ON b.id=w.bot_id AND b.tenant_id=w.tenant_id
          JOIN knowledgebases k ON k.id=w.kb_id AND k.tenant_id=w.tenant_id
          WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
            AND EXISTS (SELECT 1 FROM tenant_bot_assignments a WHERE a.tenant_id=w.tenant_id AND a.target='lesson_author' AND a.bot_id=w.bot_id)
            AND EXISTS (SELECT 1 FROM tenant_kb_assignments a WHERE a.tenant_id=w.tenant_id AND a.target='lesson_author' AND a.kb_id=w.kb_id)
            AND cardinality(w.source_document_ids)=(SELECT count(DISTINCT d.id) FROM kb_documents d
              WHERE d.id=ANY(w.source_document_ids) AND d.tenant_id=w.tenant_id AND d.kb_id=w.kb_id)
          FOR UPDATE OF w`, [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId]);
        const w = workspaces.rows[0];
        if (!w || workspaces.rows.length !== 1) fail('WORKSPACE_EDIT_NOT_FOUND');
        if (w.contract_version !== 1 || typeof w.correlation_id !== 'string' || !UUID.test(w.correlation_id)
          || typeof w.source_snapshot_hash !== 'string' || !HASH.test(w.source_snapshot_hash)) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
        const nodes = await tx.query(`SELECT id,kind,content_state,current_revision,protected_contract,contract_hash
          FROM lesson_author_workspace_nodes WHERE workspace_id=$1 AND id=$2 AND tenant_id=$3 AND course_id=$4 FOR UPDATE`,
        [target.workspaceId, target.nodeId, target.tenantId, target.courseId]);
        const n = nodes.rows[0];
        if (!n || nodes.rows.length !== 1) fail('WORKSPACE_EDIT_NOT_FOUND');
        if (!KINDS.includes(String(n.kind)) || !n.protected_contract || typeof n.protected_contract !== 'object' || Array.isArray(n.protected_contract)
          || generationSnapshotHash(n.protected_contract) !== n.contract_hash) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
        if (n.content_state !== 'content_ready' || n.current_revision === null) throw new WorkspaceContractError('WORKSPACE_NODE_NOT_READY');
        const revision = integer(n.current_revision);
        const revisions = await tx.query(`SELECT revision,parent_revision,origin,actor_id,operation_id,content,content_hash,user_modified,validation_contract
          FROM lesson_author_workspace_revisions WHERE workspace_id=$1 AND node_id=$2 AND tenant_id=$3 AND course_id=$4
            AND (revision=0 OR revision=$5 OR operation_id=$6)`,
        [target.workspaceId, target.nodeId, target.tenantId, target.courseId, revision, target.operationId]);
        const baseline = revisions.rows.find(r => integer(r.revision) === 0);
        const current = revisions.rows.find(r => integer(r.revision) === revision);
        if (!baseline || !current || baseline.origin !== 'ai_baseline' || baseline.user_modified !== false) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
        const node: WorkspaceNodeSnapshot = { node_id: target.nodeId, kind: n.kind as WorkspaceNodeSnapshot['kind'], content_state: 'content_ready',
          current_revision: revision, baseline: checkedContent(baseline), current: checkedContent(current) };
        const context: WorkspaceEditContext = freeze({ target, correlation_id: w.correlation_id, content_locale: workspaceLocale(w.content_locale),
          source_snapshot_hash: w.source_snapshot_hash, contract_hash: String(n.contract_hash), protected_contract: structuredClone(n.protected_contract) as Row, node });
        try { deps.onAuthorizedCorrelation?.(context.correlation_id); } catch { /* Diagnostic callback cannot alter a write outcome. */ }
        if (await deps.currentSourceHash(tx, context) !== context.source_snapshot_hash) throw new WorkspaceContractError('WORKSPACE_SOURCE_CHANGED');
        const prior = revisions.rows.find(r => r.operation_id === target.operationId);
        let candidate: WorkspaceRevisionCandidate;
        if (prior) {
          if (prior.actor_id !== target.userId || integer(prior.revision) === 0 || prior.parent_revision === null) fail('WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT');
          const parent = await tx.query(`SELECT content,content_hash FROM lesson_author_workspace_revisions
            WHERE workspace_id=$1 AND node_id=$2 AND tenant_id=$3 AND course_id=$4 AND revision=$5`,
          [target.workspaceId, target.nodeId, target.tenantId, target.courseId, integer(prior.parent_revision)]);
          if (parent.rows.length !== 1) fail('WORKSPACE_EDIT_CONTRACT_INVALID');
          const replayNode = { ...node, current_revision: integer(prior.parent_revision), current: checkedContent(parent.rows[0]) };
          candidate = reset ? prepareWorkspaceReset(replayNode, request) : prepareWorkspaceEdit(replayNode, request);
          if (candidate.revision !== integer(prior.revision) || candidate.origin !== prior.origin
            || candidate.content_hash !== prior.content_hash || candidate.user_modified !== prior.user_modified
            || generationSnapshotHash(checkedContent(prior)) !== candidate.content_hash) fail('WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT');
        } else {
          if (!['drafting', 'ready', 'needs_action'].includes(String(w.status))) fail('WORKSPACE_EDIT_STATE_INVALID');
          // An Apply mapping is bound to the exact committed revision/hash.
          // Applied content is immutable in the AI review workspace; keep the
          // prior-operation branch above replayable for unknown-outcome recovery.
          const applied = await tx.query(`SELECT 1 AS applied FROM lesson_author_workspace_apply_mappings
            WHERE workspace_id=$1 AND node_id=$2 AND tenant_id=$3 AND course_id=$4
              AND applied_revision=$5 AND applied_content_hash=$6 LIMIT 1`,
          [target.workspaceId, target.nodeId, target.tenantId, target.courseId, revision, String(current.content_hash)]);
          if (applied.rows.length !== 0) fail('WORKSPACE_EDIT_STATE_INVALID');
          candidate = reset ? prepareWorkspaceReset(node, request) : prepareWorkspaceEdit(node, request);
          freeze(candidate);
          let acceptance: WorkspaceEditAcceptance;
          try { acceptance = await deps.validate(tx, context, candidate); }
          catch (error) {
            if (error instanceof WorkspaceEditError || error instanceof WorkspaceContractError || error instanceof WorkspaceComponentError) throw error;
            fail('WORKSPACE_EDIT_VALIDATION_REQUIRED');
          }
          if (!acceptance || acceptance.workspace_id !== target.workspaceId || acceptance.node_id !== target.nodeId
            || acceptance.expected_revision !== candidate.parent_revision
            || acceptance.content_hash !== candidate.content_hash || acceptance.contract_hash !== context.contract_hash
            || acceptance.source_snapshot_hash !== context.source_snapshot_hash || typeof acceptance.validation_contract !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(acceptance.validation_contract)
            || !workspaceEditChecksAccepted(node.kind, acceptance)) {
            fail('WORKSPACE_EDIT_VALIDATION_REQUIRED');
          }
          // Recheck after validation work as well. The production adapters must
          // use this transaction's source/permission fencing; a receipt is not
          // permission to commit against a newly changed source or revoked role.
          if (!await deps.canEdit(tx, target)) fail('WORKSPACE_EDIT_FORBIDDEN');
          if (await deps.currentSourceHash(tx, context) !== context.source_snapshot_hash) throw new WorkspaceContractError('WORKSPACE_SOURCE_CHANGED');
          const inserted = await tx.query(`INSERT INTO lesson_author_workspace_revisions
            (workspace_id,node_id,tenant_id,course_id,revision,parent_revision,origin,actor_id,operation_id,content,content_hash,validation_contract,user_modified)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING revision`,
          [target.workspaceId, target.nodeId, target.tenantId, target.courseId, candidate.revision, candidate.parent_revision,
            candidate.origin, target.userId, target.operationId, JSON.stringify(candidate.content), candidate.content_hash,
            acceptance.validation_contract, candidate.user_modified]);
          if (inserted.rows.length !== 1 || integer(inserted.rows[0].revision) !== candidate.revision) fail('WORKSPACE_EDIT_COMMIT_INVALID');
        }
        // Read-back exact immutable receipt after trigger publication, not a
        // guessed head. Replaying an old save must not rewind the current pointer.
        const receipts = await tx.query(`SELECT e.sequence,r.revision,r.content_hash,r.user_modified,n.current_revision
          FROM lesson_author_workspace_events e JOIN lesson_author_workspace_revisions r
            ON r.workspace_id=e.workspace_id AND r.node_id=e.node_id AND r.revision=e.node_revision
          JOIN lesson_author_workspace_nodes n ON n.workspace_id=r.workspace_id AND n.id=r.node_id
          WHERE e.workspace_id=$1 AND e.node_id=$2 AND e.tenant_id=$3 AND e.course_id=$4 AND e.operation_id=$5
            AND r.operation_id=$5 AND e.node_revision=$6 AND e.event_kind=$7`,
        [target.workspaceId, target.nodeId, target.tenantId, target.courseId, target.operationId, candidate.revision,
          reset ? 'node_reset' : 'node_revision_saved']);
        const receipt = receipts.rows[0];
        if (!receipt || receipts.rows.length !== 1 || integer(receipt.revision) !== candidate.revision
          || receipt.content_hash !== candidate.content_hash || receipt.user_modified !== candidate.user_modified
          || integer(receipt.current_revision) !== (prior ? revision : candidate.revision)
          || integer(receipt.sequence) < 1) fail('WORKSPACE_EDIT_COMMIT_INVALID');
        return { workspace_id: target.workspaceId, node_id: target.nodeId, operation_id: target.operationId,
          correlation_id: context.correlation_id, revision: candidate.revision, current_revision: integer(receipt.current_revision),
          content_hash: candidate.content_hash, user_modified: candidate.user_modified, event_sequence: integer(receipt.sequence), replayed: !!prior };
      });
    } catch (error) {
      if (error instanceof WorkspaceEditError || error instanceof WorkspaceContractError || error instanceof WorkspaceComponentError) throw error;
      if ((error as { code?: unknown })?.code === '40001') throw new WorkspaceContractError('WORKSPACE_REVISION_CONFLICT');
      throw new WorkspaceEditError('WORKSPACE_EDIT_UNAVAILABLE');
    }
  }
  return {
    save: (target: WorkspaceEditTarget, request: unknown) => execute(target, request, false),
    reset: (target: WorkspaceEditTarget, expectedRevision: unknown) => execute(target, expectedRevision, true),
  };
}
