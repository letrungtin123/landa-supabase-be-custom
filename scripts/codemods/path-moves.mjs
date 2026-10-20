// Path rewriting for move-only codemods (split-ai-chatbot.mjs): given the files
// that move, the edits that keep every path of the repository pointing at the
// same file. No code changes besides paths.
//
// What is rewritten, in the files git tracks:
// - Relative paths in TypeScript and JavaScript files (src/, scripts/, tests,
//   tmp/): import and export specifiers, dynamic import(), import() types,
//   require() and any other string that resolves to a file or folder, such as
//   new URL('./x.ts', import.meta.url). Paths inside a moved file are re-based
//   to its new folder.
// - Paths written from a root, in any text file (package.json scripts,
//   eslint-suppressions.json keys, docs, comments, test lists, goldens):
//   src/modules/<module>/x.ts, dist/modules/<module>/x.js, modules/<module>/x.ts,
//   and the short form <module name>/x.ts (as in ai-id/lesson-author-x.ts).
// - eslint-suppressions.json keys are sorted again.
// ecosystem*.cjs files are never edited: a plan that would edit one is refused.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const posix = path.posix;

export const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.json', '.md', '.yml', '.yaml', '.txt']);
const NEVER_EDIT = /^ecosystem.*\.cjs$/;
const SKIP_FILES = new Set(['package-lock.json']);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function applyEdits(text, edits) {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
  return out;
}

/** Edits counted by kind: 'import' (module specifiers), 'url' (new URL(…, import.meta.url)), 'literal', 'spelled'. */
function countKinds(edits) {
  const counts = {};
  for (const edit of edits) counts[edit.kind] = (counts[edit.kind] ?? 0) + 1;
  return counts;
}

/**
 * The rewrites of a move plan.
 *
 * @param {object} input
 * @param {string} input.repoRoot absolute repository root
 * @param {string[]} input.trackedFiles repository paths (posix) of the files git tracks
 * @param {Map<string, string>} input.fileMoves old path → new path, for every moved file
 * @param {Map<string, string>} input.directoryMoves old folder → new folder, for moved folders
 * @param {string} input.moduleRoot the folder whose content moves, such as src/modules/ai-chatbot/ai-id
 * @returns {{ rewrites: Map<string, string>, edits: Map<string, Record<string, number>>, warnings: string[], refused: string[] }}
 */
