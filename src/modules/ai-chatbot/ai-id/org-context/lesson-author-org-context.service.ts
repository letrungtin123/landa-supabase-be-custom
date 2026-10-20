// AI ID organization context (ORG_CONTEXT_SPEC §3): the tenant-wide context files (a hidden knowledge
// base, 50 MB in total) and the organization profile authors draft with AI, edit and confirm.
// Every change runs in one transaction with its audit row (deps.audited); the profile uses
// optimistic concurrency on the state row's revision. No HTTP objects here.

import type { TransactionalAuditEntry } from '../../../../middleware/audit-log.js';
import type { KbUploadedTempFile, StagedKbSource } from '../../kb/kb-document-operations.service.js';
import type { KbDocument } from '../../kb/kb.types.js';
import {
  buildOrganizationContext, orgContextConfirmIssue, orgContextProfileCharCount, orgContextProfileHash,
  normalizeOrgContextProfile, type OrganizationContextV1,
} from '../contracts/lesson-author-org-context.contract.js';
import type { OrgContextRepository, OrgContextStateRow, OrgContextVersionRow } from './lesson-author-org-context.repository.js';
import {
  decideOrgContextSave, ORG_CONTEXT_DOCUMENT_LIST_LIMIT, ORG_CONTEXT_HISTORY_LIMIT, ORG_CONTEXT_KB_NAME, OrgContextError,
  orgContextDocumentStatus, orgContextEnabledFor, orgContextFitsLimit, orgContextNotReadyReason,
  type OrgContextDistillStatus, type OrgContextNotReadyReason,
} from './lesson-author-org-context.logic.js';

/** Who acts (from the authenticated request; tenant is the request tenant). */
export interface OrgContextActor {
  tenantId: string;
  userId: string;
  username: string;
  ipAddress?: string;
}

export interface OrgContextSettings {
  enabled: boolean;
  tenant_allowlist: readonly string[];
  max_bytes: number;
}

export interface OrgContextServiceDependencies {
  repository: OrgContextRepository;
  /** One transaction; the repository's queries join it. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** One transaction with the audit row `entry(result)` (none when it returns null). */
  audited<T>(work: () => Promise<T>, entry: (result: T) => TransactionalAuditEntry | null): Promise<T>;
  settings(): OrgContextSettings;
  /** AI engine, lesson_author bot + knowledge base assignment, provider key of the tenant. */
  readiness(tenantId: string): Promise<{ engine: string | null; deployed: boolean; providerKey: boolean }>;
  documents: {
    stage(kbId: string, tenantId: string, file: KbUploadedTempFile): Promise<StagedKbSource>;
    createQueued(kbId: string, tenantId: string, userId: string, staged: StagedKbSource): Promise<KbDocument>;
    discard(staged: StagedKbSource | null): Promise<void>;
    queueDeletion(documentId: string, kbId: string, tenantId: string): Promise<{ document: KbDocument } | null>;
  };
  /** After the context knowledge base is created (tenant AI caches). */
  knowledgebaseCreated(tenantId: string): Promise<void>;
  /** The tenant's AI points of the month are spent (a draft would be refused). */
  creditExhausted(tenantId: string): Promise<boolean>;
}

export interface OrgContextDocumentView {
  id: string;
  name: string;
  size_bytes: number;
  status: 'learning' | 'learned' | 'error';
  error_reason: string | null;
  created_at: string;
  created_by_name: string | null;
}

export type OrgContextProfileVersionView = OrgContextVersionRow;

export interface OrgContextDistillView {
  status: OrgContextDistillStatus;
  requested_at: string | null;
  finished_at: string | null;
  error_code: string | null;
}

