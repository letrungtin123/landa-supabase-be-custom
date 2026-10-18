// Transports: keep-alive node:http for real runs, in-process stub for --dry-run and tests.
import http from 'node:http';

/** HTTP/1.1 keep-alive transport to a loopback origin. Every result has a status (0 = network error/timeout). */
export function createHttpTransport({ origin, maxSockets, timeoutMs }) {
  const url = new URL(origin);
  const agent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: Math.min(maxSockets, 256), scheduling: 'lifo' });
  return {
    kind: 'http',
    origin: url.origin,
    request({ method, path, headers, body, timeout = timeoutMs }) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (result) => { if (!settled) { settled = true; resolve(result); } };
        const req = http.request({ host: url.hostname, port: url.port || 80, method, path, headers, agent }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => done({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', (err) => done({ status: 0, headers: {}, body: Buffer.alloc(0), errorCode: err.code || 'ERESPONSE' }));
        });
        req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', (err) => done({ status: 0, headers: {}, body: Buffer.alloc(0), errorCode: err.code || 'EREQUEST' }));
        if (body !== undefined) req.write(body);
        req.end();
      });
    },
    close() { agent.destroy(); },
  };
}

/** Calls the stub's pure handler directly (no sockets). `onRequest` sees every request (dry-run trace). */
export function createInProcessTransport(stub, { onRequest } = {}) {
  return {
    kind: 'in-process',
    origin: 'http://in-process.stub',
    async request({ method, path, headers, body }) {
      if (onRequest) onRequest({ method, path, headers, body });
      const json = body === undefined || body.length === 0 ? undefined : JSON.parse(body.toString('utf8'));
      const result = await stub.handle({ method, path, headers, json });
      const payload = result.raw !== undefined ? result.raw : Buffer.from(JSON.stringify(result.json ?? {}));
      return { status: result.status, headers: result.headers || {}, body: payload };
    },
    close() {},
  };
}
