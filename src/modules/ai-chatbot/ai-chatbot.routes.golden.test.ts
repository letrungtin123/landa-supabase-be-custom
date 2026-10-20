import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRouteTable, type RouteTable } from '../../test-support/express-route-table.js';

// Golden route table of /api/ai-chatbot (ai-chatbot.routes.ts as app.ts mounts
// it): every layer in registration order with its method, full path, the names
// of its middleware and handler, and the canonical code that registered it,
// plus the application middleware around the mount and a fingerprint of the
// whole router file. Nothing is started: the test imports app.ts and reads the
// router object and the source files.
//
// It fails when a route, a guard (or its arguments), a handler or their order
// changes, and when any code of ai-chatbot.routes.ts changes other than an
// import path (a move-only change keeps it green). After a reviewed change of
// the routes, rewrite the golden and review its diff:
//   AI_CHATBOT_ROUTES_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/ai-chatbot.routes.golden.test.ts
// (with the test environment of npm test: NODE_ENV=test and the service URLs
// on a closed port).

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(here, 'ai-chatbot.routes.golden.json');
const WRITE = process.env.AI_CHATBOT_ROUTES_GOLDEN_WRITE === '1';

async function currentTable(): Promise<RouteTable> {
  const { default: app } = await import('../../app.js');
  const { default: router } = await import('./ai-chatbot.routes.js');
  return buildRouteTable({
    app,
    router,
    appFile: path.resolve(here, '../../app.ts'),
    routerFile: path.join(here, 'ai-chatbot.routes.ts'),
    repoRoot: path.resolve(here, '../../..'),
  });
}

test('the /api/ai-chatbot route table is the recorded one', async t => {
  // Module-level setup of the routers logs feature-flag notes; keep the output quiet.
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'info', () => undefined);
  const table = await currentTable();
  if (WRITE) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(table, null, 1)}\n`);
    return;
  }
  assert.ok(existsSync(GOLDEN_PATH), `no golden: run with AI_CHATBOT_ROUTES_GOLDEN_WRITE=1 (${GOLDEN_PATH})`);
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as RouteTable;
  assert.equal(table.mount, golden.mount, 'the router is mounted elsewhere');
  assert.deepEqual(table.app_before, golden.app_before, 'the application middleware before the router changed');
  assert.deepEqual(table.app_after, golden.app_after, 'the application layers after the router changed');
  assert.deepEqual(
    table.layers.map(layer => `${layer.methods?.join(',') ?? 'USE'} ${layer.path}`),
    golden.layers.map(layer => `${layer.methods?.join(',') ?? 'USE'} ${layer.path}`),
    'a route was added, removed or reordered',
  );
  assert.deepEqual(table.layers, golden.layers, 'a guard, handler or registering call changed');
  assert.equal(
    table.router_code_sha256,
    golden.router_code_sha256,
    'ai-chatbot.routes.ts changed beyond its import paths: review, then rewrite the golden',
  );
});

test('the route table has the guards every AI ID runtime route needs', async t => {
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'info', () => undefined);
  const table = await currentTable();
  // Router-wide: authentication and tenant context run before every route.
  assert.deepEqual(
    table.layers.filter(layer => layer.kind === 'use').map(layer => layer.stack.join()),
    ['authenticate', 'tenantContext'],
  );
  assert.deepEqual(
    table.layers.slice(0, 2).map(layer => layer.kind),
    ['use', 'use'],
  );
  // Every route answers through at least one function and none is registered twice.
  const keys = table.layers
    .filter(layer => layer.kind === 'route' && layer.source)
    .map(layer => `${layer.methods?.join()} ${layer.path}`);
  assert.equal(new Set(keys).size, keys.length, 'a method and path is registered twice');
  for (const layer of table.layers) assert.ok(layer.stack.length > 0, `${layer.path} has no handler`);
});
