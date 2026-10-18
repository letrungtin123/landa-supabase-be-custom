// Splits the flat src/modules/ai-chatbot folder into product sub-folders, as
// split-ai-chatbot.map.json says. Move only: no code changes besides paths.
//
//   node scripts/codemods/split-ai-chatbot.mjs            apply (git mv + rewrites)
//   node scripts/codemods/split-ai-chatbot.mjs --dry-run  print the plan, change nothing
//   add --list to print every move and edited file
//
// What it does, on the files git tracks:
// 1. Every file and folder directly under the module goes to the folder of the
//    first mapping rule that matches its name. Destination folders and the
//    "keep" files stay. A name that no rule matches stops the run (exit 1)
//    before anything changes, unless --allow-unmapped leaves it in place.
// 2. Relative paths in TypeScript and JavaScript files (src/, scripts/, tests,
//    tmp/): import and export specifiers, dynamic import(), import() types and
//    any other string that resolves to a file or folder, such as
//    new URL('./x.ts', import.meta.url). Paths inside a moved file are
//    re-based to its new folder.
// 3. Paths written from a root, such as src/modules/ai-chatbot/x.ts,
//    dist/modules/ai-chatbot/x.js or modules/ai-chatbot/x.ts, in any text
//    file: package.json scripts, eslint-suppressions.json keys (sorted again),
//    docs, comments, test lists.
// 4. git mv of every moved file.
//
// It reads the current tree, so it also works after other branches changed or
// added files: merge them first, then run it. A second run finds nothing to
// move and changes nothing. ecosystem*.cjs files are never edited: the run
// stops if one of them names a moved path.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const posix = path.posix;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowUnmapped = args.has('--allow-unmapped');
const mapping = JSON.parse(fs.readFileSync(new URL('./split-ai-chatbot.map.json', import.meta.url), 'utf8'));
const moduleRoot = mapping.module;

const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.md', '.yml', '.yaml', '.txt']);
const NEVER_EDIT = /^ecosystem.*\.cjs$/;
const SKIP_FILES = new Set(['package-lock.json']);

function fail(message) {
  console.error(`[split-ai-chatbot] ${message}`);
  process.exit(1);
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const trackedFiles = git('ls-files', '-z')
  .split('\0')
  .filter(Boolean)
  .filter(file => fs.existsSync(path.join(repoRoot, file)))
  .sort();
const tracked = new Set(trackedFiles);
const trackedDirectories = new Set();
for (const file of trackedFiles) {
  for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) trackedDirectories.add(dir);
}

// ── 1. Plan the moves ─────────────────────────────────────────────────────
const rules = mapping.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern) }));
const destinations = new Set(Object.keys(mapping.folders));
const keep = new Set(Object.keys(mapping.keep ?? {}));
const prefix = `${moduleRoot}/`;
const entries = new Map(); // top-level name → tracked files under it
for (const file of trackedFiles) {
  if (!file.startsWith(prefix)) continue;
  const name = file.slice(prefix.length).split('/')[0];
  if (!entries.has(name)) entries.set(name, []);
  entries.get(name).push(file);
}
const fileMoves = new Map(); // old path → new path
const directoryMoves = new Map(); // old folder → new folder
const unmapped = [];
for (const [name, files] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
  if (destinations.has(name) || keep.has(name)) continue;
  const rule = rules.find(candidate => candidate.regex.test(name));
  if (!rule) {
    unmapped.push(name);
    continue;
  }
  if (!destinations.has(rule.folder)) fail(`rule ${rule.pattern} names an unknown folder ${rule.folder}`);
  const isDirectory = !(files.length === 1 && files[0] === `${prefix}${name}`);
  if (isDirectory) directoryMoves.set(`${prefix}${name}`, `${prefix}${rule.folder}/${name}`);
  for (const file of files) {
    const target = `${prefix}${rule.folder}/${file.slice(prefix.length)}`;
    if (tracked.has(target)) fail(`${file} would overwrite ${target}`);
    fileMoves.set(file, target);
  }
}
if (unmapped.length > 0 && !allowUnmapped) {
  fail(
    `no rule of split-ai-chatbot.map.json matches: ${unmapped.join(', ')}. Add a rule, or run with --allow-unmapped to leave them in place.`,
  );
}
for (const name of unmapped) console.warn(`[split-ai-chatbot] left in place (no rule): ${prefix}${name}`);

