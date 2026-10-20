import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransactionalAuditEntry } from '../../../../middleware/audit-log.js';
import type { KbDocument } from '../../kb/kb.types.js';
import type { StagedKbSource } from '../../kb/kb-document-operations.service.js';
import {
  emptyOrgContextProfile, orgContextProfileCharCount, orgContextProfileHash, type OrgContextProfileV1,
} from '../contracts/lesson-author-org-context.contract.js';
import type { OrgContextRepository, OrgContextStateRow, OrgContextVersionRow } from './lesson-author-org-context.repository.js';
import { createOrgContextService, type OrgContextActor } from './lesson-author-org-context.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = uuid(1), OTHER = uuid(2), USER = uuid(3);
const MB = 1024 * 1024, LIMIT = 50 * MB;
const actor: OrgContextActor = { tenantId: TENANT, userId: USER, username: 'author', ipAddress: '127.0.0.1' };

interface Doc { id: string; tenant: string; kb: string; name: string; status: string; size: number; created: number }
interface Version extends Omit<OrgContextVersionRow, 'created_by_name'> { tenant: string; sources: string[] | null }
interface State { revision: number; current_version: number | null; confirmed_version: number | null;
  confirmed_at: string | null; distill_status: OrgContextStateRow['distill_status']; requested_at: string | null }

