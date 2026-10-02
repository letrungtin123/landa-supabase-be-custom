import { getClient } from '../../config/database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL = 'lesson_author_source_document_event';
const STATUSES = new Set(['learning', 'learned', 'error']);

export interface SourceDocumentHint {
  documentId: string;
  tenantId: string;
  kbId: string;
  status: 'learning' | 'learned' | 'error';
  updatedAt: string;
}

type Listener = (hint: SourceDocumentHint | null) => void;

/**
 * One LISTEN connection per backend process. PostgreSQL remains the durable
 * authority; NOTIFY only wakes exact-document subscribers after a committed
 * status transition. Browser count therefore does not create DB listeners.
 */
export function createSourceDocumentHub(dependencies: { getClient?: typeof getClient } = {}) {
  const acquire = dependencies.getClient ?? getClient;
  const listeners = new Map<string, Set<Listener>>();
  let client: Awaited<ReturnType<typeof getClient>> | null = null;
  let connecting: Promise<void> | null = null;
  let unavailable = false;

  function deliver(documentId: string, hint: SourceDocumentHint | null) {
    for (const listener of listeners.get(documentId)?.values() ?? []) {
      try { listener(hint); } catch { /* One socket observer cannot break fan-out. */ }
    }
  }
  function fail() {
    if (unavailable) return;
    unavailable = true;
    for (const documentId of listeners.keys()) deliver(documentId, null);
  }
  function readPayload(payload: string | undefined): SourceDocumentHint | null {
    try {
      const value = JSON.parse(payload ?? '') as Record<string, unknown>;
      if (typeof value.document_id !== 'string' || !UUID.test(value.document_id)
        || typeof value.tenant_id !== 'string' || !UUID.test(value.tenant_id)
        || typeof value.kb_id !== 'string' || !UUID.test(value.kb_id)
        || typeof value.status !== 'string' || !STATUSES.has(value.status)
        || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) return null;
      return { documentId: value.document_id, tenantId: value.tenant_id, kbId: value.kb_id,
        status: value.status as SourceDocumentHint['status'], updatedAt: value.updated_at };
    } catch { return null; }
  }
  async function ensure(): Promise<void> {
    if (client) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const next = await acquire();
      next.on('notification', message => {
        if (message.channel !== CHANNEL) return;
        const hint = readPayload(message.payload);
        if (hint) deliver(hint.documentId, hint);
      });
      next.on('error', () => { client = null; fail(); });
      try { await next.query(`LISTEN ${CHANNEL}`); }
      catch (error) { next.release(); throw error; }
      client = next; unavailable = false;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  return {
    async subscribe(documentId: string, listener: Listener) {
      if (!UUID.test(documentId)) throw new Error('SOURCE_STREAM_INPUT_INVALID');
      await ensure();
      const set = listeners.get(documentId) ?? new Set<Listener>();
      set.add(listener); listeners.set(documentId, set);
      return () => {
        const current = listeners.get(documentId); if (!current) return;
        current.delete(listener); if (!current.size) listeners.delete(documentId);
      };
    },
    async stop() {
      const current = client; client = null; listeners.clear(); unavailable = false;
      if (!current) return;
      try { await current.query(`UNLISTEN ${CHANNEL}`); } catch { /* release below */ }
      current.release();
    },
  };
}

export const sourceDocumentHub = createSourceDocumentHub();
