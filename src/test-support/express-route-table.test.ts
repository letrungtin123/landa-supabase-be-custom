import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import ts from 'typescript';
import { buildRouteTable, canonicalCode } from './express-route-table.js';

function canonical(code: string): string {
  const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return canonicalCode(source, source);
}

test('canonical code ignores layout, comments, quotes, trailing commas and single arrow parentheses', () => {
  assert.equal(
    canonical(`router.get('/a', guard("x", 'y'), (req) => run(req),);`),
    canonical(`router.get( "/a",\n  // note\n  guard('x','y'), req=>run(req));`),
  );
  assert.notEqual(canonical(`guard('courses', 'can_edit')`), canonical(`guard('courses', 'can_view')`));
  assert.notEqual(canonical(`router.get('/a', a, b)`), canonical(`router.get('/a', b, a)`));
});

function authenticate(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
function countCall(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
function getThing(_req: Request, res: Response): void {
  res.end();
}
const guard = () =>
  function permissionMiddleware(_req: Request, _res: Response, next: NextFunction): void {
    next();
  };

const ROUTER_SOURCE = [
  "import { Router } from 'express';",
  "import { guard } from './guards/guard.js';",
  'const router = Router();',
  "const base = '/items';",
  'router.use(authenticate);',
  'mountCounters(router);',
  "router.get(`${base}/:id`, guard('things', 'can_view'), getThing);",
  "router.post(base, guard('things', 'can_add'), (req, res) => res.end());",
  'export default router;',
].join('\n');

function fixture(t: test.TestContext, routerSource = ROUTER_SOURCE) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'route-table-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routerFile = path.join(dir, 'things.routes.ts');
  const appFile = path.join(dir, 'app.ts');
  writeFileSync(routerFile, routerSource);
  writeFileSync(
    appFile,
    "import things from './things.routes.js';\nconst app = express();\napp.use('/api/things', things);\n",
  );
  // The objects the two files build at run time.
  const router = Router();
  router.use(authenticate);
  router.get('/items/:id', countCall); // what mountCounters(router) registers
  router.get('/items/:id', guard(), getThing);
  router.post('/items', guard(), (_req: Request, res: Response) => {
    res.end();
  });
  const app = express();
  app.use(express.json());
  app.use('/api/things', router);
  app.use(function notFound(_req: Request, res: Response) {
    res.status(404).end();
  });
  return { app, router, appFile, routerFile, repoRoot: dir };
}

test('the table lists every layer in order with its function names and registering code', t => {
  const table = buildRouteTable(fixture(t));
  assert.equal(table.router, 'things.routes.ts');
  assert.equal(table.mount, '/api/things');
  assert.deepEqual(table.app_before, ['jsonParser']);
  assert.deepEqual(table.app_after, ['notFound']);
  assert.deepEqual(
    table.layers.map(layer => [
      layer.methods?.join() ?? 'USE',
      layer.path,
      layer.stack.join(' > '),
      layer.source ?? `via ${layer.registered_by}`,
    ]),
    [
      ['USE', '/api/things', 'authenticate', 'router.use(authenticate)'],
      ['GET', '/api/things/items/:id', 'countCall', 'via mountCounters(router)'],
      [
        'GET',
        '/api/things/items/:id',
        'permissionMiddleware > getThing',
        "router.get(`${base}/:id`,guard('things','can_view'),getThing)",
      ],
      [
        'POST',
        '/api/things/items',
        'permissionMiddleware > <anonymous>',
        "router.post(base,guard('things','can_add'),(req,res)=>res.end())",
      ],
    ],
  );
});

test('the fingerprint changes with the code but not with import paths, and a source that does not match the router is refused', t => {
  const base = buildRouteTable(fixture(t)).router_code_sha256;
  const moved = buildRouteTable(fixture(t, ROUTER_SOURCE.replace('./guards/guard.js', '../../moved/guard.js')));
  assert.equal(moved.router_code_sha256, base, 'a relative import counts by file name only');
  const other = buildRouteTable(fixture(t, ROUTER_SOURCE.replace('./guards/guard.js', './guards/other-guard.js')));
  assert.notEqual(other.router_code_sha256, base, 'another imported file is another code');
  const guardChanged = buildRouteTable(fixture(t, ROUTER_SOURCE.replace("'can_view'", "'can_edit'")));
  assert.notEqual(guardChanged.router_code_sha256, base);
  assert.throws(
    () => buildRouteTable(fixture(t, ROUTER_SOURCE.replace('`${base}/:id`', "'/other/:id'"))),
    /ROUTE_TABLE_/,
  );
});