/** In-memory database behind the repository interface; transactions roll back on a throw. */
function fixture(options: { enabled?: boolean; allowlist?: string[]; schema?: boolean; engine?: string; deployed?: boolean;
  providerKey?: boolean; exhausted?: boolean } = {}) {
  const db = { kbs: new Map<string, string>(), docs: [] as Doc[], states: new Map<string, State>(), versions: [] as Version[] };
  const calls = { stage: 0, discard: 0, createdKb: 0, lockUsage: 0, deletions: [] as string[], invalidated: 0 };
  const audits: TransactionalAuditEntry[] = [];
  const flags = { raceOnKbCreate: false, raceOnLock: 0, concurrentKb: null as string | null };
  let next = 100;
  const snapshot = () => structuredClone({ kbs: [...db.kbs], docs: db.docs, states: [...db.states], versions: db.versions });
  const restore = (saved: ReturnType<typeof snapshot>) => {
    db.kbs = new Map(saved.kbs); db.docs = saved.docs; db.states = new Map(saved.states); db.versions = saved.versions;
  };
  const inTransaction = async <T>(work: () => Promise<T>): Promise<T> => {
    const saved = snapshot();
    try { return await work(); } catch (error) { restore(saved); throw error; }
  };
  const state = (tenant: string): OrgContextStateRow | null => {
    const row = db.states.get(tenant);
    return row ? { revision: row.revision, current_version: row.current_version, confirmed_version: row.confirmed_version,
      confirmed_at: row.confirmed_at, confirmed_by_name: row.confirmed_at ? 'Tác giả' : null, distill_status: row.distill_status,
      distill_requested_at: row.requested_at, distill_finished_at: null, distill_error_code: null } : null;
  };
  const versionRow = (row: Version): OrgContextVersionRow => ({ version: row.version, origin: row.origin,
    profile: structuredClone(row.profile), char_count: row.char_count, profile_hash: row.profile_hash,
    created_at: row.created_at, created_by_name: 'Tác giả' });
  const docRow = (doc: Doc) => ({ id: doc.id, name: doc.name, status: doc.status, error_reason: null, size_bytes: doc.size,
    created_at: new Date(doc.created).toISOString(), created_by_name: 'Tác giả' });
  const repository: OrgContextRepository = {
    schemaReady: async () => options.schema !== false,
    contextKbId: async tenant => db.kbs.get(tenant) ?? flags.concurrentKb,
    insertContextKb: async tenant => {
      calls.createdKb++;
      // Another request committed its knowledge base first (outside this transaction).
      if (flags.raceOnKbCreate) { flags.concurrentKb = uuid(900); throw Object.assign(new Error('duplicate'), { code: '23505' }); }
      const id = uuid(next++); db.kbs.set(tenant, id); return id;
    },
    lockUsage: async () => {
      calls.lockUsage++;
      if (flags.raceOnLock) db.docs.push({ id: uuid(next++), tenant: TENANT, kb: db.kbs.get(TENANT)!, name: 'race.pdf',
        status: 'learning', size: flags.raceOnLock, created: Date.now() });
    },
    usedBytes: async (tenant, kb) => db.docs.filter(doc => doc.tenant === tenant && doc.kb === kb)
      .reduce((sum, doc) => sum + doc.size, 0),
    listDocuments: async (tenant, kb, limit) => db.docs.filter(doc => doc.tenant === tenant && doc.kb === kb)
      .sort((a, b) => b.created - a.created).slice(0, limit).map(docRow),
    readDocument: async (tenant, kb, id) => {
      const doc = db.docs.find(item => item.id === id && item.tenant === tenant && item.kb === kb);
      return doc ? docRow(doc) : null;
    },
    findDocument: async (tenant, kb, id) => {
      const doc = db.docs.find(item => item.id === id && item.tenant === tenant && item.kb === kb);
      return doc ? { id: doc.id, name: doc.name, status: doc.status } : null;
    },
    learnedDocuments: async (tenant, kb, limit) => db.docs.filter(doc => doc.tenant === tenant && doc.kb === kb
      && doc.status === 'learned').slice(0, limit).map(doc => ({ id: doc.id, size_bytes: doc.size })),
    unreadDocumentCount: async (tenant, kb, read) => db.docs.filter(doc => doc.tenant === tenant && doc.kb === kb
      && doc.status === 'learned' && !read.includes(doc.id)).length,
    readState: async tenant => state(tenant),
    lockState: async tenant => {
      if (!db.states.has(tenant)) db.states.set(tenant, { revision: 0, current_version: null, confirmed_version: null,
        confirmed_at: null, distill_status: 'idle', requested_at: null });
      return state(tenant)!;
    },
    readVersion: async (tenant, version) => {
      const row = db.versions.find(item => item.tenant === tenant && item.version === version);
      return row ? versionRow(row) : null;
    },
    history: async (tenant, limit) => db.versions.filter(row => row.tenant === tenant).sort((a, b) => b.version - a.version)
      .slice(0, limit).map(row => ({ version: row.version, origin: row.origin, char_count: row.char_count,
        created_at: row.created_at, created_by_name: 'Tác giả' })),
    latestDraftSources: async tenant => {
      const drafts = db.versions.filter(row => row.tenant === tenant && row.origin === 'ai_draft');
      return drafts.length ? drafts.at(-1)!.sources ?? [] : null;
    },
    insertVersion: async (tenant, input) => {
      const version = Math.max(0, ...db.versions.filter(row => row.tenant === tenant).map(row => row.version)) + 1;
      db.versions.push({ tenant, version, origin: input.origin, profile: structuredClone(input.profile),
        char_count: input.charCount, profile_hash: input.profileHash, created_at: new Date(Date.UTC(2026, 9, 20, 0, version))
          .toISOString(), sources: input.sourceDocumentIds ? [...input.sourceDocumentIds] : null });
      return version;
    },
    updateVersions: async (tenant, input) => {
      const row = db.states.get(tenant)!;
      row.revision += 1; row.current_version = input.currentVersion;
      if (input.confirm) { row.confirmed_version = input.currentVersion; row.confirmed_at = '2026-10-20T01:00:00.000Z'; }
      return { revision: row.revision, confirmed_version: row.confirmed_version };
    },
    queueDistill: async tenant => {
      const row = db.states.get(tenant)!;
      row.revision += 1; row.distill_status = 'queued'; row.requested_at = '2026-10-20T02:00:00.000Z';
      return state(tenant)!;
    },
    confirmedContext: async tenant => {
      const row = db.states.get(tenant);
      const version = row?.confirmed_version ? db.versions.find(item => item.tenant === tenant
        && item.version === row.confirmed_version) : undefined;
      return version ? { version: version.version, profile: structuredClone(version.profile),
        profile_hash: version.profile_hash } : null;
    },
  };
  const service = createOrgContextService({
    repository,
    transaction: work => inTransaction(work),
    audited: (work, entry) => inTransaction(async () => {
      const result = await work();
      const audit = entry(result);
      if (audit) audits.push(audit);
      return result;
    }),
    settings: () => ({ enabled: options.enabled !== false, tenant_allowlist: options.allowlist ?? [], max_bytes: LIMIT }),
    readiness: async () => ({ engine: options.engine ?? 'self_built_rag', deployed: options.deployed !== false,
      providerKey: options.providerKey !== false }),
    documents: {
      stage: async (_kb, _tenant, file) => { calls.stage++; return { storagePath: `staged/${file.originalname}`,
        sourceInfo: { size: file.size }, content: null, name: file.originalname, type: 'file' } satisfies StagedKbSource; },
      createQueued: async (kb, tenant, userId, staged) => {
        const doc: Doc = { id: uuid(next++), tenant, kb, name: staged.name, status: 'learning',
          size: Number(staged.sourceInfo.size), created: Date.now() + next };
        db.docs.push(doc);
        return { id: doc.id, tenant_id: tenant, kb_id: kb, type: 'file', name: doc.name, status: 'learning', error_reason: null,
          source_info: staged.sourceInfo, file_path: staged.storagePath, content: null, created_by: userId,
          created_at: new Date(doc.created).toISOString(), updated_at: new Date(doc.created).toISOString() } satisfies KbDocument;
      },
      discard: async staged => { if (staged) calls.discard++; },
      queueDeletion: async (id, kb, tenant) => {
        const index = db.docs.findIndex(doc => doc.id === id && doc.kb === kb && doc.tenant === tenant);
        if (index < 0) return null;
        const [doc] = db.docs.splice(index, 1);
        calls.deletions.push(id);
        return { document: { id, name: doc!.name } as KbDocument };
      },
    },
    knowledgebaseCreated: async () => { calls.invalidated++; },
    creditExhausted: async () => options.exhausted === true,
  });
  const file = (name: string, size: number) => ({ path: `/tmp/${name}`, originalname: name, mimetype: 'application/pdf', size });
  const addDoc = (status: string, size = MB, tenant = TENANT) => {
    if (!db.kbs.has(tenant)) db.kbs.set(tenant, uuid(next++));
    const doc: Doc = { id: uuid(next++), tenant, kb: db.kbs.get(tenant)!, name: `tai-lieu-${next}.pdf`, status, size,
      created: next };
    db.docs.push(doc);
    return doc;
  };
  return { service, db, calls, audits, flags, file, addDoc };
}

