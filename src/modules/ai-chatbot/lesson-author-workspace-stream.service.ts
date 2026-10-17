import { getClient } from '../../config/database.js';
import { listenRetryDelayMs } from './lesson-author-listen-retry.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL = 'lesson_author_workspace_event';
export interface WorkspaceCommitHint { workspaceId: string; sequence: number; }
type Listener = (hint: WorkspaceCommitHint | null) => void;

/**
 * One PostgreSQL LISTEN session per Node process, never per browser. The
 * workspace event ledger remains the durable source of replay; NOTIFY only
 * wakes active streams after an already-committed insert. A connection failure
 * notifies streams to reconnect/replay rather than pretending the provider
 * failed or running a timer per workspace.
 */
export function createWorkspaceCommitHub(dependencies: { getClient?: typeof getClient; now?: () => number } = {}) {
  const acquire = dependencies.getClient ?? getClient;
  const now = dependencies.now ?? (() => Date.now());
  const listeners = new Map<string, Set<Listener>>();
  // The pool connection that holds LISTEN; release() hands it back exactly once.
  let connection: { client: Awaited<ReturnType<typeof getClient>>; release: (error?: Error) => void } | null = null;
  let connecting: Promise<void> | null = null;
  let unavailable = false;
  let consecutiveFailures = 0;
  let retryAt = 0;

  function deliver(workspaceId: string, hint: WorkspaceCommitHint | null) {
    for (const listener of listeners.get(workspaceId)?.values() ?? []) {
      try { listener(hint); } catch { /* A socket observer cannot break the hub. */ }
    }
  }
  function fail() {
    if (unavailable) return;
    unavailable = true;
    for (const workspaceId of listeners.keys()) deliver(workspaceId, null);
  }
  function readPayload(payload: string | undefined): WorkspaceCommitHint | null {
    try {
      const value = JSON.parse(payload ?? '') as Record<string, unknown>;
      if (typeof value.workspace_id !== 'string' || !UUID.test(value.workspace_id)
        || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return null;
      return { workspaceId: value.workspace_id, sequence: value.sequence as number };
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
    if (now() < retryAt) throw new Error('WORKSPACE_STREAM_LISTEN_RETRY_PENDING');
    connecting = (async () => {
      let next: Awaited<ReturnType<typeof getClient>>;
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
        if (hint) deliver(hint.workspaceId, hint);
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
      if (released) throw new Error('WORKSPACE_STREAM_LISTEN_RETRY_PENDING');
      connection = { client: next, release }; unavailable = false; consecutiveFailures = 0;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  return {
    async subscribe(workspaceId: string, listener: Listener) {
      if (!UUID.test(workspaceId)) throw new Error('WORKSPACE_STREAM_INPUT_INVALID');
      await ensure();
      const set = listeners.get(workspaceId) ?? new Set<Listener>();
      set.add(listener); listeners.set(workspaceId, set);
      return () => {
        const current = listeners.get(workspaceId); if (!current) return;
        current.delete(listener); if (!current.size) listeners.delete(workspaceId);
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

export const workspaceCommitHub = createWorkspaceCommitHub();
