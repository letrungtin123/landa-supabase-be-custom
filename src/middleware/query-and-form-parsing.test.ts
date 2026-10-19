import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { useFormBodyParser } from './body-limits.js';

// How request parameters reach the controllers. Query strings use Express 5's
// default 'simple' parser (node:querystring): flat keys, repeated keys become
// arrays, no qs. Form bodies use qs through express.urlencoded({ extended })
// (body-limits.ts useFormBodyParser). Pins the shapes our controllers read
// across qs / body-parser updates.

test('app.ts keeps the default query parser (qs is not used for req.query)', () => {
  const appSource = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /query parser/, 'a query parser setting changes every req.query shape below');
  assert.equal(express().get('query parser'), 'simple');
});

interface Echo { query: unknown; body: unknown; queryPrototype: string }

async function serve(): Promise<{ get: (search: string) => Promise<Echo>; post: (form: string) => Promise<{ status: number; json: Record<string, unknown> }>; close: () => Promise<void> }> {
  const app = express();
  useFormBodyParser(app);
  app.use((req, res) => {
    res.json({ query: req.query, body: req.body ?? null, queryPrototype: Object.getPrototypeOf(req.query) === null ? 'null' : 'object' });
  });
  app.use((error: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ type: error.type ?? null, message: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x`;
  return {
    get: async (search) => (await fetch(`${url}?${search}`)).json() as Promise<Echo>,
    post: async (form) => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      return { status: response.status, json: await response.json() as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('query strings: list paging, search, CSV ids and repeated keys', async () => {
  const server = await serve();
  try {
    assert.deepEqual((await server.get('page=2&page_size=20&search=Nguy%E1%BB%85n+V%C4%83n&ui_locale=en')).query, {
      page: '2', page_size: '20', search: 'Nguyễn Văn', ui_locale: 'en',
    });
    // parent_ids is a comma list the controller splits itself.
    assert.deepEqual((await server.get('parent_ids=a,b,c')).query, { parent_ids: 'a,b,c' });
    // A repeated key is an array; controllers that expect one value refuse it.
    assert.deepEqual((await server.get('status=active&status=archived&cursor=x&cursor=y')).query, {
      status: ['active', 'archived'], cursor: ['x', 'y'],
    });
    const many = Array.from({ length: 30 }, (_, i) => `id=${i}`).join('&');
    assert.deepEqual((await server.get(many)).query, { id: Array.from({ length: 30 }, (_, i) => String(i)) });
    assert.deepEqual((await server.get('empty=&flag')).query, { empty: '', flag: '' });
  } finally {
    await server.close();
  }
});

test('query strings: bracket keys stay flat (no nested filters, no prototype keys)', async () => {
  const server = await serve();
  try {
    const nested = await server.get('filter[status]=active&filter[course][id]=c1&ids[]=a&ids[]=b&ids[0]=z');
    assert.deepEqual(nested.query, {
      'filter[status]': 'active', 'filter[course][id]': 'c1', 'ids[]': ['a', 'b'], 'ids[0]': 'z',
    });
    const prototypeKeys = await server.get('__proto__[admin]=1&constructor[prototype][admin]=1&toString=x');
    assert.deepEqual(prototypeKeys.query, { '__proto__[admin]': '1', 'constructor[prototype][admin]': '1', toString: 'x' });
    assert.equal(prototypeKeys.queryPrototype, 'null');
    assert.equal(({} as Record<string, unknown>).admin, undefined);
  } finally {
    await server.close();
  }
});

test('form bodies: arrays, indexed arrays and nested filters (qs extended)', async () => {
  const server = await serve();
  try {
    const typical = await server.post('title=B%C3%A0i+1&tags[]=a&tags[]=b&ids[0]=x&ids[1]=y&filter[status]=active&filter[course][id]=c1&a=1&a=2&csv=a,b');
    assert.equal(typical.status, 200);
    assert.deepEqual(typical.json.body, {
      title: 'Bài 1',
      tags: ['a', 'b'],
      ids: ['x', 'y'],
      filter: { status: 'active', course: { id: 'c1' } },
      a: ['1', '2'],
      csv: 'a,b',
    });
    const brackets = Array.from({ length: 150 }, (_, i) => `ids[]=${i}`).join('&');
    assert.deepEqual((await server.post(brackets)).json.body, { ids: Array.from({ length: 150 }, (_, i) => String(i)) });
  } finally {
    await server.close();
  }
});

test('form bodies: indexes above the array limit become object keys, prototype keys are dropped', async () => {
  const server = await serve();
  try {
    // The limit is max(100, number of parameters) elements: index 99 is the last array slot.
    assert.deepEqual((await server.post('ids[0]=a&ids[99]=b')).json.body, { ids: ['a', 'b'] });
    assert.deepEqual((await server.post('ids[0]=a&ids[100]=b')).json.body, { ids: { 0: 'a', 100: 'b' } });
    assert.deepEqual((await server.post('ids[5000]=x')).json.body, { ids: { 5000: 'x' } });
    const prototypeKeys = await server.post('__proto__[admin]=1&constructor[prototype][admin]=1&name=x');
    assert.equal(prototypeKeys.status, 200);
    assert.deepEqual(prototypeKeys.json.body, { constructor: { prototype: { admin: '1' } }, name: 'x' });
    assert.equal(({} as Record<string, unknown>).admin, undefined);
  } finally {
    await server.close();
  }
});

test('form bodies: too many parameters and too deep nesting are refused by the parser', async () => {
  const server = await serve();
  try {
    const tooMany = Array.from({ length: 1001 }, (_, i) => `k${i}=v`).join('&');
    assert.deepEqual(await server.post(tooMany), { status: 413, json: { type: 'parameters.too.many', message: 'too many parameters' } });
    assert.equal((await server.post(Array.from({ length: 1000 }, (_, i) => `k${i}=v`).join('&'))).status, 200);

    const deep = (levels: number) => `a${'[b]'.repeat(levels)}=x`;
    assert.equal((await server.post(deep(32))).status, 200);
    assert.deepEqual(await server.post(deep(33)), {
      status: 400, json: { type: 'querystring.parse.rangeError', message: 'The input exceeded the depth' },
    });
  } finally {
    await server.close();
  }
});