const PROFILE: OrgContextProfileV1 = { ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu.',
  products_services: ['Máy in'] };
const codeOf = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  const value = error as { code?: string; details?: Record<string, unknown> };
  assert.equal(value.code, code);
  if (details) assert.deepEqual(value.details, details);
  return true;
};

test('the feature gate: off (or a tenant outside the allow-list) reads {enabled:false} and refuses every change', async () => {
  for (const f of [fixture({ enabled: false }), fixture({ allowlist: [OTHER] })]) {
    assert.deepEqual(await f.service.getState(TENANT), { enabled: false });
    await assert.rejects(f.service.uploadDocument(actor, f.file('a.pdf', 10)), codeOf('ORG_CONTEXT_DISABLED'));
    await assert.rejects(f.service.saveProfile(actor, { expected_revision: 0, profile: PROFILE, confirm: false }),
      codeOf('ORG_CONTEXT_DISABLED'));
    await assert.rejects(f.service.readVersion(TENANT, 1), codeOf('ORG_CONTEXT_DISABLED'));
    assert.equal(await f.service.confirmedContext(TENANT, false), null);
    assert.equal(f.service.enabledFor(TENANT), false);
  }
  assert.equal(fixture({ allowlist: [TENANT.toUpperCase()] }).service.enabledFor(TENANT), true);
});

