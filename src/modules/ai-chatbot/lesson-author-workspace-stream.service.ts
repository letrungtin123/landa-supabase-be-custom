import { getClient } from '../../config/database.js';

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
export function createWorkspaceCommitHub(dependencies: { getClient?: typeof getClient } = {}) {
  const acquire = dependencies.getClient ?? getClient;
  const listeners = new Map<string, Set<Listener>>();
  let client: Awaited<ReturnType<typeof getClient>> | null = null;
  let connecting: Promise<void> | null = null;
  let unavailable = false;

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
  async function ensure(): Promise<void> {
    if (client) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const next = await acquire();
      next.on('notification', message => {
        if (message.channel !== CHANNEL) return;
        const hint = readPayload(message.payload);
        if (hint) deliver(hint.workspaceId, hint);
      });
      next.on('error', () => { client = null; fail(); });
      try {
        await next.query(`LISTEN ${CHANNEL}`);
      } catch (error) {
        next.release(); throw error;
      }
      client = next; unavailable = false;
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
      const current = client; client = null; listeners.clear(); unavailable = false;
      if (!current) return;
      try { await current.query(`UNLISTEN ${CHANNEL}`); } catch { /* close/release below */ }
      current.release();
    },
  };
}

export const workspaceCommitHub = createWorkspaceCommitHub();
