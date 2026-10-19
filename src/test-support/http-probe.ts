// Test only: plain HTTP probes for tests that start a server in a child process.
import http from 'node:http';
import net from 'node:net';

const REQUEST_TIMEOUT_MS = 5_000;

/** A TCP port of 127.0.0.1 that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** GET on a new connection (no keep-alive agent): every call is a new connection the server accepts. */
export function getOnNewConnection(port: number, pathName = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathName, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      response.on('error', reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () =>
      request.destroy(new Error(`GET ${pathName}: no answer in ${REQUEST_TIMEOUT_MS} ms`)),
    );
    request.on('error', reject);
  });
}

/** How many of `values` are each distinct value, keys sorted. */
export function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export interface LoadResult {
  /** Requests sent. */
  sent: number;
  /** Bodies of the 200 answers, in the order they came. */
  bodies: string[];
  /** One line per failed request (error, or a status other than 200). */
  failures: string[];
}

/**
 * GET `pathName` on a new connection, `perSecond` requests a second by the
 * wall clock, without waiting for earlier answers, until stop(); stop()
 * resolves once every request sent has ended. Each tick sends the requests
 * due since the start: a timer fires late (every 15.6 ms at best with the
 * default Windows timer, so a 50 ms interval runs every 62.5 ms, 16/s instead
 * of 20/s), and counting ticks would lower the rate.
 */
export function startLoad(port: number, perSecond: number, pathName = '/'): { stop: () => Promise<LoadResult> } {
  const result: LoadResult = { sent: 0, bodies: [], failures: [] };
  const pending = new Set<Promise<void>>();
  const send = () => {
    result.sent += 1;
    const request = getOnNewConnection(port, pathName).then(
      ({ status, body }) => {
        if (status === 200) result.bodies.push(body);
        else result.failures.push(`status ${status}: ${body.slice(0, 200)}`);
      },
      (error: unknown) => {
        result.failures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      },
    );
    pending.add(request);
    void request.finally(() => pending.delete(request));
  };
  const startedAt = Date.now();
  const timer = setInterval(
    () => {
      const due = Math.floor(((Date.now() - startedAt) * perSecond) / 1000);
      while (result.sent < due) send();
    },
    Math.round(1000 / perSecond),
  );
  return {
    stop: async () => {
      clearInterval(timer);
      await Promise.all([...pending]);
      return result;
    },
  };
}