test('readiness: schema, engine, deployment, provider key; ready exactly when there is no reason', async () => {
  const cases: Array<[Parameters<typeof fixture>[0], string | null]> = [[{ schema: false }, 'schema'],
    [{ engine: 'gemini_file_search' }, 'engine'], [{ deployed: false }, 'not_deployed'], [{ providerKey: false }, 'provider_key'],
    [{}, null]];
  for (const [options, reason] of cases) {
    const state = await fixture(options).service.getState(TENANT);
    assert.ok(state.enabled);
    assert.equal(state.not_ready_reason, reason);
    assert.equal(state.ready, reason === null);
    assert.equal(state.limit_bytes, LIMIT);
  }
  const blank = await fixture({ schema: false }).service.getState(TENANT);
  assert.deepEqual(blank, { enabled: true, ready: false, not_ready_reason: 'schema', limit_bytes: LIMIT, used_bytes: 0,
    documents: [], history: [], distill: { status: 'idle', requested_at: null, finished_at: null, error_code: null },
    profile: { revision: 0, current: null, confirmed_version: null, confirmed_at: null, confirmed_by_name: null,
      unread_document_count: 0 } });
  await assert.rejects(fixture({ deployed: false }).service.uploadDocument(actor, fixture().file('a.pdf', 1)),
    codeOf('ORG_CONTEXT_NOT_DEPLOYED'));
  await assert.rejects(fixture({ engine: 'gemini_file_search' }).service.requestDistill(actor, { expected_revision: 0,
    locale: 'vi' }), codeOf('ORG_CONTEXT_NOT_READY'));
  await assert.rejects(fixture({ schema: false }).service.saveProfile(actor, { expected_revision: 0, profile: PROFILE,
    confirm: false }), codeOf('ORG_CONTEXT_NOT_READY'));
});

test('upload: the context knowledge base is created once, the file is audited and listed', async () => {
  const f = fixture();
  const first = await f.service.uploadDocument(actor, f.file('so-tay.pdf', 2 * MB));
  assert.deepEqual({ ...first, created_at: 'x' }, { id: first.id, name: 'so-tay.pdf', size_bytes: 2 * MB, status: 'learning',
    error_reason: null, created_at: 'x', created_by_name: 'Tác giả' });
  await f.service.uploadDocument(actor, f.file('quy-trinh.docx', MB));
  assert.equal(f.calls.createdKb, 1);
  assert.equal(f.calls.invalidated, 1);
  assert.equal(f.calls.lockUsage, 2, 'the size check runs under the tenant lock every time');
  assert.deepEqual(f.audits.map(entry => [entry.event.code, entry.entityType, entry.event.context?.parent_name,
    entry.event.context?.file_size_bytes]), [['knowledgebase.document.created', 'kb_document', 'AI ID – Ngữ cảnh doanh nghiệp',
    2 * MB], ['knowledgebase.document.created', 'kb_document', 'AI ID – Ngữ cảnh doanh nghiệp', MB]]);
  const state = await f.service.getState(TENANT);
  assert.ok(state.enabled);
  assert.equal(state.used_bytes, 3 * MB);
  assert.deepEqual(state.documents.map(doc => doc.name), ['quy-trinh.docx', 'so-tay.pdf']);
  assert.equal(typeof state.documents[0]!.size_bytes, 'number');
});

test('upload: a knowledge base created by a concurrent request is reused', async () => {
  const f = fixture();
  f.flags.raceOnKbCreate = true;
  await f.service.uploadDocument(actor, f.file('a.pdf', 10));
  assert.equal(f.db.docs[0]!.kb, uuid(900));
});