export type OrgContextStateView = { enabled: false } | {
  enabled: true;
  ready: boolean;
  not_ready_reason: OrgContextNotReadyReason | null;
  limit_bytes: number;
  used_bytes: number;
  documents: OrgContextDocumentView[];
  profile: {
    revision: number;
    current: OrgContextProfileVersionView | null;
    confirmed_version: number | null;
    confirmed_at: string | null;
    confirmed_by_name: string | null;
    unread_document_count: number;
  };
  distill: OrgContextDistillView;
  history: Array<{ version: number; origin: string; char_count: number; created_at: string; created_by_name: string | null }>;
};

const IDLE: OrgContextDistillView = { status: 'idle', requested_at: null, finished_at: null, error_code: null };
const PROFILE_ENTITY = 'lesson_author_org_context';
const fail = (code: ConstructorParameters<typeof OrgContextError>[0], details?: Record<string, unknown>): never => {
  throw new OrgContextError(code, details);
};

function distillView(state: OrgContextStateRow | null): OrgContextDistillView {
  return state ? { status: state.distill_status, requested_at: state.distill_requested_at,
    finished_at: state.distill_finished_at, error_code: state.distill_error_code } : IDLE;
}

function auditEntry(actor: OrgContextActor, action: 'CREATE' | 'UPDATE' | 'DELETE', entityType: string,
  event: TransactionalAuditEntry['event'], entityId: string, entityName: string): TransactionalAuditEntry {
  return { tenantId: actor.tenantId, actorId: actor.userId, actorUsername: actor.username, action, entityType,
    entityId, entityName, ipAddress: actor.ipAddress, event };
}

const profileName = (version: number) => `Hồ sơ doanh nghiệp v${version}`;