export function planRewrites({ repoRoot, trackedFiles, fileMoves, directoryMoves, moduleRoot }) {
  const tracked = new Set(trackedFiles);
  const trackedDirectories = new Set();
  for (const file of trackedFiles) {
    for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) trackedDirectories.add(dir);
  }
  const newPathOf = file => fileMoves.get(file) ?? file;
  const warnings = [];

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

  // Rooted: 'src/modules/x/a.ts', 'dist/modules/x/a.js' and 'modules/x/a.ts'
  // all contain 'modules/x/'. Short: 'x/a.ts', the module's own name first.
  // Test data also writes rooted paths with escaped separators: Windows stack
  // text in a string ('dist\\modules\\x\\a.js') and regular expressions
  // (/modules\/x\/a\.ts/); those keep their separator and dot style.
  const moduleTail = moduleRoot.replace(/^src\//, '');
  const escapedStyle = (sep, dot) => {
    const sepPattern = escapeRegExp(sep);
    const name = `(?:[\\w@-]|${escapeRegExp(dot)})+`;
    return {
      regex: new RegExp(
        `(?<![\\w-])${moduleTail.split('/').map(escapeRegExp).join(sepPattern)}${sepPattern}(${name}(?:${sepPattern}${name})*)`,
        'g',
      ),
      prefix: moduleTail.split('/').join(sep),
      sep,
      decode: written => written.split(sep).join('/').split(dot).join('.'),
      encode: relative => relative.split('.').join(dot).split('/').join(sep),
    };
  };
  const plain = { sep: '/', decode: written => written.replace(/[.]+$/, ''), encode: relative => relative };
  const spellings = [
    { ...plain, regex: new RegExp(`(?<![\\w-])${escapeRegExp(moduleTail)}/([\\w@.\\-/]+)`, 'g'), prefix: moduleTail },
    {
      ...plain,
      regex: new RegExp(`(?<![\\w./-])${escapeRegExp(posix.basename(moduleRoot))}/([\\w@.\\-/]+)`, 'g'),
      prefix: posix.basename(moduleRoot),
    },
    escapedStyle('\\\\', '.'),
    escapedStyle('\\/', '\\.'),
  ];

  /** Edits for the rooted and short paths of `text`, outside the `skip` ranges. */
  function spelledPathEdits(text, skip = []) {
    const edits = [];
    const taken = [...skip];
    for (const { regex, prefix, sep, decode, encode } of spellings) {
      for (const match of text.matchAll(regex)) {
        const start = match.index;
        const end = start + match[0].length;
        if (taken.some(([from, to]) => start < to && end > from)) continue;
        taken.push([start, end]);
        const written = decode(match[1]);
        const moved = movedSpelling(`${moduleRoot}/${written}`);
        if (!moved || moved === `${moduleRoot}/${written}`) continue;
        edits.push({
          start,
          end: start + prefix.length + sep.length + encode(written).length,
          value: `${prefix}${sep}${encode(moved.slice(moduleRoot.length + 1))}`,
          kind: 'spelled',
        });
      }
    }
    return edits;
  }

  const rewriteSpelledPaths = text => {
    const edits = spelledPathEdits(text);
    return { text: applyEdits(text, edits), counts: countKinds(edits) };
  };

  function scriptKind(file) {
    const extension = posix.extname(file);
    if (extension === '.tsx') return ts.ScriptKind.TSX;
    if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
  }

  /** 'import': the literal is a module specifier; 'url': new URL(literal, import.meta.url); null: another string. */
  function fileRelativeKind(node) {
    const parent = node.parent;
    if (!parent) return null;
    if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
      return 'import';
    if (ts.isExternalModuleReference(parent)) return 'import';
    if (ts.isLiteralTypeNode(parent) && parent.parent && ts.isImportTypeNode(parent.parent)) return 'import';
    if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
      if (parent.expression.kind === ts.SyntaxKind.ImportKeyword) return 'import';
      if (ts.isIdentifier(parent.expression) && parent.expression.text === 'require') return 'import';
    }
    if (ts.isNewExpression(parent) && parent.arguments?.[0] === node && parent.expression.getText() === 'URL') {
      return parent.arguments[1]?.getText() === 'import.meta.url' ? 'url' : null;
    }
    return null;
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
          const kind = fileRelativeKind(node);
          const rebased = rebaseRelative(node.text, file, kind !== null);
          if (rebased !== null) {
            claimed.push([start, end]);
            if (rebased !== node.text && text.slice(start, end) === node.text)
              edits.push({ start, end, value: rebased, kind: kind ?? 'literal' });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Rooted and short paths everywhere else (other strings, comments), outside the literals handled above.
    const all = [...edits, ...spelledPathEdits(text, claimed)];
    return { text: applyEdits(text, all), counts: countKinds(all) };
  }

  function rewriteSuppressions(text) {
    const { text: rewritten, counts } = rewriteSpelledPaths(text);
    if (rewritten === text) return { text, counts };
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const parsed = JSON.parse(rewritten);
    const sorted = Object.fromEntries(
      Object.keys(parsed)
        .sort()
        .map(key => [key, parsed[key]]),
    );
    if (Object.keys(sorted).length !== Object.keys(JSON.parse(text)).length)
      throw new Error('eslint-suppressions.json: two keys became one');
    const trailing = /\r?\n$/.test(text) ? eol : '';
    return { text: JSON.stringify(sorted, null, 2).replace(/\n/g, eol) + trailing, counts };
  }

  const rewrites = new Map();
  const edits = new Map();
  const refused = [];
  for (const file of trackedFiles) {
    const base = posix.basename(file);
    const extension = posix.extname(file);
    if (!TEXT_EXTENSIONS.has(extension) || SKIP_FILES.has(base) || file.startsWith('dist/')) continue;
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    let result;
    if (base === 'eslint-suppressions.json') result = rewriteSuppressions(text);
    else if (CODE_EXTENSIONS.has(extension) && !base.endsWith('.d.ts')) result = rewriteCode(file, text);
    else result = rewriteSpelledPaths(text);
    if (result.text === text) continue;
    if (NEVER_EDIT.test(base)) {
      refused.push(`${file} names a moved path; ecosystem files are not edited by this codemod`);
      continue;
    }
    rewrites.set(file, result.text);
    edits.set(file, result.counts);
  }
  return { rewrites, edits, warnings, refused };
}

/** Writes the rewrites, then `git mv`s every file and removes the folders the moves emptied. */
export function applyPlan({ repoRoot, git, rewrites, fileMoves, directoryMoves }) {
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
}