test('upload limit: exactly 50 MB fits; one byte more is refused before Storage, or under the lock', async () => {
  const f = fixture();
  f.addDoc('learned', LIMIT - 10);
  await f.service.uploadDocument(actor, f.file('fits.pdf', 10));
  await assert.rejects(f.service.uploadDocument(actor, f.file('over.pdf', 1)),
    codeOf('ORG_CONTEXT_LIMIT_REACHED', { used_bytes: LIMIT, limit_bytes: LIMIT }));
  assert.equal(f.calls.stage, 1, 'a file that cannot fit is never staged');
  // Another upload commits between the early check and the locked one: the staged copy goes.
  const g = fixture();
  g.addDoc('learned', LIMIT - 10);
  g.flags.raceOnLock = 5;
  await assert.rejects(g.service.uploadDocument(actor, g.file('late.pdf', 10)),
    codeOf('ORG_CONTEXT_LIMIT_REACHED', { used_bytes: LIMIT - 5, limit_bytes: LIMIT }));
  assert.equal(g.calls.stage, 1);
  assert.equal(g.calls.discard, 1);
  assert.equal(g.db.docs.length, 1, 'the transaction rolled back');
});

test('delete: only the tenant\'s own context document, never one being read', async () => {
  const f = fixture();
  const learning = f.addDoc('learning');
  const learned = f.addDoc('learned');
  const foreign = f.addDoc('learned', MB, OTHER);
  await assert.rejects(f.service.deleteDocument(actor, learning.id), codeOf('KB_DOCUMENT_LEARNING'));
  await assert.rejects(f.service.deleteDocument(actor, foreign.id), codeOf('ORG_CONTEXT_DOCUMENT_NOT_FOUND'));
  await assert.rejects(f.service.deleteDocument(actor, uuid(999)), codeOf('ORG_CONTEXT_DOCUMENT_NOT_FOUND'));
  await f.service.deleteDocument(actor, learned.id);
  assert.deepEqual(f.calls.deletions, [learned.id]);
  assert.deepEqual(f.audits.map(entry => entry.event.code), ['knowledgebase.document.deleted']);
  await assert.rejects(fixture().service.deleteDocument(actor, learned.id), codeOf('ORG_CONTEXT_DOCUMENT_NOT_FOUND'));
});

test('distill request: revision, running draft, learned documents and AI points are checked; it queues', async () => {
  const f = fixture();
  await assert.rejects(f.service.requestDistill(actor, { expected_revision: 0, locale: 'vi' }),
    codeOf('ORG_CONTEXT_NO_LEARNED_DOCUMENTS'));
  f.addDoc('learning');
  await assert.rejects(f.service.requestDistill(actor, { expected_revision: 0, locale: 'vi' }),
    codeOf('ORG_CONTEXT_NO_LEARNED_DOCUMENTS'));
  f.addDoc('learned');
  await assert.rejects(f.service.requestDistill(actor, { expected_revision: 3, locale: 'vi' }),
    codeOf('ORG_CONTEXT_REVISION_CONFLICT'));
  assert.equal(f.db.states.size, 0, 'a refused request writes nothing');
  const queued = await f.service.requestDistill(actor, { expected_revision: 0, locale: 'en' });
  assert.deepEqual(queued, { revision: 1, distill: { status: 'queued', requested_at: '2026-10-20T02:00:00.000Z',
    finished_at: null, error_code: null } });
  assert.deepEqual(f.audits.map(entry => [entry.event.code, entry.entityType]),
    [['lesson_author.org_context.distill_requested', 'lesson_author_org_context']]);
  await assert.rejects(f.service.requestDistill(actor, { expected_revision: 1, locale: 'vi' }),
    codeOf('ORG_CONTEXT_DISTILL_RUNNING'));
  await assert.rejects(f.service.saveProfile(actor, { expected_revision: 1, profile: PROFILE, confirm: false }),
    codeOf('ORG_CONTEXT_DISTILL_RUNNING'));
  await assert.rejects(f.service.restoreProfile(actor, { expected_revision: 1, version: 1 }), codeOf('ORG_CONTEXT_DISTILL_RUNNING'));
  const spent = fixture({ exhausted: true });
  spent.addDoc('learned');
  await assert.rejects(spent.service.requestDistill(actor, { expected_revision: 0, locale: 'vi' }),
    codeOf('AI_CREDIT_LIMIT_REACHED'));
});

