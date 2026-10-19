import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// Characterization of the knowledge base service: every SQL statement
// (whitespace-normalized text and parameters), every outbound request (Storage
// and the AI provider, answered by a recording fetch; nothing leaves the
// process) and the result or error of the knowledge base and document reads
// and writes, the mutability checks, the restore job flow and its
// bookkeeping, the durable document operations (stage, create, retry, delete
// queues) and the knowledge base deletion queue, over a matrix of states and
// empty results. The golden file was written by the code before the KB
// repositories existed; moving SQL into repositories must keep every entry.
//
// A pg double answers every statement with one fixed row (or none, per case).
// Rewrite the golden file only for an intended change:
//   KB_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/kb/kb-sql.characterization.test.ts
// KB_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../../../config/redis.js');
const { env } = await import('../../../config/env.js');
Object.assign(env as Record<string, unknown>, {
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_KEY: 'test-service-key',
});
const { pool } = await import('../../../config/database.js');
const kb = await import('./kb.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kb-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.KB_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.KB_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const KB = 'c0000000-0000-4000-8000-000000000001';
const DOC = 'd0000000-0000-4000-8000-000000000001';
const DOC_2 = 'd0000000-0000-4000-8000-000000000002';
const JOB = 'e0000000-0000-4000-8000-000000000001';
const KNOWN_UUIDS = new Set([TENANT, USER, KB, DOC, DOC_2, JOB]);

/** Random values (ids, AES-GCM ciphertexts of a migrated key) read as placeholders; fixture ids stay. */
function stable(item: string): string {
  return item
    .replace(/^aes-256-gcm:v2:.*$/, '<ciphertext>')
    // An article's storage name ends with 8 random hex characters.
    .replace(/(kb-articles\/\d{8}\/[^/]*-d0000000-)[0-9a-f]{8}\.md/g, '$1<random>.md')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => (KNOWN_UUIDS.has(id) ? id : '<random-uuid>'));
}

/** One row with every column a KB statement reads. */
const ROW = {
  id: DOC, tenant_id: TENANT, kb_id: KB, name: 'Tài liệu A.pdf', description: 'Mô tả', type: 'file', status: 'learned',
  error_reason: null, source_info: { size: 10 }, file_path: `${TENANT}/kb-files/20261018/a.pdf`, content: null,
  created_by: USER, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
  document_count: 3, restore_required: false, restore_reason: null, restore_state: 'idle', active_restore_job_id: null,
  total_docs: '4', enqueued_docs: '1', learned_docs: '1', failed_docs: '0', skipped_docs: '1', full_count: '7',
  ai_active_engine: 'gemini_file_search', ai_transition_state: 'idle', ai_pending_engine: null, ai_transition_phase: 'copy',
  ai_transition_total_documents: '5', ai_transition_processed_documents: '2', ai_transition_cleanup_processed_documents: '0',
  ai_transition_last_error: null, transition_state: null, api_key_fingerprint: 'fp-current', remote_status: 'active',
  remote_error_reason: null, remote_error_code: null, store_id: 'store-1', store_name: 'fileSearchStores/kb-1',
  gemini_path: 'fileSearchStores/kb-1/documents/doc-1', exists: false, cnt: 0, document_id: DOC, tenant_id_text: TENANT,
  restore_docs: 3, encrypted_api_key: null, active_engine: 'gemini_file_search', provider: 'google_ai_studio',
  settings: null, api_key: null, locked: true,
};

type Answer = (text: string, index: number) => { rows: unknown[]; rowCount?: number } | undefined;

interface Statement {
  text: string;
  params: unknown[];
}

function plain(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === 'string' ? stable(item) : item));
}

