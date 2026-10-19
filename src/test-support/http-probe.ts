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
