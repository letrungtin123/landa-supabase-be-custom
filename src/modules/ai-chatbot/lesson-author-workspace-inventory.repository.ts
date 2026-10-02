import { randomUUID } from 'node:crypto';
import type { LessonAuthorBlueprint } from './chat.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';
import type { WorkspaceSourceContext } from './lesson-author-workspace-authority.repository.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { validateLessonAuthorBlueprintArchitecture } from './lesson-author-blueprint-validator.logic.js';
import { WorkspaceContractError } from './lesson-author-workspace.logic.js';
import { WorkspaceComponentError } from './lesson-author-workspace-component.logic.js';
import { WorkspaceEditError } from './lesson-author-workspace-edit.repository.js';
import { buildWorkspaceInventory, WorkspacePublicationError, type WorkspacePublicationCode } from './lesson-author-workspace-inventory.logic.js';

export interface WorkspaceInventoryTarget extends WorkspaceReadOwner { workspaceId: string; blueprintId: string; operationId: string; }
export interface WorkspaceInventoryDiagnostic {
  event: 'workspace_inventory_publication'; workspace_id: string; correlation_id: string | null; operation_id: string | null;
  stage: 'authority' | 'architecture' | 'inventory' | 'publication' | 'readback'; status: 'COMMITTED' | 'REPLAYED' | 'FAIL';
  internal_failure_code: string | null; external_failure_code: string | null; db_sqlstate: string | null;
  node_count: number; unit_count: number; duration_ms: number;
  validation_codes: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code: WorkspacePublicationCode): never { throw new WorkspacePublicationError(code); }
const integer = (v: unknown) => {
  if (!(typeof v === 'number' || typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) || !Number.isSafeInteger(Number(v)) || Number(v) < 0) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
  return Number(v);
};
/** Bounded batches reduce DB round trips without changing inventory order or
 * commit visibility. Depth groups ensure parent rows exist before children. */
function batches<T>(rows: T[]): T[][] {
  const result: T[][] = []; let chunk: T[] = [], bytes = 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (size > 1024 * 1024) fail('WORKSPACE_PUBLICATION_TOO_LARGE');
    if (chunk.length && (chunk.length >= 64 || bytes + size > 1024 * 1024)) { result.push(chunk); chunk = []; bytes = 2; }
    chunk.push(row); bytes += size;
  }
  if (chunk.length) result.push(chunk);
  return result;
}

/** Server-only architecture → inventory transaction. Does not admit a job,
 * dispatch paid work, grant a lease, mark units ready or authorize Apply.
 * All callbacks are mandatory and must use this transaction, never a provider.
 * Importing this module has no database/service effects; not routed yet.
 */
