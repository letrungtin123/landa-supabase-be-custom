import type { Response } from 'express';

export const CHAT_HEARTBEAT_MS = 15_000;

/** Request-scoped transport only: never cancels generation or retries a turn. */
export function createChatStreamLifecycle(
  response: Pick<Response, 'write' | 'end' | 'writableEnded' | 'destroyed' | 'writableNeedDrain'>,
  identity: { correlation_id: string; conversation_id: string },
  log: (record: Record<string, unknown>) => void,
  clock: () => number = Date.now,
  schedule: (callback: () => void) => () => void = callback => {
    const timer = setInterval(callback, CHAT_HEARTBEAT_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
) {
  const startedAt = clock();
  let lastWriteAt: number | null = null;
  let disconnected = false;
  let disposed = false;
  let heartbeatCount = 0;
  let stopTimer = () => {};
  const diagnostic = (event: string) => log({
    ...identity, event, timestamp_utc: new Date(clock()).toISOString(),
    duration_ms: clock() - startedAt,
    last_write_age_ms: lastWriteAt === null ? null : clock() - lastWriteAt,
    heartbeat_count: heartbeatCount,
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopTimer();
  };
  const disconnect = () => {
    if (disconnected || disposed) return;
    disconnected = true;
    diagnostic('client_disconnected');
    dispose();
  };
  const write = (wire: string) => {
    if (disconnected || disposed || response.writableEnded || response.destroyed) return false;
    try {
      response.write(wire);
      lastWriteAt = clock();
      return true;
    } catch {
      disconnect();
      return false;
    }
  };
  stopTimer = schedule(() => {
    if (response.destroyed || response.writableEnded) { disconnect(); return; }
    // Do not accumulate keepalives behind a slow consumer. Comments are not progress.
    if (!response.writableNeedDrain && write(': keepalive\n\n')) heartbeatCount += 1;
  });
  diagnostic('stream_open');
  return {
    writeEvent: (data: Record<string, unknown>) => write(`data: ${JSON.stringify(data)}\n\n`),
    disconnect,
    finish: () => {
      if (disposed) return;
      diagnostic('stream_end');
      dispose();
      if (!response.writableEnded && !response.destroyed) response.end();
    },
    dispose: () => { diagnostic('handler_complete'); dispose(); },
  };
}
