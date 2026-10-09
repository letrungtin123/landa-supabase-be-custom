import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';
import { WorkspaceEditError } from './lesson-author-workspace-edit.repository.js';
import { WorkspaceContractError } from './lesson-author-workspace.logic.js';
import { lessonAuthorSourceSnapshotHash, type LessonAuthorSnapshotDocument } from './lesson-author-source-snapshot.logic.js';
import { normalizeCourseComponentTypes } from '../tenants/tenant-course-components.constants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameIds = (left: unknown, right: unknown): boolean => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every(value => typeof value === 'string' && right.includes(value));
function unavailable(): never { throw new WorkspaceEditError('WORKSPACE_EDIT_UNAVAILABLE'); }
function sourceChanged(): never { throw new WorkspaceContractError('WORKSPACE_SOURCE_CHANGED'); }

/** Source fencing is also required before inventory/baseline publication;
 * it does not require a fabricated editable node or revision. */
export interface WorkspaceSourceContext {
  target: Readonly<WorkspaceReadOwner & { workspaceId: string }>;
  source_snapshot_hash: string;
}

/** Actor-bound adapters for workspace edit/inventory transactions. No pool,
 * permission cache, provider, HTTP, logging, DML or import-time side effects.
 * MUST receive the same tx used by the write repository, not a pool executor.
 * Row locks serialize revocation/source/settings changes through commit. */
