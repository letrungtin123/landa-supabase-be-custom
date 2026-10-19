import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { useJsonBodyParsers } from './body-limits.js';
import { errorHandler } from './error-handler.js';

// A request body the JSON parser refuses (malformed, unsupported encoding or
// charset, cut off) is a 4xx with a stable code and a fixed message, not a
// 500. Node's parse message can quote part of the body (a password on the
// sign-in route), so neither the answer nor the log ever contains the body.

const FAKE_SECRET = 'FAKE-SECRET-7f3a9c1e-do-not-log';
/** What Node's parse message would quote of it (about 10 characters). */
const SECRET_FRAGMENT = /FAKE-SEC/;

async function serve(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  // The body parsers of app.ts, in its order.
  useJsonBodyParsers(app);
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res) => {
    res.json({ received: true });
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    // Keep-alive sockets closed first: a socket still closing when the test
    // process force-exits trips a libuv assertion on Windows.
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every console line written while the test runs. */
function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(arg => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' '));
    });
  }
  return lines;
}

function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string | Buffer,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postJson(port: number, path: string, body: string): Promise<{ status: number; text: string }> {
  return rawPost(
    port,
    path,
    { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  );
}

test('a malformed JSON body is a 400 INVALID_JSON with a fixed message, and the body is never logged', async t => {
  const lines = captureConsole(t);
  const server = await serve();
  try {
    // Node's parse message quotes the body around the error: for an unquoted
    // value it reads `Unexpected token 'F', ..."password":FAKE-SECRE"...`.
    const unquoted = `{"username":"staff@example.com","password":${FAKE_SECRET}}`;
    const unterminated = `{"username":"staff@example.com","password":"${FAKE_SECRET}`;
    const sent: Array<[string, string]> = [
      ['/api/auth/login', unquoted],
      ['/api/auth/login', unterminated],
      ['/api/courses', unquoted],
      ['/api/learner/complete-blocks', unquoted],
    ];
    for (const [path, body] of sent) {
      const { status, text } = await postJson(server.port, `${path}?token=${FAKE_SECRET}`, body);
      assert.equal(status, 400, path);
      assert.deepEqual(JSON.parse(text), {
        success: false,
        message: 'Dữ liệu gửi lên không đúng định dạng. Vui lòng kiểm tra lại và thử lại.',
        code: 'INVALID_JSON',
      });
      assert.doesNotMatch(text, /FAKE-SEC|password|not valid JSON|Unexpected|Unterminated/);
    }
  } finally {
    await server.close();
  }
  const logged = lines.join('\n');
  assert.doesNotMatch(logged, SECRET_FRAGMENT, 'the body (and the query string) never reach the log');
  assert.doesNotMatch(logged, /Unexpected|Unterminated|not valid JSON|\bat .*:\d+:\d+/, 'no parse message, no stack');
  const refusals = lines.filter(line => line.includes('request_body_refused'));
  assert.equal(refusals.length, 4);
  assert.deepEqual(JSON.parse(refusals[0].replace(/^\[RequestBody\] /, '')), {
    event: 'request_body_refused',
    type: 'entity.parse.failed',
    status: 400,
    method: 'POST',
    path: '/api/auth/login',
  });
});

test('an unsupported charset or content encoding is a 415 UNSUPPORTED_ENCODING', async t => {
  const lines = captureConsole(t);
  const server = await serve();
  try {
    const body = JSON.stringify({ password: FAKE_SECRET });
    const charset = await rawPost(
      server.port,
      '/api/auth/login',
      { 'Content-Type': 'application/json; charset=latin1', 'Content-Length': String(Buffer.byteLength(body)) },
      body,
    );
    const encoding = await rawPost(
      server.port,
      '/api/courses',
      {
        'Content-Type': 'application/json',
        'Content-Encoding': 'x-unknown',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    );
    for (const response of [charset, encoding]) {
      assert.equal(response.status, 415);
      assert.deepEqual(JSON.parse(response.text), {
        success: false,
        message: 'Dữ liệu gửi lên có định dạng chưa được hỗ trợ. Vui lòng thử lại.',
        code: 'UNSUPPORTED_ENCODING',
      });
    }
  } finally {
    await server.close();
  }
  assert.doesNotMatch(lines.join('\n'), /FAKE-SEC|latin1|x-unknown/i);
  const types = lines
    .filter(line => line.includes('request_body_refused'))
    .map(line => (JSON.parse(line.replace(/^\[RequestBody\] /, '')) as { type: string }).type);
  assert.deepEqual(types, ['charset.unsupported', 'encoding.unsupported']);
});

test('a body over its limit stays a 413 PAYLOAD_TOO_LARGE and is logged by type only', async t => {
  const lines = captureConsole(t);
  const server = await serve();
  try {
    const response = await postJson(
      server.port,
      '/api/auth/login',
      JSON.stringify({ password: FAKE_SECRET, padding: 'x'.repeat(150_000) }),
    );
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.text), {
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Dữ liệu gửi lên quá lớn. Vui lòng gửi ít nội dung hơn.',
    });
  } finally {
    await server.close();
  }
  assert.doesNotMatch(lines.join('\n'), /FAKE-SEC|too large/i);
  assert.equal(lines.filter(line => line.includes('"type":"entity.too.large"')).length, 1);
});

test('a form body with too many fields or nested too deep is a 413 or 400, logged by type only (W2-05)', async t => {
  const lines = captureConsole(t);
  const server = await serve();
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const tooMany = Array.from({ length: 1001 }, (_, i) => `f${i}=${FAKE_SECRET}`).join('&');
  const tooDeep = `a${'[b]'.repeat(40)}=${FAKE_SECRET}`;
  try {
    const many = await rawPost(
      server.port,
      '/api/courses',
      { ...form, 'Content-Length': String(tooMany.length) },
      tooMany,
    );
    assert.equal(many.status, 413);
    assert.deepEqual(JSON.parse(many.text), {
      success: false,
      message: 'Dữ liệu gửi lên có quá nhiều mục. Vui lòng gửi ít nội dung hơn.',
      code: 'TOO_MANY_PARAMETERS',
    });
    const deep = await rawPost(
      server.port,
      '/api/courses',
      { ...form, 'Content-Length': String(tooDeep.length) },
      tooDeep,
    );
    assert.equal(deep.status, 400);
    assert.deepEqual(JSON.parse(deep.text), {
      success: false,
      message: 'Dữ liệu gửi lên không đúng định dạng. Vui lòng kiểm tra lại và thử lại.',
      code: 'INVALID_FORM_BODY',
    });
    assert.doesNotMatch(many.text + deep.text, /FAKE-SEC|parameters|depth/);
  } finally {
    await server.close();
  }
  const logged = lines.join('\n');
  assert.doesNotMatch(logged, /FAKE-SEC|too many parameters|exceeded the depth|\bat .*:\d+:\d+/);
  const types = lines
    .filter(line => line.includes('request_body_refused'))
    .map(line => (JSON.parse(line.replace(/^\[RequestBody\] /, '')) as { type: string }).type);
  assert.deepEqual(types, ['parameters.too.many', 'querystring.parse.rangeError']);
});