test('PUT profile: a new version, a no-op for the same profile, confirm, conflict, invalid and empty', async () => {
  const f = fixture();
  const saved = await f.service.saveProfile(actor, { expected_revision: 0, profile: PROFILE, confirm: false });
  assert.equal(saved.revision, 1);
  assert.equal(saved.confirmed_version, null);
  assert.deepEqual({ ...saved.current, created_at: 'x' }, { version: 1, origin: 'author_edit', profile: PROFILE,
    char_count: orgContextProfileCharCount(PROFILE), profile_hash: orgContextProfileHash(PROFILE), created_at: 'x',
    created_by_name: 'Tác giả' });
  // The same profile after normalisation (other spaces) is no change: no version, no revision, no audit.
  const same = await f.service.saveProfile(actor, { expected_revision: 1, profile: { ...PROFILE,
    organization_summary: '  Công   ty mẫu.  ', products_services: ['Máy in', ''] }, confirm: false });
  assert.equal(same.revision, 1);
  assert.equal(f.db.versions.length, 1);
  assert.equal(f.audits.length, 1);
  // Confirming the current version: no new version, the revision moves.
  const confirmed = await f.service.saveProfile(actor, { expected_revision: 1, profile: PROFILE, confirm: true });
  assert.deepEqual([confirmed.revision, confirmed.confirmed_version, f.db.versions.length], [2, 1, 1]);
  const again = await f.service.saveProfile(actor, { expected_revision: 2, profile: PROFILE, confirm: true });
  assert.equal(again.revision, 2, 'confirming the confirmed version again changes nothing');
  // A changed profile with confirm: new version, confirmed at once.
  const edited = await f.service.saveProfile(actor, { expected_revision: 2, profile: { ...PROFILE, culture_tone: 'Thân thiện.' },
    confirm: true });
  assert.deepEqual([edited.revision, edited.confirmed_version, edited.current?.version], [3, 2, 2]);
  assert.deepEqual(f.audits.map(entry => entry.event.code), ['lesson_author.org_context.profile_saved',
    'lesson_author.org_context.profile_confirmed', 'lesson_author.org_context.profile_confirmed']);
  assert.deepEqual(f.audits.map(entry => entry.entityName), ['Hồ sơ doanh nghiệp v1', 'Hồ sơ doanh nghiệp v1',
    'Hồ sơ doanh nghiệp v2']);
  // Optimistic concurrency: a stale revision writes nothing.
  await assert.rejects(f.service.saveProfile(actor, { expected_revision: 2, profile: { ...PROFILE, culture_tone: 'Khác.' },
    confirm: false }), codeOf('ORG_CONTEXT_REVISION_CONFLICT'));
  assert.equal(f.db.versions.length, 2);
  await assert.rejects(f.service.saveProfile(actor, { expected_revision: 3, profile: { ...PROFILE, extra: 1 }, confirm: false }),
    codeOf('ORG_CONTEXT_PROFILE_INVALID', { path: 'profile', reason: 'shape' }));
  await assert.rejects(f.service.saveProfile(actor, { expected_revision: 3, profile: { ...PROFILE,
    organization_summary: 'a'.repeat(801) }, confirm: false }),
  codeOf('ORG_CONTEXT_PROFILE_INVALID', { path: 'profile.organization_summary', reason: 'too_long' }));
  await assert.rejects(f.service.saveProfile(actor, { expected_revision: 3, profile: emptyOrgContextProfile(), confirm: true }),
    codeOf('ORG_CONTEXT_PROFILE_INVALID', { path: 'profile', reason: 'empty' }));
  // An empty draft may be saved (not confirmed).
  const emptyDraft = await f.service.saveProfile(actor, { expected_revision: 3, profile: emptyOrgContextProfile(), confirm: false });
  assert.deepEqual([emptyDraft.revision, emptyDraft.confirmed_version, emptyDraft.current?.version], [4, 2, 3]);
});