export function createWorkspaceInventoryRepository(deps: {
  db: GenerationJobDatabase;
  canEdit: (tx: GenerationJobSql, owner: WorkspaceReadOwner) => Promise<boolean>;
  currentSourceHash: (tx: GenerationJobSql, context: WorkspaceSourceContext) => Promise<string>;
  allowedComponents: (tx: GenerationJobSql, owner: WorkspaceReadOwner) => Promise<ReadonlySet<CourseComponentType>>;
  report: (event: WorkspaceInventoryDiagnostic) => void;
}) {
  async function publish(input: WorkspaceInventoryTarget) {
    const target = Object.freeze({ ...input });
    let correlation: string | null = null, stage: WorkspaceInventoryDiagnostic['stage'] = 'authority', nodes = 0, units = 0;
    let validationCodes: string[] = [];
    const started = performance.now();
    function report(status: WorkspaceInventoryDiagnostic['status'], code: string | null, internal = code, sqlstate: string | null = null) {
      try { deps.report({ event: 'workspace_inventory_publication', workspace_id: UUID.test(target.workspaceId) ? target.workspaceId : '',
        correlation_id: correlation, operation_id: UUID.test(target.operationId) ? target.operationId : null,
        stage, status, internal_failure_code: internal, external_failure_code: code, db_sqlstate: sqlstate, node_count: nodes, unit_count: units,
        validation_codes: validationCodes, duration_ms: Math.round(performance.now() - started) }); } catch { /* logging is not commit authority */ }
    }
    try {
      if (![target.tenantId, target.userId, target.conversationId, target.workspaceId, target.blueprintId, target.operationId].every(v => typeof v === 'string' && UUID.test(v))
        || typeof target.courseId !== 'string' || !target.courseId || target.courseId.length > 255) fail('WORKSPACE_PUBLICATION_INVALID');
      const receipt = await deps.db.transaction(async tx => {
        if (!await deps.canEdit(tx, target)) fail('WORKSPACE_PUBLICATION_FORBIDDEN');
        const course = await tx.query(`SELECT id FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [target.courseId, target.tenantId]);
        if (course.rows.length !== 1) fail('WORKSPACE_PUBLICATION_FORBIDDEN');
        const params = [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId];
        const result = await tx.query(`SELECT w.id,w.status,w.blueprint_id,w.source_snapshot_hash,w.content_locale,w.correlation_id
          FROM lesson_author_workspaces w JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id
            AND c.user_id=w.requested_by AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
          WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
            AND w.contract_version=1 AND w.engine='self_built_rag' FOR UPDATE OF w`, params);
        const w = result.rows[0];
        if (result.rows.length !== 1 || !UUID.test(String(w.correlation_id)) || !/^[0-9a-f]{64}$/.test(String(w.source_snapshot_hash))
          || !['vi', 'en'].includes(String(w.content_locale))) fail('WORKSPACE_PUBLICATION_FORBIDDEN');
        correlation = String(w.correlation_id);
        const events = await tx.query(`SELECT event_kind,sequence FROM lesson_author_workspace_events
          WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND event_kind IN ('overview_ready','structure_ready') ORDER BY sequence`, params.slice(0, 3));
        const replay = events.rows.length === 2 && events.rows[0].event_kind === 'overview_ready' && events.rows[1].event_kind === 'structure_ready'
          && integer(events.rows[0].sequence) < integer(events.rows[1].sequence);
        if (events.rows.length && !replay) fail('WORKSPACE_PUBLICATION_CONFLICT');
        if (replay ? w.blueprint_id !== target.blueprintId : w.status !== 'designing' || w.blueprint_id !== null) fail('WORKSPACE_PUBLICATION_CONFLICT');
        stage = 'architecture';
        const bound = await tx.query(`SELECT CASE WHEN octet_length(b.blueprint::text)<=16777216 THEN b.blueprint ELSE NULL END AS blueprint
          FROM lesson_author_blueprints b JOIN lesson_author_workspaces w ON w.id=$1
          WHERE b.id=$6 AND b.tenant_id=$2 AND b.course_id=$3 AND b.conversation_id=$4 AND b.requested_by=$5
            AND b.bot_id=w.bot_id AND b.kb_id=w.kb_id AND b.engine=w.engine AND b.status='proposed'
            AND b.source_snapshot_hash=w.source_snapshot_hash FOR SHARE OF b`, [...params, target.blueprintId]);
        if (bound.rows.length !== 1 || !bound.rows[0].blueprint) fail('WORKSPACE_PUBLICATION_BLUEPRINT_INVALID');
        const blueprint = bound.rows[0].blueprint as LessonAuthorBlueprint;
        if (blueprint.architecture_contract_version !== 5 || blueprint.content_contract_version !== 1) fail('WORKSPACE_PUBLICATION_BLUEPRINT_INVALID');
        const validation = validateLessonAuthorBlueprintArchitecture(blueprint, blueprint.source_map);
        validationCodes = [...validation.errors, ...validation.warnings, ...validation.info].slice(0, 40)
          .map(f => /^[A-Z][A-Z0-9_]{0,95}$/.test(f.code) ? f.code : 'UNKNOWN_VALIDATION_CODE');
        if (validation.status === 'FAIL') fail('WORKSPACE_PUBLICATION_BLUEPRINT_INVALID');
        stage = 'inventory';
        const allowed = await deps.allowedComponents(tx, target);
        const inventory = buildWorkspaceInventory(blueprint, allowed);
        nodes = inventory.nodes.length; units = inventory.unit_count;
        if (!replay) {
          const existing = await tx.query(`SELECT count(*)::text AS count FROM lesson_author_workspace_nodes WHERE workspace_id=$1`, [target.workspaceId]);
          if (existing.rows.length !== 1 || integer(existing.rows[0].count) !== 0) fail('WORKSPACE_PUBLICATION_CONFLICT');
          const updated = await tx.query(`UPDATE lesson_author_workspaces SET blueprint_id=$2,status='drafting'
            WHERE id=$1 AND status='designing' AND blueprint_id IS NULL RETURNING id`, [target.workspaceId, target.blueprintId]);
          if (updated.rows.length !== 1) fail('WORKSPACE_PUBLICATION_CONFLICT');
        }
        const source: WorkspaceSourceContext = { target, source_snapshot_hash: String(w.source_snapshot_hash) };
        if (await deps.currentSourceHash(tx, source) !== source.source_snapshot_hash) fail('WORKSPACE_PUBLICATION_SOURCE_CHANGED');
        stage = 'publication';
        if (!replay) {
          const ids = new Map(inventory.nodes.map(n => [n.canonical_path, randomUUID()]));
          for (let depth = 0; depth <= 4; depth++) {
            const level = inventory.nodes.filter(n => (n.kind === 'course' ? 0 : n.canonical_path.split('.').length) === depth);
            const rows = level.map((n, ordinal) => ({ id: ids.get(n.canonical_path), workspace_id: target.workspaceId,
              tenant_id: target.tenantId, course_id: target.courseId, parent_id: n.parent_path ? ids.get(n.parent_path) : null,
              kind: n.kind, canonical_path: n.canonical_path, sort_order: n.sort_order,
              protected_contract: n.protected_contract, contract_hash: n.contract_hash, ordinal }));
            for (const batch of batches(rows)) {
              const inserted = await tx.query(`INSERT INTO lesson_author_workspace_nodes
              (id,workspace_id,tenant_id,course_id,parent_id,kind,canonical_path,sort_order,protected_contract,contract_hash)
              SELECT x.id,x.workspace_id,x.tenant_id,x.course_id,x.parent_id,x.kind,x.canonical_path,x.sort_order,x.protected_contract,x.contract_hash
              FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,workspace_id uuid,tenant_id uuid,course_id varchar,parent_id uuid,
                kind varchar,canonical_path varchar,sort_order integer,protected_contract jsonb,contract_hash varchar,ordinal integer)
              ORDER BY x.ordinal RETURNING id`, [JSON.stringify(batch)]);
              const insertedIds = new Set(inserted.rows.map(r => r.id));
              if (inserted.rows.length !== batch.length || insertedIds.size !== batch.length || batch.some(r => !insertedIds.has(r.id))) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
            }
          }
          const baselines = inventory.nodes.filter(n => n.baseline).map(n => ({ workspace_id: target.workspaceId,
            node_id: ids.get(n.canonical_path), tenant_id: target.tenantId, course_id: target.courseId, operation_id: target.operationId,
            content: n.baseline, content_hash: hash(n.baseline), validation_contract: inventory.contract }));
          for (const batch of batches(baselines)) {
            const saved = await tx.query(`INSERT INTO lesson_author_workspace_revisions
              (workspace_id,node_id,tenant_id,course_id,revision,parent_revision,origin,actor_id,operation_id,content,content_hash,validation_contract,user_modified)
              SELECT x.workspace_id,x.node_id,x.tenant_id,x.course_id,0,NULL,'ai_baseline',NULL,x.operation_id,x.content,x.content_hash,x.validation_contract,false
              FROM jsonb_to_recordset($1::jsonb) AS x(workspace_id uuid,node_id uuid,tenant_id uuid,course_id varchar,
                operation_id uuid,content jsonb,content_hash varchar,validation_contract varchar) RETURNING node_id,revision`, [JSON.stringify(batch)]);
            const savedIds = new Set(saved.rows.map(r => r.node_id));
            if (saved.rows.length !== batch.length || savedIds.size !== batch.length || batch.some(r => !savedIds.has(r.node_id))
              || saved.rows.some(r => integer(r.revision) !== 0)) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
          }
          for (const kind of ['overview_ready', 'structure_ready']) {
            await tx.query(`INSERT INTO lesson_author_workspace_events (workspace_id,tenant_id,course_id,event_kind,operation_id)
              VALUES ($1,$2,$3,$4,$5) RETURNING sequence`, [target.workspaceId, target.tenantId, target.courseId, kind, target.operationId]);
          }
        }
        stage = 'readback';
        // Exact metadata/baseline fingerprint verification on retry; never reset
        // a later author revision or an already-generated component baseline.
        const size = await tx.query(`SELECT count(*)::text AS node_count,
            COALESCE(sum(octet_length(n.protected_contract::text)+CASE WHEN n.kind IN ('course','chapter','lesson','media_brief') THEN COALESCE(octet_length(r.content::text),0) ELSE 0 END),0)::text AS bytes
          FROM lesson_author_workspace_nodes n LEFT JOIN lesson_author_workspace_revisions r
            ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=0
          WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3`, params.slice(0, 3));
        if (size.rows.length !== 1 || integer(size.rows[0].node_count) !== nodes || integer(size.rows[0].bytes) > 64 * 1024 * 1024) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
        const stored = await tx.query(`SELECT n.id,n.parent_id,n.kind,n.canonical_path,n.sort_order,n.contract_hash,n.protected_contract,
            r.content_hash AS baseline_hash,n.current_revision,n.content_state,
            CASE WHEN n.kind IN ('course','chapter','lesson','media_brief') THEN r.content ELSE NULL END AS baseline_content
          FROM lesson_author_workspace_nodes n LEFT JOIN lesson_author_workspace_revisions r
            ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=0
          WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3 ORDER BY n.canonical_path LIMIT 8193`, params.slice(0, 3));
        const byPath = new Map(stored.rows.map(n => [String(n.canonical_path), n]));
        if (stored.rows.length !== nodes || byPath.size !== nodes) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
        for (const node of inventory.nodes) {
          const s = byPath.get(node.canonical_path);
          if (!s || s.kind !== node.kind || s.sort_order !== node.sort_order || s.contract_hash !== node.contract_hash || hash(s.protected_contract) !== node.contract_hash
            || s.parent_id !== (node.parent_path ? byPath.get(node.parent_path)?.id : null)
            || (node.baseline && (s.baseline_hash !== hash(node.baseline) || hash(s.baseline_content) !== s.baseline_hash || s.content_state !== 'content_ready' || s.current_revision === null))
            || (!replay && !node.baseline && (s.current_revision !== null || s.content_state !== 'planned'))) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
        }
        if (!await deps.canEdit(tx, target)) fail('WORKSPACE_PUBLICATION_FORBIDDEN');
        if (await deps.currentSourceHash(tx, source) !== source.source_snapshot_hash) fail('WORKSPACE_PUBLICATION_SOURCE_CHANGED');
        const committed = await tx.query(`SELECT event_kind,sequence FROM lesson_author_workspace_events
          WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND event_kind IN ('overview_ready','structure_ready') ORDER BY sequence`, params.slice(0, 3));
        if (committed.rows.length !== 2 || committed.rows[0].event_kind !== 'overview_ready' || committed.rows[1].event_kind !== 'structure_ready'
          || integer(committed.rows[0].sequence) >= integer(committed.rows[1].sequence)) fail('WORKSPACE_PUBLICATION_READBACK_INVALID');
        return { workspace_id: target.workspaceId, correlation_id: correlation, inventory_hash: inventory.inventory_hash,
          node_count: nodes, unit_count: units, structure_sequence: integer(committed.rows[1].sequence), replayed: replay };
      });
      report(receipt.replayed ? 'REPLAYED' : 'COMMITTED', null); return receipt;
    } catch (error) {
      const safe = error instanceof WorkspacePublicationError ? error : new WorkspacePublicationError(
        error instanceof WorkspaceContractError && error.code === 'WORKSPACE_SOURCE_CHANGED' ? 'WORKSPACE_PUBLICATION_SOURCE_CHANGED'
          : error instanceof WorkspaceEditError && error.code === 'WORKSPACE_EDIT_FORBIDDEN' ? 'WORKSPACE_PUBLICATION_FORBIDDEN'
          : error instanceof WorkspaceContractError || error instanceof WorkspaceComponentError ? 'WORKSPACE_PUBLICATION_INVALID'
            : 'WORKSPACE_PUBLICATION_UNAVAILABLE');
      const sqlstate = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
      const internal = error instanceof WorkspaceContractError || error instanceof WorkspaceComponentError || error instanceof WorkspaceEditError ? error.code
        : sqlstate ? 'WORKSPACE_PUBLICATION_DATABASE_ERROR' : safe.code;
      report('FAIL', safe.code, internal, sqlstate); throw safe;
    }
  }
  return { publish };
}