const newPathOf = file => fileMoves.get(file) ?? file;

// The tracked file or folder a path names; a .js specifier may name a .ts file.
function resolveExisting(target) {
  const sources = { '.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] };
  const written = posix.extname(target);
  const candidates = [{ path: target, written: '', found: '' }];
  for (const found of sources[written] ?? []) {
    candidates.push({ path: target.slice(0, -written.length) + found, written, found });
  }
  for (const candidate of candidates) {
    if (tracked.has(candidate.path)) return { kind: 'file', ...candidate };
  }
  const folder = target.replace(/\/$/, '');
  if (trackedDirectories.has(folder)) return { kind: 'folder', path: folder };
  return null;
}

function newFolderPath(folder) {
  for (const [from, to] of directoryMoves) {
    if (folder === from || folder.startsWith(`${from}/`)) return to + folder.slice(from.length);
  }
  return folder;
}

/** `target` (as written, possibly .js for a .ts file) moved: the same spelling at its new place. */
function movedSpelling(target) {
  const found = resolveExisting(target);
  if (!found) return null;
  if (found.kind === 'folder') {
    const moved = newFolderPath(found.path);
    return target.endsWith('/') ? `${moved}/` : moved;
  }
  const moved = newPathOf(found.path);
  return moved.slice(0, moved.length - found.found.length) + found.written;
}

const isPathLike = value => /^\.\.?\//.test(value) && /^[\w@.\-/]+$/.test(value);
const warnings = [];

/**
 * A relative path written in `fromOld`, for the file's new place. null: not a
 * path of this tree. `fileRelative`: the literal is a module specifier or the
 * first argument of new URL(…, import.meta.url), so it is a path from the file
 * even when it names nothing git tracks.
 */
function rebaseRelative(value, fromOld, fileRelative) {
  const fromNew = newPathOf(fromOld);
  const target = posix.normalize(posix.join(posix.dirname(fromOld), value)).replace(/\/$/, '');
  const outsideRepo = target === '..' || target.startsWith('../');
  let movedTarget = outsideRepo ? null : movedSpelling(target);
  if (movedTarget === null) {
    if (fromNew === fromOld) return null;
    if (!fileRelative) {
      // Test data such as '../../etc', or a path from the repository root.
      warnings.push(`${fromOld}: '${value}' left as is (names no tracked file, not a module path)`);
      return null;
    }
    // A moved file names something git does not track (the sibling
    // landa-ai-rag checkout, a file made at run time): same place as before.
    movedTarget = target;
  }
  if (fromNew === fromOld && movedTarget === target) return value;
  let rebased = posix.relative(posix.dirname(fromNew), movedTarget) || '.';
  if (!rebased.startsWith('.')) rebased = `./${rebased}`;
  if (value.endsWith('/')) rebased += '/';
  return rebased;
}

// 'src/modules/ai-chatbot/x.ts', 'dist/modules/ai-chatbot/x.js', 'modules/ai-chatbot/x.ts', …
const moduleTail = moduleRoot.replace(/^src\//, '');
const ROOTED_PATH = new RegExp(`(?<![\\w-])${moduleTail.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/([\\w@.\\-/]+)`, 'g');

/** Edits for the rooted paths of `text`, outside the `skip` ranges. */
function rootedPathEdits(text, skip = []) {
  const edits = [];
  for (const match of text.matchAll(ROOTED_PATH)) {
    const start = match.index;
    const end = start + match[0].length;
    if (skip.some(([from, to]) => start < to && end > from)) continue;
    const written = match[1].replace(/[.]+$/, '');
    const moved = movedSpelling(`${moduleRoot}/${written}`);
    if (!moved || moved === `${moduleRoot}/${written}`) continue;
    edits.push({
      start,
      end: start + moduleTail.length + 1 + written.length,
      value: `${moduleTail}/${moved.slice(moduleRoot.length + 1)}`,
    });
  }
  return edits;
}

function applyEdits(text, edits) {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
  return out;
}

const rewriteRootedPaths = text => applyEdits(text, rootedPathEdits(text));

function scriptKind(file) {
  const extension = posix.extname(file);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The literal is a module specifier, or new URL(literal, import.meta.url). */
function isFileRelativeLiteral(node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
    return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && parent.parent && ts.isImportTypeNode(parent.parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    if (parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(parent.expression) && parent.expression.text === 'require') return true;
  }
  if (ts.isNewExpression(parent) && parent.arguments?.[0] === node && parent.expression.getText() === 'URL') {
    return parent.arguments[1]?.getText() === 'import.meta.url';
  }
  return false;
}

function rewriteCode(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const edits = [];
  const claimed = [];
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isPathLike(node.text)) {
        const start = node.getStart(source) + 1;
        const end = node.getEnd() - 1;
        const rebased = rebaseRelative(node.text, file, isFileRelativeLiteral(node));
        if (rebased !== null) {
          claimed.push([start, end]);
          if (rebased !== node.text && text.slice(start, end) === node.text) edits.push({ start, end, value: rebased });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Rooted paths everywhere else (other strings, comments), outside the literals handled above.
  return applyEdits(text, [...edits, ...rootedPathEdits(text, claimed)]);
}

function rewriteSuppressions(text) {
  const rewritten = rewriteRootedPaths(text);
  if (rewritten === text) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parsed = JSON.parse(rewritten);
  const sorted = Object.fromEntries(
    Object.keys(parsed)
      .sort()
      .map(key => [key, parsed[key]]),
  );
  if (Object.keys(sorted).length !== Object.keys(JSON.parse(text)).length)
    fail('eslint-suppressions.json: two keys became one');
  const trailing = /\r?\n$/.test(text) ? eol : '';
  return JSON.stringify(sorted, null, 2).replace(/\n/g, eol) + trailing;
}

// ── 2/3. Rewrite paths ────────────────────────────────────────────────────
const rewrites = new Map();
for (const file of trackedFiles) {
  const base = posix.basename(file);
  const extension = posix.extname(file);
  if (!TEXT_EXTENSIONS.has(extension) || SKIP_FILES.has(base) || file.startsWith('dist/')) continue;
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  let next;
  if (base === 'eslint-suppressions.json') next = rewriteSuppressions(text);
  else if (CODE_EXTENSIONS.has(extension) && !base.endsWith('.d.ts')) next = rewriteCode(file, text);
  else next = rewriteRootedPaths(text);
  if (next === text) continue;
  if (NEVER_EDIT.test(base)) fail(`${file} names a moved path; ecosystem files are not edited by this codemod`);
  rewrites.set(file, next);
}

// ── Report and apply ──────────────────────────────────────────────────────
const perFolder = new Map();
for (const target of fileMoves.values()) {
  const folder = target.slice(prefix.length).split('/')[0];
  perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
}
console.log(`[split-ai-chatbot] ${fileMoves.size} files to move, ${rewrites.size} files with path rewrites`);
for (const [folder, count] of [...perFolder].sort()) console.log(`  ${moduleRoot}/${folder}/: ${count} files`);
for (const warning of warnings) console.warn(`[split-ai-chatbot] note: ${warning}`);
if (args.has('--list')) {
  for (const [from, to] of fileMoves) console.log(`  mv ${from} -> ${to}`);
  for (const file of rewrites.keys()) console.log(`  edit ${file}`);
}
if (dryRun) process.exit(0);

for (const [file, text] of rewrites) fs.writeFileSync(path.join(repoRoot, file), text);
for (const [from, to] of fileMoves) {
  fs.mkdirSync(path.dirname(path.join(repoRoot, to)), { recursive: true });
  git('mv', from, to);
}
// git mv leaves the emptied folders on disk.
function removeEmptyFolders(folder) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return;
  for (const entry of fs.readdirSync(folder)) removeEmptyFolders(path.join(folder, entry));
  if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
}
for (const folder of directoryMoves.keys()) removeEmptyFolders(path.join(repoRoot, folder));
console.log('[split-ai-chatbot] done. Next: npx tsc --noEmit, npm run lint, npm test.');
