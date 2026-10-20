// The route table of an Express 5 router, for golden tests: every layer in
// registration order with its method, full path, the names of its functions
// (middleware first, handler last) and the code that registered it.
//
// Built from the router object itself (no server, no request) plus a static
// read of the router's source file, which pins what names alone do not show:
// the arguments of a guard such as checkPermission('courses', 'can_edit') or
// the options of a handler factory.
//
// The code is compared in a canonical form: comments, whitespace, quote style,
// trailing commas and the parentheses of a single arrow parameter do not
// count; everything else does. Import paths count by file name only, so moving
// files (a move-only change) keeps the table equal.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** One layer of the router, as the golden records it. */
export interface RouteTableLayer {
  kind: 'use' | 'route';
  /** HTTP methods of a route layer (upper case), absent on a use layer. */
  methods?: string[];
  /** Mount path + the path the layer was registered with. */
  path: string;
  /** Function names in calling order; '<anonymous>' for an unnamed function. */
  stack: string[];
  /** Canonical code of the router.<method>(...) call that registered the layer. */
  source?: string;
  /** Canonical code of the statement that registered it through a helper (a function given the router). */
  registered_by?: string;
}

export interface RouteTable {
  /** Repository path of the router file. */
  router: string;
  /** Where the application mounts the router. */
  mount: string;
  /** Names of the application layers that run before the router for every route of it. */
  app_before: string[];
  /** Names of the application layers after the router that every route of it can reach (404, errors). */
  app_after: string[];
  layers: RouteTableLayer[];
  /** sha256 of the canonical code of the whole router file, import paths reduced to file names. */
  router_code_sha256: string;
}

interface RuntimeRouteLayer {
  name: string;
  method?: string;
  handle: unknown;
}

interface RuntimeRoute {
  path: string;
  methods: Record<string, boolean | undefined>;
  stack: RuntimeRouteLayer[];
}

interface RuntimeLayer {
  name: string;
  handle: unknown;
  route?: RuntimeRoute;
  /** The router's own test of a request path; it also stores the match on the layer (path, params, keys). */
  match(path: string): boolean;
  path?: unknown;
  params?: unknown;
  keys?: unknown;
}

interface Registration {
  /** 'use', 'get', 'post', …; null for a helper call that receives the router. */
  verb: string | null;
  path: string;
  handlerCount: number;
  code: string;
}

const ROUTE_VERBS = new Set(['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function stackOf(value: unknown): RuntimeLayer[] {
  const stack = (value as { stack?: unknown }).stack;
  if (!Array.isArray(stack)) throw new Error('ROUTE_TABLE_NOT_A_ROUTER');
  return stack as RuntimeLayer[];
}

function functionName(handle: unknown): string {
  return typeof handle === 'function' && handle.name ? handle.name : '<anonymous>';
}

function isJsDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/** Parentheses around the one plain parameter of an arrow function (`(x) => …` reads as `x => …`). */
function isOptionalArrowParen(token: ts.Node): boolean {
  const parent = token.parent;
  if (!parent || !ts.isArrowFunction(parent)) return false;
  if (token.kind !== ts.SyntaxKind.OpenParenToken && token.kind !== ts.SyntaxKind.CloseParenToken) return false;
  if (parent.parameters.length !== 1 || parent.typeParameters || parent.type) return false;
  const [parameter] = parent.parameters;
  return ts.isIdentifier(parameter.name) && !parameter.type && !parameter.initializer && !parameter.dotDotDotToken;
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

/** The canonical code of `node`: its tokens without comments or layout. */
export function canonicalCode(
  node: ts.Node,
  source: ts.SourceFile,
  rewrite?: (token: ts.Node) => string | null,
): string {
  const tokens: ts.Node[] = [];
  const visit = (current: ts.Node) => {
    if (isJsDoc(current)) return;
    const children = current.getChildren(source);
    if (children.length === 0) {
      if (current.getWidth(source) > 0) tokens.push(current);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(node);
  let out = '';
  tokens.forEach((token, index) => {
    if (isOptionalArrowParen(token)) return;
    const text = token.getText(source);
    const next = tokens[index + 1]?.getText(source);
    if (text === ',' && (next === ')' || next === ']' || next === '}')) return;
    const value = rewrite?.(token) ?? (ts.isStringLiteral(token) ? quote(token.text) : text);
    if (/[\w$]$/.test(out) && /^[\w$]/.test(value)) out += ' ';
    out += value;
  });
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Module specifiers count by file name only: a moved import stays the same. */
function importPathAsFileName(token: ts.Node): string | null {
  const parent = token.parent;
  if (!ts.isStringLiteral(token) || !parent) return null;
  const isSpecifier =
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === token) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
      parent.arguments[0] === token);
  return isSpecifier && token.text.startsWith('.') ? quote(path.posix.basename(token.text)) : null;
}

/** String constants declared at the top level (`const workspaceReadPath = '/x'`). */
function topLevelStrings(source: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        const value = staticString(declaration.initializer, constants);
        if (value !== null) constants.set(declaration.name.text, value);
      }
    }
  }
  return constants;
}