test('restore: a new unconfirmed version with the earlier profile; unknown version and stale revision refused', async () => {
  const f = fixture();
  await f.service.saveProfile(actor, { expected_revision: 0, profile: PROFILE, confirm: false });
  await f.service.saveProfile(actor, { expected_revision: 1, profile: { ...PROFILE, culture_tone: 'Mới.' }, confirm: true });
  await assert.rejects(f.service.restoreProfile(actor, { expected_revision: 2, version: 9 }), codeOf('ORG_CONTEXT_VERSION_NOT_FOUND'));
  await assert.rejects(f.service.restoreProfile(actor, { expected_revision: 1, version: 1 }), codeOf('ORG_CONTEXT_REVISION_CONFLICT'));
  const restored = await f.service.restoreProfile(actor, { expected_revision: 2, version: 1 });
  assert.equal(restored.revision, 3);
  assert.deepEqual([restored.current.version, restored.current.origin, restored.current.profile], [3, 'restore', PROFILE]);
  const state = await f.service.getState(TENANT);
  assert.ok(state.enabled);
  assert.deepEqual([state.profile.confirmed_version, state.profile.current?.version], [2, 3]);
  assert.deepEqual(state.history.map(row => [row.version, row.origin]), [[3, 'restore'], [2, 'author_edit'], [1, 'author_edit']]);
  assert.equal(f.audits.at(-1)!.event.code, 'lesson_author.org_context.profile_restored');
});

test('versions and the confirmed context are the tenant\'s own; the frozen object verifies', async () => {
  const f = fixture();
  assert.equal(await f.service.confirmedContext(TENANT, false), null);
  await f.service.saveProfile(actor, { expected_revision: 0, profile: PROFILE, confirm: true });
  assert.deepEqual(await f.service.confirmedContext(TENANT, true), { profile_version: 1,
    profile_hash: orgContextProfileHash(PROFILE), profile: PROFILE });
  assert.equal(await f.service.confirmedContext(OTHER, false), null);
  await assert.rejects(f.service.readVersion(OTHER, 1), codeOf('ORG_CONTEXT_VERSION_NOT_FOUND'));
  assert.equal((await f.service.readVersion(TENANT, 1)).version, 1);
  f.db.versions[0]!.profile_hash = 'f'.repeat(64);
  await assert.rejects(f.service.confirmedContext(TENANT, false), codeOf('ORG_CONTEXT_UNAVAILABLE'));
});

test('state: unread documents count learned files the latest AI draft did not read (0 without a draft)', async () => {
  const f = fixture();
  const read = f.addDoc('learned');
  f.addDoc('learned');
  f.addDoc('error');
  let state = await f.service.getState(TENANT);
  assert.ok(state.enabled);
  assert.equal(state.profile.unread_document_count, 0);
  f.db.versions.push({ tenant: TENANT, version: 1, origin: 'ai_draft', profile: PROFILE, char_count: 1,
    profile_hash: orgContextProfileHash(PROFILE), created_at: '2026-10-20T00:00:00.000Z', sources: [read.id] });
  state = await f.service.getState(TENANT);
  assert.ok(state.enabled);
  assert.equal(state.profile.unread_document_count, 1);
  assert.deepEqual(state.documents.map(doc => doc.status).sort(), ['error', 'learned', 'learned']);
});
