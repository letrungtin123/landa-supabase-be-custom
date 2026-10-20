// Static module graph of src/, read with the TypeScript compiler (no code runs):
// the imports of a file, resolved the way tsc resolves them (tsconfig.json,
// NodeNext: './x.js' names x.ts), and the closure of the files an entry point
// reaches.
//
// An import is "type-only" when nothing of it exists at run time: `import type`,
// `export type … from`, `import { type A }` with only type specifiers, and
// `typeof import('./x')` types. Every other form is a value import:
// `import … from`, `import './x'`, `export … from`, `export * from`,
// `import x = require()`, `import('./x')`, `require('./x')`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface ModuleImport {
  /** The specifier as written. */
  specifier: string;
  typeOnly: boolean;
}

export interface ParsedModule {
  imports: ModuleImport[];
  /** import(…) or require(…) calls whose argument is not a string literal (cannot be followed statically). */
  nonLiteralLoads: number;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // import './x.js' runs the module
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return (
    !!bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every(e => e.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(e => e.isTypeOnly)
  );
}

/** The imports written in `text` (the source of `file`). */
export function parseModule(file: string, text: string = readFileSync(file, 'utf8')): ParsedModule {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: ModuleImport[] = [];
  let nonLiteralLoads = 0;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImport(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyExport(node) });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      imports.push({ specifier: node.argument.literal.text, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) imports.push({ specifier: argument.text, typeOnly: false });
      else nonLiteralLoads += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, nonLiteralLoads };
}

export interface ModuleResolver {
  /** The source file under `srcRoot` that `specifier` (written in `fromFile`) names; null for a package or a file outside. */
  resolve(specifier: string, fromFile: string): string | null;
  srcRoot: string;
}

/** Resolves like tsc with `tsconfigPath`; only files under `srcRoot` count (packages and Node built-ins do not). */
export function createModuleResolver(tsconfigPath: string, srcRoot: string): ModuleResolver {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath));
  const cache = ts.createModuleResolutionCache(path.dirname(tsconfigPath), name => name, options);
  const inside = path.resolve(srcRoot) + path.sep;
  return {
    srcRoot: path.resolve(srcRoot),
    resolve(specifier, fromFile) {
      const result = ts.resolveModuleName(specifier, fromFile, options, ts.sys, cache).resolvedModule;
      if (!result) {
        if (specifier.startsWith('.')) throw new Error(`IMPORT_NOT_RESOLVED: '${specifier}' in ${fromFile}`);
        return null;
      }
      const resolved = path.resolve(result.resolvedFileName);
      if (result.isExternalLibraryImport || !resolved.startsWith(inside)) return null;
      return resolved;
    },
  };
}

export interface ImportClosure {
  /** Absolute paths of every source file reached, the entries included. */
  files: Set<string>;
  /** Reached files with import()/require() calls that cannot be followed, and how many. */
  nonLiteralLoads: Map<string, number>;
}

/** Every file of src/ that `entries` reach through value imports (or every import with `includeTypeOnly`). */
export function importClosure(
  entries: string[],
  resolver: ModuleResolver,
  { includeTypeOnly = false }: { includeTypeOnly?: boolean } = {},
): ImportClosure {
  const files = new Set<string>();
  const nonLiteralLoads = new Map<string, number>();
  const pending = entries.map(entry => path.resolve(entry));
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const parsed = parseModule(file);
    if (parsed.nonLiteralLoads > 0) nonLiteralLoads.set(file, parsed.nonLiteralLoads);
    for (const item of parsed.imports) {
      if (item.typeOnly && !includeTypeOnly) continue;
      const target = resolver.resolve(item.specifier, file);
      if (target && !files.has(target)) pending.push(target);
    }
  }
  return { files, nonLiteralLoads };
}
