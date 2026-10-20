import { getSessionClient } from '../../../../config/database.js';
import { listenRetryDelayMs } from '../shared/lesson-author-listen-retry.logic.js';
import { UUID_PATTERN, isUuid } from '../../../../utils/uuid.js';

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
export function createSourceDocumentHub(dependencies: { getClient?: typeof getSessionClient; now?: () => number } = {}) {
  const acquire = dependencies.getClient ?? getSessionClient; // LISTEN: its own server session
  const now = dependencies.now ?? (() => Date.now());
  const listeners = new Map<string, Set<Listener>>();
  // The pool connection that holds LISTEN; release() hands it back exactly once.
  let connection: { client: Awaited<ReturnType<typeof getSessionClient>>; release: (error?: Error) => void } | null = null;
  let connecting: Promise<void> | null = null;
  let unavailable = false;
  let consecutiveFailures = 0;
  let retryAt = 0;

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
      if (!isUuid(value.document_id)
        || !isUuid(value.tenant_id)
        || !isUuid(value.kb_id)
        || typeof value.status !== 'string' || !STATUSES.has(value.status)
        || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) return null;
      return { documentId: value.document_id, tenantId: value.tenant_id, kbId: value.kb_id,
        status: value.status as SourceDocumentHint['status'], updatedAt: value.updated_at };
    } catch { return null; }
  }
  function noteFailure() {
    consecutiveFailures += 1;
    retryAt = now() + listenRetryDelayMs(consecutiveFailures);
  }
  async function ensure(): Promise<void> {
    if (connection) return;
    if (connecting) return connecting;
    // After a failure the next LISTEN attempt waits (the stream answers 503 and the browser retries).
    if (now() < retryAt) throw new Error('SOURCE_STREAM_LISTEN_RETRY_PENDING');
    connecting = (async () => {
      let next: Awaited<ReturnType<typeof getSessionClient>>;
      try { next = await acquire(); } catch (error) { noteFailure(); throw error; }
      let released = false;
      const release = (error?: Error) => {
        if (released) return;
        released = true;
        // With an error the pool closes the connection instead of reusing it.
        if (error) next.release(error); else next.release();
      };
      next.on('notification', message => {
        if (message.channel !== CHANNEL) return;
        const hint = readPayload(message.payload);
        if (hint) deliver(hint.documentId, hint);
      });
      next.on('error', (error: Error) => {
        if (connection?.client === next) connection = null;
        release(error);
        noteFailure();
        fail();
      });
      try {
        await next.query(`LISTEN ${CHANNEL}`);
      } catch (error) {
        // The error listener above may already have released and counted it.
        if (!released) {
          release(error instanceof Error ? error : new Error(String(error)));
          noteFailure();
        }
        throw error;
      }
      if (released) throw new Error('SOURCE_STREAM_LISTEN_RETRY_PENDING');
      connection = { client: next, release }; unavailable = false; consecutiveFailures = 0;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  return {
    async subscribe(documentId: string, listener: Listener) {
      if (!UUID_PATTERN.test(documentId)) throw new Error('SOURCE_STREAM_INPUT_INVALID');
      await ensure();
      const set = listeners.get(documentId) ?? new Set<Listener>();
      set.add(listener); listeners.set(documentId, set);
      return () => {
        const current = listeners.get(documentId); if (!current) return;
        current.delete(listener); if (!current.size) listeners.delete(documentId);
      };
    },
    async stop() {
      const current = connection; connection = null; listeners.clear(); unavailable = false;
      consecutiveFailures = 0; retryAt = 0;
      if (!current) return;
      try { await current.client.query(`UNLISTEN ${CHANNEL}`); } catch { /* release below */ }
      current.release();
    },
  };
}

export const sourceDocumentHub = createSourceDocumentHub();