function staticString(node: ts.Expression, constants: Map<string, string>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = staticString(span.expression, constants);
      if (value === null) return null;
      out += value + span.literal.text;
    }
    return out;
  }
  return null;
}

/** The top-level statements that register layers on `routerName`, in source order. */
function registrations(source: ts.SourceFile, routerName: string): Registration[] {
  const constants = topLevelStrings(source);
  const found: Registration[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    const code = canonicalCode(call, source);
    const callee = call.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === routerName
    ) {
      const verb = callee.name.text;
      if (verb !== 'use' && !ROUTE_VERBS.has(verb)) throw new Error(`ROUTE_TABLE_UNKNOWN_CALL: ${code}`);
      const [first] = call.arguments;
      const routePath = first ? staticString(first, constants) : null;
      if (routePath === null && verb !== 'use') throw new Error(`ROUTE_TABLE_PATH_NOT_STATIC: ${code}`);
      const handlerCount = call.arguments.length - (routePath === null ? 0 : 1);
      found.push({ verb, path: routePath ?? '/', handlerCount, code });
    } else if (call.arguments.some(argument => ts.isIdentifier(argument) && argument.text === routerName)) {
      found.push({ verb: null, path: '', handlerCount: 0, code });
    }
  }
  return found;
}

function joinPath(mount: string, routePath: string): string {
  if (routePath === '/') return mount || '/';
  return `${mount.replace(/\/$/, '')}${routePath}`;
}

/** A concrete request path for a route pattern (`:id` → `x`). */
function samplePath(pattern: string): string {
  if (/[*{}()?+]/.test(pattern)) throw new Error(`ROUTE_TABLE_PATTERN_NOT_SUPPORTED: ${pattern}`);
  return pattern.replace(/:\w+/g, 'x');
}

/** Whether `layer` matches `requestPath`, leaving the layer as it was. */
function layerMatches(layer: RuntimeLayer, requestPath: string): boolean {
  const { path: matchedPath, params, keys } = layer;
  try {
    return layer.match(requestPath);
  } finally {
    Object.assign(layer, { path: matchedPath, params, keys });
  }
}

function matches(layer: RuntimeLayer, requestPath: string, method: string): boolean {
  if (!layerMatches(layer, requestPath)) return false;
  if (!layer.route) return true;
  return Boolean(layer.route.methods[method] ?? layer.route.methods._all);
}

/** Where `app.use('<path>', <identifier>)` in `appFile` mounts the default import of `routerFile`. */
function staticMountPath(appFile: string, routerFile: string): string {
  const source = parse(appFile);
  const routerName = path.basename(routerFile).replace(/\.ts$/, '.js');
  let importName: string | null = null;
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      path.posix.basename(statement.moduleSpecifier.text) === routerName
    ) {
      importName = statement.importClause?.name?.text ?? null;
    }
  }
  if (!importName) throw new Error(`ROUTE_TABLE_ROUTER_NOT_IMPORTED: ${routerName}`);
  const mounts: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'use' &&
      node.arguments.length === 2 &&
      ts.isIdentifier(node.arguments[1]) &&
      node.arguments[1].text === importName
    ) {
      const mount = staticString(node.arguments[0], new Map());
      if (mount === null) throw new Error('ROUTE_TABLE_MOUNT_NOT_STATIC');
      mounts.push(mount);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (mounts.length !== 1) throw new Error(`ROUTE_TABLE_MOUNT_COUNT: ${mounts.length}`);
  return mounts[0];
}