function installDb(t: TestContext, answer?: Answer): { statements: Statement[]; requests: string[] } {
  const statements: Statement[] = [];
  const requests: string[] = [];
  const handle = async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    statements.push({ text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
    const custom = answer?.(text, statements.length - 1);
    const rows = custom?.rows ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(text) ? [] : [ROW]);
    return { rows, rowCount: custom?.rowCount ?? rows.length };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const request = input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/storage/v1/bucket')) requests.push(`${request.method} ${url.host}${url.pathname}`);
    const body = request.method === 'GET'
      ? { id: 'landa-storage', name: 'landa-storage', public: true }
      : url.pathname.includes('/object/sign/')
        ? { signedURL: `/object/sign/landa-storage/x?token=t` }
        : { Key: url.pathname };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  return { statements, requests };
}

interface Case {
  name: string;
  run: () => Promise<unknown>;
  answer?: Answer;
}
const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const noRowsWhen =
  (pattern: RegExp): Answer =>
  text =>
    pattern.test(text) ? { rows: [] } : undefined;
const rowsWhen =
  (pattern: RegExp, rows: unknown[], rowCount?: number): Answer =>
  text =>
    pattern.test(text) ? { rows, rowCount } : undefined;
const both =
  (...answers: Answer[]): Answer =>
  (text, index) => {
    for (const answer of answers) {
      const result = answer(text, index);
      if (result) return result;
    }
    return undefined;
  };

// The mutability check reads the KB with its store, the deletion queue and the AI engine transition.
const MUTABLE_KB = /FROM knowledgebases kb\s+LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id\s+WHERE kb.id = \$1 AND kb.tenant_id = \$2\s+LIMIT 1$/;
const DELETION_QUEUED = /AS exists/;
const TRANSITION = /FROM tenant_ai_settings\s+WHERE tenant_id = \$1\s+AND transition_state IN/;
const mutable: Answer = both(noRowsWhen(TRANSITION), rowsWhen(DELETION_QUEUED, [{ exists: false }]));
const withMutable = (...answers: Answer[]): Answer => both(...answers, mutable);
const MAPPINGS = /FROM kb_doc_gemini_mapping m\s+JOIN kb_documents d/;
const BLUEPRINTS = /UPDATE lesson_author_blueprints/;
const TRANSCRIPTS = /UPDATE lesson_author_transcription_jobs/;
const missingTable = (pattern: RegExp): Answer => (text) => {
  if (pattern.test(text)) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
  return undefined;
};

// ── Knowledge bases ──
add('list knowledgebases', () => kb.listKnowledgebases(TENANT));
add('list knowledgebases search page', () => kb.listKnowledgebases(TENANT, { page: 3, pageSize: 5, search: '  sổ tay ' }));
add('list knowledgebases empty', () => kb.listKnowledgebases(TENANT), noRowsWhen(/FROM knowledgebases kb\s+LEFT JOIN kb_google_store/));
add('list knowledgebases no progress', () =>
  kb.listKnowledgebases(TENANT),
  rowsWhen(/COUNT\(\*\) OVER\(\) AS full_count\s+FROM knowledgebases/, [{ ...ROW, total_docs: null, ai_transition_total_documents: null, restore_required: 1 }]),
);
add('get knowledgebase', () => kb.getKnowledgebase(KB, TENANT));
add('get knowledgebase missing', () => kb.getKnowledgebase(KB, TENANT), noRowsWhen(/FROM knowledgebases kb/));
add('create knowledgebase', () => kb.createKnowledgebase(TENANT, { name: 'KB A', description: undefined } as never, USER));
add('update knowledgebase', () => kb.updateKnowledgebase(KB, TENANT, { name: 'KB B', description: 'Mới' } as never));
add('update knowledgebase description only', () => kb.updateKnowledgebase(KB, TENANT, { description: '' } as never));
add('update knowledgebase nothing', () => kb.updateKnowledgebase(KB, TENANT, {} as never));
add('update knowledgebase missing', () => kb.updateKnowledgebase(KB, TENANT, { name: 'x' } as never), noRowsWhen(/UPDATE knowledgebases/));

// ── Documents ──
add('list documents', () => kb.listDocuments({ kbId: KB, tenantId: TENANT }));
add('list documents filtered', () =>
  kb.listDocuments({ kbId: KB, tenantId: TENANT, page: 2, pageSize: 5, search: ' quy trình ', status: ' learned ', type: ' faq ' }),
);
add('list documents blank filters', () => kb.listDocuments({ kbId: KB, tenantId: TENANT, search: ' ', status: '', type: ' ' }));
add('list documents empty', () => kb.listDocuments({ kbId: KB, tenantId: TENANT }), noRowsWhen(/FROM kb_documents/));
add('get document', () => kb.getDocument(DOC, TENANT));
add('get document missing', () => kb.getDocument(DOC, TENANT), noRowsWhen(/FROM kb_documents/));
add('delete document', () => kb.deleteDocument(DOC, KB, TENANT), withMutable(noRowsWhen(MAPPINGS)));
add('delete document with mappings', () => kb.deleteDocument(DOC, KB, TENANT), mutable);
add('delete document missing', () => kb.deleteDocument(DOC, KB, TENANT), noRowsWhen(/SELECT \* FROM kb_documents WHERE id = \$1 AND tenant_id = \$2/));
add('delete document of another kb', () => kb.deleteDocument(DOC, 'other-kb', TENANT));
add('delete document learning', () =>
  kb.deleteDocument(DOC, KB, TENANT),
  withMutable(rowsWhen(/SELECT \* FROM kb_documents WHERE id = \$1 AND tenant_id = \$2/, [{ ...ROW, status: 'learning' }])),
);
add('delete document blueprints table missing', () => kb.deleteDocument(DOC, KB, TENANT), withMutable(noRowsWhen(MAPPINGS), missingTable(BLUEPRINTS)));
add('delete document no row deleted', () =>
  kb.deleteDocument(DOC, KB, TENANT),
  withMutable(noRowsWhen(MAPPINGS), rowsWhen(/DELETE FROM kb_documents/, [], 0)),
);
add('delete document no file', () =>
  kb.deleteDocument(DOC, KB, TENANT),
  withMutable(noRowsWhen(MAPPINGS), rowsWhen(/SELECT \* FROM kb_documents WHERE id = \$1 AND tenant_id = \$2/, [{ ...ROW, file_path: null }])),
);
// Mutability refusals (through deleteDocument).
add('mutable kb missing', () => kb.deleteDocument(DOC, KB, TENANT), withMutable(noRowsWhen(MUTABLE_KB)));
add('mutable restore active', () => kb.deleteDocument(DOC, KB, TENANT), withMutable(rowsWhen(MUTABLE_KB, [{ ...ROW, restore_state: 'uploading' }])));
add('mutable deletion queued', () => kb.deleteDocument(DOC, KB, TENANT), both(rowsWhen(DELETION_QUEUED, [{ exists: true }]), noRowsWhen(TRANSITION)));
add('mutable transition active', () => kb.deleteDocument(DOC, KB, TENANT), both(rowsWhen(DELETION_QUEUED, [{ exists: false }]), rowsWhen(TRANSITION, [{ transition_state: 'running' }])));
for (const [label, store] of [
  ['key changed', { remote_status: 'key_changed', remote_error_reason: 'Key đã đổi' }],
  ['permission denied no reason', { remote_status: 'permission_denied', remote_error_reason: null }],
  ['fingerprint differs', { api_key_fingerprint: 'fp-old' }],
  ['inactive store', { remote_status: 'deleting' }],
  ['no store', { remote_status: null }],
] as const) {
  add(`mutable ${label}`, () => kb.deleteDocument(DOC, KB, TENANT), withMutable(noRowsWhen(MAPPINGS), rowsWhen(MUTABLE_KB, [{ ...ROW, ...store }])));
}
add('mutable no current key', () =>
  kb.deleteDocument(DOC, KB, TENANT),
  withMutable(noRowsWhen(MAPPINGS), rowsWhen(/secret.api_key_fingerprint/, [{ ...ROW, api_key_fingerprint: null }])),
);
add('bulk delete documents', () => kb.bulkDeleteDocuments([DOC, DOC_2], KB, TENANT), withMutable(noRowsWhen(MAPPINGS)));
add('bulk delete empty', () => kb.bulkDeleteDocuments([], KB, TENANT));
add('bulk delete all learning', () =>
  kb.bulkDeleteDocuments([DOC], KB, TENANT),
  withMutable(rowsWhen(/SELECT id, status FROM kb_documents/, [{ id: DOC, status: 'learning' }])),
);
add('bulk delete none found', () => kb.bulkDeleteDocuments([DOC], KB, TENANT), withMutable(noRowsWhen(/SELECT id, status FROM kb_documents/)));
add('bulk delete skips learning', () =>
  kb.bulkDeleteDocuments([DOC, DOC_2], KB, TENANT),
  withMutable(noRowsWhen(MAPPINGS), rowsWhen(/SELECT id, status FROM kb_documents/, [{ id: DOC, status: 'learning' }, { id: DOC_2, status: 'error' }])),
);
add('gemini mappings strict none', () => kb.deleteDocumentGeminiMappingsStrict([DOC], TENANT), noRowsWhen(MAPPINGS));
add('gemini mappings strict empty list', () => kb.deleteDocumentGeminiMappingsStrict([], TENANT));
add('gemini remote resources none', () => kb.deleteKbGeminiRemoteResources(KB, TENANT), noRowsWhen(/FROM kb_google_store|FROM kb_doc_gemini_mapping/));
add('update document status', () => kb.updateDocumentStatus(DOC, 'error', 'Lỗi tải'));
add('update document status none', () => kb.updateDocumentStatus(DOC, 'learned'), noRowsWhen(/WITH updated AS/));
add('link document gemini', () => kb.linkDocumentGemini(DOC, 'store-1', 'path/1'), noRowsWhen(/SELECT id FROM kb_doc_gemini_mapping/));
add('link document gemini exists', () => kb.linkDocumentGemini(DOC, 'store-1', 'path/1'));
add('link document gemini fails', () => kb.linkDocumentGemini(DOC, 'store-1', 'path/1'), (text) => {
  if (/INSERT INTO kb_doc_gemini_mapping/.test(text)) throw new Error('insert failed');
  return /SELECT id FROM kb_doc_gemini_mapping/.test(text) ? { rows: [] } : undefined;
});
add('faq template', async () => kb.generateFaqTemplate().length > 0);

// ── Restore bookkeeping ──
add('restore mark failed', () => kb.markKnowledgebaseRestoreFailed(JOB, KB, TENANT, 'x'.repeat(1200)));
add('restore set new store', () => kb.setRestoreJobNewStore(JOB, KB, TENANT, 'fileSearchStores/new'));
add('restore claim document', () => kb.claimRestoreDocumentForUpload(JOB, DOC, KB, TENANT));
add('restore claim document taken', () => kb.claimRestoreDocumentForUpload(JOB, DOC, KB, TENANT), rowsWhen(/SET status = 'uploading'/, [], 0));
add('restore reset document', () => kb.resetRestoreDocumentForRetry(JOB, DOC, KB, TENANT, 'Lỗi'));
add('restore document finished last ok', () =>
  kb.recordRestoreDocumentFinished(JOB, DOC, KB, TENANT, true),
  rowsWhen(/RETURNING total_docs/, [{ total_docs: 3, learned_docs: 2, failed_docs: 0, skipped_docs: 1 }]),
);
add('restore document finished last with failures', () =>
  kb.recordRestoreDocumentFinished(JOB, DOC, KB, TENANT, false, 'Không tải được'),
  rowsWhen(/RETURNING total_docs/, [{ total_docs: 2, learned_docs: 1, failed_docs: 1, skipped_docs: 0 }]),
);
add('restore document finished not last', () =>
  kb.recordRestoreDocumentFinished(JOB, DOC, KB, TENANT, true),
  rowsWhen(/RETURNING total_docs/, [{ total_docs: 9, learned_docs: 2, failed_docs: 0, skipped_docs: 0 }]),
);
add('restore document finished already', () => kb.recordRestoreDocumentFinished(JOB, DOC, KB, TENANT, true), rowsWhen(/RETURNING document_id/, [], 0));
add('restore document finished fails', () => kb.recordRestoreDocumentFinished(JOB, DOC, KB, TENANT, true), (text) => {
  if (/RETURNING total_docs/.test(text)) throw new Error('lock timeout');
  return undefined;
});
add('restore dispatch broker down', () => kb.dispatchKnowledgebaseRestore({ jobId: JOB, kbId: KB, tenantId: TENANT }));
add('restore redispatch', () => kb.redispatchRecoverableKnowledgebaseRestores(500), rowsWhen(/AS "jobId"/, [{ jobId: JOB, kbId: KB, tenantId: TENANT }]));
add('restore redispatch none', () => kb.redispatchRecoverableKnowledgebaseRestores(0), noRowsWhen(/AS "jobId"/));
add('restore release lock without redis', () => kb.releaseKnowledgebaseRestoreLock('lock', 'token'));
add('restore enqueue without key', () => kb.enqueueKnowledgebaseRestore(KB, TENANT));
add('restore run without key', () => kb.restoreKnowledgebase(KB, TENANT, JOB));
// A legacy tenant key (tenants.settings) is migrated on first use; the restore then runs.
const legacyKey = both(
  noRowsWhen(/FROM tenant_ai_provider_secrets\s+WHERE tenant_id = \$1 AND provider = \$2/),
  rowsWhen(/settings->>'gemini_api_key'/, [{ api_key: 'test-gemini-key' }]),
);
const RESTORE_KB = /FOR UPDATE OF kb/;
const RESTORE_JOB = /FROM kb_restore_jobs\s+WHERE id = \$1 AND kb_id = \$2 AND tenant_id = \$3\s+FOR UPDATE/;
const BUSY_DOCS = /status IN \('learning', 'deleting'\)/;
const STORES_FOR_UPDATE = /FROM kb_google_store\s+WHERE kb_id = \$1\s+FOR UPDATE/;
const QUEUED_RESTORE_DOCS = /SELECT document_id\s+FROM kb_restore_job_documents/;
add('restore enqueue key changed', () =>
  kb.enqueueKnowledgebaseRestore(KB, TENANT),
  both(legacyKey, rowsWhen(RESTORE_KB, [{ ...ROW, remote_status: 'key_changed', remote_error_reason: 'Key đã đổi' }]), rowsWhen(BUSY_DOCS, [{ cnt: 0 }])),
);
add('restore enqueue not needed', () => kb.enqueueKnowledgebaseRestore(KB, TENANT), both(legacyKey, rowsWhen(BUSY_DOCS, [{ cnt: 0 }])));
add('restore enqueue active', () => kb.enqueueKnowledgebaseRestore(KB, TENANT), both(legacyKey, rowsWhen(RESTORE_KB, [{ ...ROW, restore_state: 'restoring' }])));
add('restore enqueue missing', () => kb.enqueueKnowledgebaseRestore(KB, TENANT), both(legacyKey, noRowsWhen(RESTORE_KB)));
add('restore enqueue busy documents', () =>
  kb.enqueueKnowledgebaseRestore(KB, TENANT),
  both(legacyKey, rowsWhen(RESTORE_KB, [{ ...ROW, remote_status: 'not_found' }]), rowsWhen(BUSY_DOCS, [{ cnt: 2 }])),
);
add('restore run queued job', () =>
  kb.restoreKnowledgebase(KB, TENANT, JOB),
  both(
    legacyKey,
    rowsWhen(RESTORE_JOB, [{ status: 'queued' }]),
    rowsWhen(BUSY_DOCS, [{ cnt: 0 }]),
    rowsWhen(STORES_FOR_UPDATE, [{ ...ROW, remote_status: 'key_changed', remote_error_reason: null }]),
    rowsWhen(/COUNT\(\*\) FILTER/, [{ total_docs: 3, restore_docs: 2, skipped_docs: 1 }]),
    rowsWhen(QUEUED_RESTORE_DOCS, []),
  ),
);
add('restore run nothing to upload', () =>
  kb.restoreKnowledgebase(KB, TENANT, JOB),
  both(
    legacyKey,
    rowsWhen(RESTORE_JOB, [{ status: 'queued' }]),
    rowsWhen(BUSY_DOCS, [{ cnt: 0 }]),
    rowsWhen(STORES_FOR_UPDATE, [{ ...ROW, remote_status: 'permission_denied' }]),
    rowsWhen(/COUNT\(\*\) FILTER/, [{ total_docs: 1, restore_docs: 0, skipped_docs: 1 }]),
    rowsWhen(QUEUED_RESTORE_DOCS, []),
  ),
);
add('restore run resumes uploading', () =>
  kb.restoreKnowledgebase(KB, TENANT, JOB),
  both(legacyKey, rowsWhen(RESTORE_JOB, [{ status: 'uploading' }]), rowsWhen(QUEUED_RESTORE_DOCS, [])),
);
add('restore run publish fails', () =>
  kb.restoreKnowledgebase(KB, TENANT, JOB),
  both(legacyKey, rowsWhen(RESTORE_JOB, [{ status: 'uploading' }]), rowsWhen(QUEUED_RESTORE_DOCS, [{ document_id: DOC }])),
);
add('restore run finished job', () => kb.restoreKnowledgebase(KB, TENANT, JOB), both(legacyKey, rowsWhen(RESTORE_JOB, [{ status: 'completed' }])));
add('restore run missing job', () => kb.restoreKnowledgebase(KB, TENANT, JOB), both(legacyKey, noRowsWhen(RESTORE_JOB)));
add('restore run busy documents', () =>
  kb.restoreKnowledgebase(KB, TENANT, JOB),
  both(legacyKey, rowsWhen(RESTORE_JOB, [{ status: 'queued' }]), rowsWhen(BUSY_DOCS, [{ cnt: 1 }])),
);
add('restore run not needed', () =>
  kb.restoreKnowledgebase(KB, TENANT, JOB),
  both(legacyKey, rowsWhen(RESTORE_JOB, [{ status: 'queued' }]), rowsWhen(BUSY_DOCS, [{ cnt: 0 }]), noRowsWhen(STORES_FOR_UPDATE)),
);

// ── Durable document operations ──
add('stage text source', () => kb.stageTextBackedDocumentSource(KB, TENANT, { name: 'Bản chép.txt', content: 'Nội dung', sourceInfo: { origin: 'transcript' } }), mutable);
add('stage article source', () =>
  kb.stageArticleSource(KB, TENANT, { title: 'Quy Trình An Toàn', content: '<h1>A</h1><p>B &amp; C</p><img src="x"><ul><li>1</li></ul>' }, DOC),
  mutable,
);
add('stage article source refused', () => kb.stageArticleSource(KB, TENANT, { title: 'T', content: 'c' }, DOC), withMutable(noRowsWhen(MUTABLE_KB)));
add('discard staged source', () => kb.discardStagedKbSource({ storagePath: `${TENANT}/kb-files/x.pdf` }));
add('discard staged nothing', () => kb.discardStagedKbSource({ storagePath: null }));
add('create queued document', () =>
  kb.createQueuedDocumentFromStagedSource(KB, TENANT, USER, { storagePath: 'p/a.pdf', sourceInfo: { a: 1 }, content: null, name: 'a.pdf', type: 'file' }),
  withMutable(noRowsWhen(/FROM kb_operation_jobs\s+WHERE/)),
);
add('queue document deletion', () => kb.queueDocumentDeletion(DOC, KB, TENANT), mutable);
add('queue document deletion missing', () => kb.queueDocumentDeletion(DOC, KB, TENANT), withMutable(noRowsWhen(/SELECT \* FROM kb_documents\s+WHERE id = \$1 AND kb_id = \$2/)));
add('queue document deletion learning', () =>
  kb.queueDocumentDeletion(DOC, KB, TENANT),
  withMutable(rowsWhen(/SELECT \* FROM kb_documents\s+WHERE id = \$1 AND kb_id = \$2/, [{ ...ROW, status: 'learning' }])),
);
add('queue document deletion lost race', () => kb.queueDocumentDeletion(DOC, KB, TENANT), withMutable(rowsWhen(/DELETE FROM kb_documents/, [], 0)));
add('queue document deletion old schema', () => kb.queueDocumentDeletion(DOC, KB, TENANT), withMutable(missingTable(TRANSCRIPTS), missingTable(BLUEPRINTS)));
add('queue bulk deletion', () =>
  kb.queueBulkDocumentDeletion([DOC, DOC_2], KB, TENANT),
  withMutable(
    rowsWhen(/WHERE id = ANY\(\$1\) AND kb_id = \$2 AND tenant_id = \$3\s+AND status <> 'learning'/, [ROW, { ...ROW, id: DOC_2, file_path: null }]),
    rowsWhen(/SELECT document_id, gemini_path/, [{ document_id: DOC, gemini_path: 'g/1' }, { document_id: DOC, gemini_path: 'g/2' }]),
  ),
);
add('queue bulk deletion empty', () => kb.queueBulkDocumentDeletion([], KB, TENANT));
add('queue bulk deletion none deletable', () => kb.queueBulkDocumentDeletion([DOC], KB, TENANT), withMutable(noRowsWhen(/AND status <> 'learning'/)));
add('queue bulk deletion lost race', () => kb.queueBulkDocumentDeletion([DOC], KB, TENANT), withMutable(rowsWhen(/DELETE FROM kb_documents/, [], 0)));
add('queue retry', () => kb.queueDocumentRetry([DOC, DOC_2], KB, TENANT), mutable);
add('queue retry none', () => kb.queueDocumentRetry([DOC], KB, TENANT), withMutable(noRowsWhen(/SET status = 'learning', error_reason = NULL/)));
add('queue retry empty', () => kb.queueDocumentRetry([], KB, TENANT));
add('queue kb deletion', () => kb.queueKnowledgebaseDeletion(KB, TENANT), both(noRowsWhen(TRANSITION), rowsWhen(/AS cnt FROM/, [{ cnt: 0 }])));
add('queue kb deletion missing', () => kb.queueKnowledgebaseDeletion(KB, TENANT), noRowsWhen(/SELECT \* FROM knowledgebases/));
add('queue kb deletion bots', () => kb.queueKnowledgebaseDeletion(KB, TENANT), both(noRowsWhen(TRANSITION), rowsWhen(/FROM chatbots/, [{ cnt: 2 }]), rowsWhen(/AS cnt FROM/, [{ cnt: 0 }])));
add('queue kb deletion assigned', () => kb.queueKnowledgebaseDeletion(KB, TENANT), both(noRowsWhen(TRANSITION), rowsWhen(/FROM tenant_kb_assignments/, [{ cnt: 1 }]), rowsWhen(/AS cnt FROM/, [{ cnt: 0 }])));
add('queue kb deletion restoring', () =>
  kb.queueKnowledgebaseDeletion(KB, TENANT),
  both(noRowsWhen(TRANSITION), rowsWhen(/SELECT \* FROM knowledgebases/, [{ ...ROW, restore_state: 'queued' }])),
);
add('queue kb deletion transition', () => kb.queueKnowledgebaseDeletion(KB, TENANT), rowsWhen(TRANSITION, [{ transition_state: 'queued' }]));
const staged = { storagePath: 'p/new.md', sourceInfo: { title: 'T' }, content: 'C', name: 'T', type: 'article' as const };
add('update article', () => kb.updateArticleFromStagedSource(DOC, KB, TENANT, { expected_updated_at: '2026-10-02T00:00:00.000Z' } as never, staged), mutable);
add('update article stale', () => kb.updateArticleFromStagedSource(DOC, KB, TENANT, { expected_updated_at: '2026-10-01T00:00:00.000Z' } as never, staged), mutable);
add('update article missing', () => kb.updateArticleFromStagedSource(DOC, KB, TENANT, {} as never, staged), withMutable(noRowsWhen(/AND type = 'article'/)));
add('update article busy', () =>
  kb.updateArticleFromStagedSource(DOC, KB, TENANT, {} as never, staged),
  withMutable(rowsWhen(/AND type = 'article'/, [{ ...ROW, status: 'deleting' }])),
);
add('update article vanished', () => kb.updateArticleFromStagedSource(DOC, KB, TENANT, {} as never, staged), withMutable(noRowsWhen(/UPDATE kb_documents\s+SET name = \$1/)));

// ── Runner ──

function digest(outcome: unknown): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

const golden: Record<string, string> = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>)
  : {};
const written: Record<string, string> = {};
const full: Record<string, unknown> = {};

test('the case names are unique', () => {
  assert.equal(new Set(cases.map(item => item.name)).size, cases.length);
});

for (const item of cases) {
  test(`kb characterization: ${item.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const { statements, requests } = installDb(t, item.answer);
    let result: unknown;
    try {
      result = plain(await item.run());
    } catch (error) {
      const failure = error as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
      result = { thrown: failure?.name ?? null, message: failure?.message ?? String(error), statusCode: failure?.statusCode ?? null, code: failure?.code ?? null };
    }
    const outcome = {
      statements: statements.map(s => ({ sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      requests: requests.map(stable),
      result,
    };
    const value = digest(outcome);
    if (FULL_OUT) full[item.name] = outcome;
    if (WRITE_GOLDEN) {
      written[item.name] = value;
      return;
    }
    assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
    assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
  });
}

test('every golden entry still has its case', () => {
  if (FULL_OUT) writeFileSync(FULL_OUT, `${JSON.stringify(full, null, 1)}\n`);
  if (WRITE_GOLDEN) {
    const sorted = Object.fromEntries(Object.keys(written).sort().map(name => [name, written[name]]));
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
});