export function createOrgContextService(deps: OrgContextServiceDependencies) {
  const { repository } = deps;
  // The SQL file only adds objects: once present they stay, so a positive check is kept for the process.
  let schemaPresent = false;
  async function schemaReady(): Promise<boolean> {
    if (!schemaPresent) schemaPresent = await repository.schemaReady();
    return schemaPresent;
  }

  const enabledFor = (tenantId: string) => orgContextEnabledFor(tenantId, deps.settings());
  function assertEnabled(tenantId: string): void {
    if (!enabledFor(tenantId)) fail('ORG_CONTEXT_DISABLED');
  }

  async function notReadyReason(tenantId: string): Promise<OrgContextNotReadyReason | null> {
    const schema = await schemaReady();
    const facts = await deps.readiness(tenantId);
    return orgContextNotReadyReason({ schema, ...facts });
  }

  /** Uploads and drafts need the whole deployment; the other changes only the tables. */
  async function assertReady(tenantId: string): Promise<void> {
    const reason = await notReadyReason(tenantId);
    if (reason === 'not_deployed') fail('ORG_CONTEXT_NOT_DEPLOYED');
    if (reason) fail('ORG_CONTEXT_NOT_READY');
  }
  async function assertSchema(): Promise<void> {
    if (!await schemaReady()) fail('ORG_CONTEXT_NOT_READY');
  }

  async function currentVersion(tenantId: string, state: OrgContextStateRow | null): Promise<OrgContextVersionRow | null> {
    if (!state?.current_version) return null;
    return await repository.readVersion(tenantId, state.current_version) ?? fail('ORG_CONTEXT_UNAVAILABLE');
  }

  async function lockForChange(tenantId: string, expectedRevision: number): Promise<OrgContextStateRow> {
    const state = await repository.lockState(tenantId);
    if (state.revision !== expectedRevision) fail('ORG_CONTEXT_REVISION_CONFLICT', { revision: state.revision });
    return state;
  }

  const drafting = (state: OrgContextStateRow) => state.distill_status === 'queued' || state.distill_status === 'running';

  /** The context knowledge base, created on the first upload (a concurrent creation wins and is reused). */
  async function ensureContextKb(actor: OrgContextActor): Promise<string> {
    const existing = await repository.contextKbId(actor.tenantId);
    if (existing) return existing;
    try {
      const created = await deps.transaction(() => repository.insertContextKb(actor.tenantId, actor.userId));
      await deps.knowledgebaseCreated(actor.tenantId);
      return created;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== '23505') throw error;
      const createdElsewhere = await repository.contextKbId(actor.tenantId);
      if (createdElsewhere) return createdElsewhere;
      throw error;
    }
  }

  function documentView(row: { id: string; name: string; status: string; error_reason: string | null;
    size_bytes: number; created_at: string; created_by_name: string | null }): OrgContextDocumentView {
    return { id: row.id, name: row.name, size_bytes: row.size_bytes, status: orgContextDocumentStatus(row.status),
      error_reason: row.error_reason, created_at: row.created_at, created_by_name: row.created_by_name };
  }

  return {
    enabledFor,

    async getState(tenantId: string): Promise<OrgContextStateView> {
      if (!enabledFor(tenantId)) return { enabled: false };
      const settings = deps.settings();
      const reason = await notReadyReason(tenantId);
      const base = { enabled: true as const, ready: reason === null, not_ready_reason: reason, limit_bytes: settings.max_bytes };
      if (reason === 'schema') {
        return { ...base, used_bytes: 0, documents: [], history: [], distill: IDLE, profile: { revision: 0, current: null,
          confirmed_version: null, confirmed_at: null, confirmed_by_name: null, unread_document_count: 0 } };
      }
      const kbId = await repository.contextKbId(tenantId);
      const documents = kbId ? await repository.listDocuments(tenantId, kbId, ORG_CONTEXT_DOCUMENT_LIST_LIMIT) : [];
      const usedBytes = kbId ? await repository.usedBytes(tenantId, kbId) : 0;
      const state = await repository.readState(tenantId);
      const current = await currentVersion(tenantId, state);
      const history = await repository.history(tenantId, ORG_CONTEXT_HISTORY_LIMIT);
      const draftSources = kbId ? await repository.latestDraftSources(tenantId) : null;
      const unread = kbId && draftSources ? await repository.unreadDocumentCount(tenantId, kbId, draftSources) : 0;
      return { ...base, used_bytes: usedBytes, documents: documents.map(documentView),
        profile: { revision: state?.revision ?? 0, current, confirmed_version: state?.confirmed_version ?? null,
          confirmed_at: state?.confirmed_at ?? null, confirmed_by_name: state?.confirmed_by_name ?? null,
          unread_document_count: unread },
        distill: distillView(state),
        history: history.map(row => ({ version: row.version, origin: row.origin, char_count: row.char_count,
          created_at: row.created_at, created_by_name: row.created_by_name })) };
    },

    /** One staged file into the context knowledge base, within the tenant's limit (checked under a lock). */
    async uploadDocument(actor: OrgContextActor, file: KbUploadedTempFile): Promise<OrgContextDocumentView> {
      assertEnabled(actor.tenantId);
      await assertReady(actor.tenantId);
      const kbId = await ensureContextKb(actor);
      const limit = deps.settings().max_bytes;
      // A file that cannot fit is refused before it is copied to Storage; the locked check below decides.
      const usedBefore = await repository.usedBytes(actor.tenantId, kbId);
      if (!orgContextFitsLimit(usedBefore, file.size, limit)) {
        fail('ORG_CONTEXT_LIMIT_REACHED', { used_bytes: usedBefore, limit_bytes: limit });
      }
      let staged: StagedKbSource | null = null;
      let created: KbDocument;
      try {
        staged = await deps.documents.stage(kbId, actor.tenantId, file);
        const source = staged;
        created = await deps.audited(async () => {
          await repository.lockUsage(actor.tenantId);
          const used = await repository.usedBytes(actor.tenantId, kbId);
          if (!orgContextFitsLimit(used, file.size, limit)) fail('ORG_CONTEXT_LIMIT_REACHED', { used_bytes: used, limit_bytes: limit });
          return deps.documents.createQueued(kbId, actor.tenantId, actor.userId, source);
        }, document => auditEntry(actor, 'CREATE', 'kb_document', { code: 'knowledgebase.document.created',
          context: { parent_name: ORG_CONTEXT_KB_NAME, file_name: document.name, file_size_bytes: file.size } },
        document.id, document.name));
      } catch (error) {
        // Nothing was committed: the staged Storage object has no document and goes.
        await deps.documents.discard(staged);
        throw error;
      }
      const row = await repository.readDocument(actor.tenantId, kbId, created.id) ?? fail('ORG_CONTEXT_UNAVAILABLE');
      return documentView(row);
    },

    async deleteDocument(actor: OrgContextActor, documentId: string): Promise<void> {
      assertEnabled(actor.tenantId);
      await assertSchema();
      const kbId = await repository.contextKbId(actor.tenantId) ?? fail('ORG_CONTEXT_DOCUMENT_NOT_FOUND');
      const document = await repository.findDocument(actor.tenantId, kbId, documentId)
        ?? fail('ORG_CONTEXT_DOCUMENT_NOT_FOUND');
      if (document.status === 'learning') fail('KB_DOCUMENT_LEARNING');
      const queued = await deps.audited(() => deps.documents.queueDeletion(documentId, kbId, actor.tenantId),
        result => result ? auditEntry(actor, 'DELETE', 'kb_document', { code: 'knowledgebase.document.deleted',
          context: { parent_name: ORG_CONTEXT_KB_NAME } }, documentId, result.document.name) : null);
      if (!queued) fail('ORG_CONTEXT_DOCUMENT_NOT_FOUND');
    },

    async requestDistill(actor: OrgContextActor, input: { expected_revision: number; locale: 'vi' | 'en' }):
      Promise<{ revision: number; distill: OrgContextDistillView }> {
      assertEnabled(actor.tenantId);
      await assertReady(actor.tenantId);
      if (await deps.creditExhausted(actor.tenantId)) fail('AI_CREDIT_LIMIT_REACHED');
      const kbId = await repository.contextKbId(actor.tenantId);
      const state = await deps.audited(async () => {
        const locked = await lockForChange(actor.tenantId, input.expected_revision);
        if (drafting(locked)) fail('ORG_CONTEXT_DISTILL_RUNNING');
        if (!kbId || !(await repository.learnedDocuments(actor.tenantId, kbId, 1)).length) {
          fail('ORG_CONTEXT_NO_LEARNED_DOCUMENTS');
        }
        return repository.queueDistill(actor.tenantId, { locale: input.locale, actorId: actor.userId });
      }, () => auditEntry(actor, 'UPDATE', PROFILE_ENTITY, { code: 'lesson_author.org_context.distill_requested' },
        actor.tenantId, ORG_CONTEXT_KB_NAME));
      return { revision: state.revision, distill: distillView(state) };
    },

    /** PUT /profile: normalise, then save as a new version or confirm (spec §3 PUT semantics). */
    async saveProfile(actor: OrgContextActor, input: { expected_revision: number; profile: unknown; confirm: boolean }):
      Promise<{ revision: number; current: OrgContextProfileVersionView | null; confirmed_version: number | null }> {
      assertEnabled(actor.tenantId);
      await assertSchema();
      const normalized = normalizeOrgContextProfile(input.profile);
      if (!normalized.ok) return fail('ORG_CONTEXT_PROFILE_INVALID', { ...normalized.issue });
      const profile = normalized.profile;
      const empty = input.confirm ? orgContextConfirmIssue(profile) : null;
      if (empty) fail('ORG_CONTEXT_PROFILE_INVALID', { ...empty });
      const saved = await deps.audited(async () => {
        const state = await lockForChange(actor.tenantId, input.expected_revision);
        if (drafting(state)) fail('ORG_CONTEXT_DISTILL_RUNNING');
        const current = await currentVersion(actor.tenantId, state);
        const decision = decideOrgContextSave({ current, confirmedVersion: state.confirmed_version, profile,
          confirm: input.confirm });
        if (decision.kind === 'unchanged') {
          return { event: null, view: { revision: state.revision, current, confirmed_version: state.confirmed_version } };
        }
        let version = current?.version ?? 0;
        if (decision.kind === 'new_version') {
          version = await repository.insertVersion(actor.tenantId, { origin: 'author_edit', profile,
            profileHash: orgContextProfileHash(profile), charCount: orgContextProfileCharCount(profile),
            createdBy: actor.userId });
        }
        const confirm = decision.kind === 'confirm_current' || decision.confirm;
        const updated = await repository.updateVersions(actor.tenantId, { currentVersion: version, confirm, actorId: actor.userId });
        const stored = await repository.readVersion(actor.tenantId, version) ?? fail('ORG_CONTEXT_UNAVAILABLE');
        return { event: confirm ? 'lesson_author.org_context.profile_confirmed' : 'lesson_author.org_context.profile_saved',
          view: { revision: updated.revision, current: stored, confirmed_version: updated.confirmed_version } };
      }, result => result.event && result.view.current ? auditEntry(actor, 'UPDATE', PROFILE_ENTITY,
        { code: result.event }, actor.tenantId, profileName(result.view.current.version)) : null);
      return saved.view;
    },

    /** A new version (origin restore) with the profile of an earlier one; not confirmed. */
    async restoreProfile(actor: OrgContextActor, input: { expected_revision: number; version: number }):
      Promise<{ revision: number; current: OrgContextProfileVersionView }> {
      assertEnabled(actor.tenantId);
      await assertSchema();
      return deps.audited(async () => {
        const state = await lockForChange(actor.tenantId, input.expected_revision);
        if (drafting(state)) fail('ORG_CONTEXT_DISTILL_RUNNING');
        const source = await repository.readVersion(actor.tenantId, input.version) ?? fail('ORG_CONTEXT_VERSION_NOT_FOUND');
        const version = await repository.insertVersion(actor.tenantId, { origin: 'restore', profile: source.profile,
          profileHash: source.profile_hash, charCount: source.char_count, createdBy: actor.userId,
          restoredFromVersion: source.version });
        const updated = await repository.updateVersions(actor.tenantId, { currentVersion: version, confirm: false,
          actorId: actor.userId });
        const current = await repository.readVersion(actor.tenantId, version) ?? fail('ORG_CONTEXT_UNAVAILABLE');
        return { revision: updated.revision, current };
      }, result => auditEntry(actor, 'UPDATE', PROFILE_ENTITY, { code: 'lesson_author.org_context.profile_restored' },
        actor.tenantId, profileName(result.current.version)));
    },

    async readVersion(tenantId: string, version: number): Promise<OrgContextProfileVersionView> {
      assertEnabled(tenantId);
      await assertSchema();
      return await repository.readVersion(tenantId, version) ?? fail('ORG_CONTEXT_VERSION_NOT_FOUND');
    },

    /**
     * The confirmed profile as the frozen wire object (launch), or null when none is confirmed or the
     * feature cannot run for the tenant; `lock` takes FOR SHARE on the state row in the launch transaction.
     */
    async confirmedContext(tenantId: string, lock: boolean): Promise<OrganizationContextV1 | null> {
      if (!enabledFor(tenantId) || !await schemaReady()) return null;
      const confirmed = await repository.confirmedContext(tenantId, lock);
      if (!confirmed) return null;
      const context = buildOrganizationContext(confirmed.version, confirmed.profile);
      // The stored hash is the one this code wrote; another one means the row is not what it claims.
      if (context.profile_hash !== confirmed.profile_hash) fail('ORG_CONTEXT_UNAVAILABLE');
      return context;
    },
  };
}

export type OrgContextService = ReturnType<typeof createOrgContextService>;