export interface RouteTableInput {
  /** The Express application (its router is read, nothing is started). */
  app: unknown;
  /** The router mounted in it. */
  router: unknown;
  /** Absolute paths of the application and router source files. */
  appFile: string;
  routerFile: string;
  /** Repository root, for the recorded router path. */
  repoRoot: string;
  /** Name of the router variable in the router file. */
  routerName?: string;
}

/** The route table of `router` as mounted in `app`. Throws when the source and the router object disagree. */
export function buildRouteTable(input: RouteTableInput): RouteTable {
  const source = parse(input.routerFile);
  const mount = staticMountPath(input.appFile, input.routerFile);
  const appStack = stackOf((input.app as { router: unknown }).router);
  const mountIndex = appStack.findIndex(layer => layer.handle === input.router);
  if (mountIndex < 0) throw new Error('ROUTE_TABLE_ROUTER_NOT_MOUNTED');
  if (!layerMatches(appStack[mountIndex], mount)) {
    throw new Error(`ROUTE_TABLE_MOUNT_MISMATCH: ${mount}`);
  }

  const statements = registrations(source, input.routerName ?? 'router');
  const layers: RouteTableLayer[] = [];
  let next = 0;
  let helper: Registration | null = null;
  for (const layer of stackOf(input.router)) {
    const kind = layer.route ? 'route' : 'use';
    const methods = layer.route
      ? Object.keys(layer.route.methods)
          .filter(method => layer.route?.methods[method])
          .map(method => method.toUpperCase())
          .sort()
      : undefined;
    const stack = layer.route
      ? layer.route.stack.map(entry => functionName(entry.handle))
      : [functionName(layer.handle)];
    // Skip helper statements that registered nothing more; a helper absorbs the
    // layers that the next router.<method>(...) statement does not explain.
    while (next < statements.length && statements[next].verb === null) helper = statements[next++];
    const candidate = statements[next];
    const explains =
      candidate &&
      (layer.route
        ? candidate.verb !== 'use' &&
          candidate.path === layer.route.path &&
          candidate.handlerCount === stack.length &&
          (candidate.verb === 'all' || methods?.join() === candidate.verb?.toUpperCase())
        : candidate.verb === 'use' && candidate.handlerCount >= 1 && layerMatches(layer, candidate.path));
    if (explains) {
      const routePath = layer.route ? layer.route.path : candidate.path;
      layers.push({
        kind,
        ...(methods ? { methods } : {}),
        path: joinPath(mount, routePath),
        stack,
        source: candidate.code,
      });
      // router.use(a, b) registers one layer per function.
      if (!layer.route && candidate.handlerCount > 1) candidate.handlerCount -= 1;
      else next += 1;
      helper = null;
      continue;
    }
    if (!helper || !layer.route) {
      throw new Error(`ROUTE_TABLE_UNEXPLAINED_LAYER: ${kind} ${layer.route?.path ?? ''} ${stack.join(' > ')}`);
    }
    layers.push({ kind, methods, path: joinPath(mount, layer.route.path), stack, registered_by: helper.code });
  }
  while (next < statements.length && statements[next].verb === null) next += 1;
  if (next !== statements.length) throw new Error(`ROUTE_TABLE_UNMATCHED_STATEMENT: ${statements[next].code}`);

  // Application layers around the mount that apply to every route of the router.
  const appChain = (from: number, to: number) => {
    const chains = layers
      .filter(layer => layer.kind === 'route')
      .flatMap(layer =>
        (layer.methods ?? []).map(method =>
          appStack
            .slice(from, to)
            .filter(appLayer => matches(appLayer, samplePath(layer.path), method.toLowerCase()))
            .map(appLayer => functionName(appLayer.handle)),
        ),
      );
    const [first = []] = chains;
    if (chains.some(chain => chain.join() !== first.join())) throw new Error('ROUTE_TABLE_APP_CHAIN_DIFFERS_PER_ROUTE');
    return first;
  };

  return {
    router: path.relative(input.repoRoot, input.routerFile).split(path.sep).join('/'),
    mount,
    app_before: appChain(0, mountIndex),
    app_after: appChain(mountIndex + 1, appStack.length),
    layers,
    router_code_sha256: sha256(canonicalCode(source, source, importPathAsFileName)),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