export function createWorkspaceAuthority(subjectInput: AuthUser, options: {
  /** Creator of the shared session whose workspace a course editor applies.
   * Only widens the read-only source/component fences below, never canEdit. */
  sessionOwnerId?: string;
} = {}) {
  const subject = Object.freeze({ ...subjectInput });
  const sessionOwnerId = options.sessionOwnerId && UUID.test(options.sessionOwnerId) ? options.sessionOwnerId : null;
  function validSubject(owner: WorkspaceReadOwner): boolean {
    return subject.sessionMode === 'normal' && ['staff', 'superuser', 'superadmin'].includes(subject.role)
      && UUID.test(subject.id) && !!subject.tenantId && UUID.test(subject.tenantId) && subject.tenantId === owner.tenantId;
  }
  /** canEdit always evaluates the authenticated subject itself. */
  function matches(owner: WorkspaceReadOwner): boolean {
    return validSubject(owner) && subject.id === owner.userId;
  }
  /** Workspace evidence reads may target the shared session's creator. */
  function matchesSession(owner: WorkspaceReadOwner): boolean {
    return validSubject(owner) && (subject.id === owner.userId || owner.userId === sessionOwnerId);
  }
  async function canEdit(tx: GenerationJobSql, owner: WorkspaceReadOwner): Promise<boolean> {
    if (!matches(owner)) return false;
    try {
      // Do not trust a cached role or tenant-active value for a write. The
      // controller still requires authentication; this is a commit fence.
      const result = await tx.query(`SELECT u.role,u.tenant_id,u.is_active,t.is_active AS tenant_active
        FROM users u JOIN tenants t ON t.id=$2 WHERE u.id=$1 FOR SHARE OF u,t`, [owner.userId, owner.tenantId]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || row.is_active !== true || row.tenant_active !== true || row.role !== subject.role) return false;
      if (row.role === 'superadmin') return true; // Exact workspace ownership remains required in edit SQL.
      if (row.role === 'superuser') {
        if (row.tenant_id === owner.tenantId) return true;
        const membership = await tx.query(`SELECT user_id FROM user_tenants WHERE user_id=$1 AND tenant_id=$2 FOR SHARE`, [owner.userId, owner.tenantId]);
        return membership.rows.length === 1;
      }
      if (row.tenant_id !== owner.tenantId) return false;
      // Same UNION-of-grants courses.can_edit policy as hasPermission, but
      // no five-minute cache. Lock actual rows (aggregates cannot FOR SHARE).
      const permissions = await tx.query(`SELECT pgm.can_edit
        FROM user_permission_groups upg
        JOIN permission_group_modules pgm ON pgm.permission_group_id=upg.permission_group_id AND pgm.tenant_id=upg.tenant_id
        JOIN modules m ON m.id=pgm.module_id
        JOIN permission_groups pg ON pg.id=upg.permission_group_id
        WHERE upg.user_id=$1 AND upg.tenant_id=$2 AND pg.tenant_id=$2 AND m.code='courses'
        ORDER BY upg.permission_group_id,pgm.module_id FOR SHARE OF upg,pgm,m,pg`, [owner.userId, owner.tenantId]);
      return permissions.rows.some(p => p.can_edit === true);
    } catch { return unavailable(); }
  }
  async function currentSourceHash(tx: GenerationJobSql, context: WorkspaceSourceContext): Promise<string> {
    if (!matchesSession(context.target)) throw new WorkspaceEditError('WORKSPACE_EDIT_FORBIDDEN');
    const target = context.target;
    try {
      const result = await tx.query(`SELECT w.kb_id,w.bot_id,w.source_document_ids,w.source_snapshot_hash,w.blueprint_id
        FROM lesson_author_workspaces w
        WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
          AND w.contract_version=1 AND w.engine='self_built_rag' FOR SHARE OF w`,
      [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId]);
      const w = result.rows[0];
      if (result.rows.length !== 1 || !w || w.source_snapshot_hash !== context.source_snapshot_hash
        || typeof w.kb_id !== 'string' || !UUID.test(w.kb_id)
        || typeof w.bot_id !== 'string' || !UUID.test(w.bot_id) || !Array.isArray(w.source_document_ids)
        || w.source_document_ids.length < 1 || w.source_document_ids.length > 5
        || w.source_document_ids.some(id => typeof id !== 'string' || !UUID.test(id))
        || new Set(w.source_document_ids).size !== w.source_document_ids.length) sourceChanged();
      if (typeof w.blueprint_id === 'string' && UUID.test(w.blueprint_id)) {
        const blueprint = await tx.query(`SELECT b.id FROM lesson_author_blueprints b
          WHERE b.id=$1 AND b.tenant_id=$2 AND b.course_id=$3 AND b.conversation_id=$4 AND b.kb_id=$5
            AND b.engine='self_built_rag' AND b.status='proposed' AND b.source_snapshot_hash=$6 FOR SHARE OF b`,
        [w.blueprint_id, target.tenantId, target.courseId, target.conversationId, w.kb_id, context.source_snapshot_hash]);
        if (blueprint.rows.length !== 1) sourceChanged();
      } else if (w.blueprint_id === null) {
        const v2 = await tx.query(`SELECT r.id::text AS run_id,s.id::text AS snapshot_id,s.status AS snapshot_status,
            s.source_snapshot_hash,s.source_document_ids
          FROM lesson_author_workspace_v2_runs r
          JOIN lesson_author_workspace_source_snapshots s ON s.id=r.source_snapshot_id
            AND s.workspace_id=r.workspace_id AND s.tenant_id=r.tenant_id AND s.course_id=r.course_id
          WHERE r.workspace_id=$1 AND r.tenant_id=$2 AND r.course_id=$3 FOR SHARE OF r,s`,
        [target.workspaceId, target.tenantId, target.courseId]);
        const authority = v2.rows[0];
        if (v2.rows.length !== 1 || !authority || !UUID.test(String(authority.run_id))
          || !UUID.test(String(authority.snapshot_id)) || authority.snapshot_status !== 'sealed'
          || authority.source_snapshot_hash !== context.source_snapshot_hash
          || !sameIds(authority.source_document_ids, w.source_document_ids)) sourceChanged();
      } else sourceChanged();
      // Lock the assignments too: a JOIN/EXISTS in an earlier statement does
      // not prevent a concurrent reassignment before the revision commits.
      const bot = await tx.query(`SELECT a.bot_id FROM tenant_bot_assignments a JOIN chatbots b ON b.id=a.bot_id AND b.tenant_id=a.tenant_id
        WHERE a.tenant_id=$1 AND a.target='lesson_author' AND a.bot_id=$2 FOR SHARE OF a,b`, [target.tenantId, w.bot_id]);
      const kb = await tx.query(`SELECT a.kb_id FROM tenant_kb_assignments a JOIN knowledgebases k ON k.id=a.kb_id AND k.tenant_id=a.tenant_id
        WHERE a.tenant_id=$1 AND a.target='lesson_author' AND a.kb_id=$2 FOR SHARE OF a,k`, [target.tenantId, w.kb_id]);
      if (bot.rows.length !== 1 || kb.rows.length !== 1) sourceChanged();
      const documents = await tx.query(`SELECT d.id::text AS document_id,d.name,d.status,d.type,d.updated_at,d.source_info
        FROM kb_documents d WHERE d.tenant_id=$1 AND d.kb_id=$2 AND d.id=ANY($3::uuid[])
        ORDER BY d.id FOR SHARE OF d`, [target.tenantId, w.kb_id, w.source_document_ids]);
      const expected = new Set(w.source_document_ids);
      if (documents.rows.length !== expected.size || new Set(documents.rows.map(d => d.document_id)).size !== expected.size) sourceChanged();
      const sources: LessonAuthorSnapshotDocument[] = documents.rows.map(d => {
        if (typeof d.document_id !== 'string' || !expected.has(d.document_id) || d.type !== 'file' || d.status !== 'learned'
          || typeof d.name !== 'string' || !d.name || !(d.updated_at instanceof Date || typeof d.updated_at === 'string')
          || (d.source_info !== null && (typeof d.source_info !== 'object' || Array.isArray(d.source_info)))) sourceChanged();
        const date = d.updated_at instanceof Date ? d.updated_at : new Date(d.updated_at);
        if (!Number.isFinite(date.getTime())) sourceChanged();
        return { document_id: d.document_id, name: d.name, status: d.status, updated_at: date.toISOString(), source_info: d.source_info as Record<string, unknown> | null };
      });
      return lessonAuthorSourceSnapshotHash({ tenantId: target.tenantId, courseId: target.courseId }, w.kb_id, sources);
    } catch (e) { if (e instanceof WorkspaceContractError) throw e; return unavailable(); }
  }
  async function allowedComponents(tx: GenerationJobSql, owner: WorkspaceReadOwner) {
    if (!matchesSession(owner)) throw new WorkspaceEditError('WORKSPACE_EDIT_FORBIDDEN');
    try {
      const result = await tx.query(`SELECT settings FROM tenants WHERE id=$1 AND is_active=true FOR SHARE`, [owner.tenantId]);
      if (result.rows.length !== 1) throw new WorkspaceEditError('WORKSPACE_EDIT_FORBIDDEN');
      const settings = result.rows[0].settings;
      if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) throw new WorkspaceEditError('WORKSPACE_EDIT_CONTRACT_INVALID');
      const authoring = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).course_authoring : undefined;
      if (authoring !== undefined && (!authoring || typeof authoring !== 'object' || Array.isArray(authoring))) throw new WorkspaceEditError('WORKSPACE_EDIT_CONTRACT_INVALID');
      const raw = authoring && typeof authoring === 'object' ? (authoring as Record<string, unknown>).allowed_component_types : undefined;
      // Missing setting preserves the existing all-component default. An
      // explicitly malformed setting must not accidentally grant everything.
      if (raw !== undefined && !Array.isArray(raw)) throw new WorkspaceEditError('WORKSPACE_EDIT_CONTRACT_INVALID');
      return new Set(normalizeCourseComponentTypes(raw));
    } catch (e) { if (e instanceof WorkspaceEditError) throw e; return unavailable(); }
  }
  return { canEdit, currentSourceHash, allowedComponents };
}
