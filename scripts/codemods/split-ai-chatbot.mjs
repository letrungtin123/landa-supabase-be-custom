// Moves files of a module folder into sub-folders, as a map file says, and
// rewrites every path that names them (path-moves.mjs). Move only: no code
// changes besides paths.
//
//   node scripts/codemods/split-ai-chatbot.mjs                         apply split-ai-chatbot.map.json
//   node scripts/codemods/split-ai-chatbot.mjs --map <file.json>       apply another map
//   node scripts/codemods/split-ai-chatbot.mjs --map <file> --dry-run  print the plan, change nothing
//   add --list to print every move and edited file, --root <folder> to change another repository
//
// Two map formats (see README.md):
// - rules (split-ai-chatbot.map.json): every file and folder directly under
//   "module" goes to the folder of the first rule whose pattern matches its name;
// - moves (ai-id-moves.json): "moves" lists, per target folder (nested folders
//   allowed, such as orchestration/worker), the names directly under "module"
//   that go there.
// Destination folders and the "keep" names stay. A name that no rule or list
// places stops the run (exit 1) before anything changes, unless
// --allow-unmapped leaves it in place; so does a listed name that exists
// nowhere, and a plan that would edit an ecosystem*.cjs file.
//
// It reads the current tree, so it also works after other branches changed or
// added files: merge them first, then run it. A second run finds nothing to
// move and changes nothing. Try a map on a copy first: split-ai-chatbot.selftest.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlan, planRewrites } from './path-moves.mjs';

const posix = path.posix;

function fail(message) {
  console.error(`[split-ai-chatbot] ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const args = new Set(argv);
function option(name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail(`${name} needs a value`);
  return argv[index + 1];
}
// --root: the repository to change (default: this one); the codemod's own tests use a scratch repository.
const repoRoot = path.resolve(option('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const mapFile = option('--map')
  ? path.resolve(option('--map'))
  : fileURLToPath(new URL('./split-ai-chatbot.map.json', import.meta.url));
const dryRun = args.has('--dry-run');
const allowUnmapped = args.has('--allow-unmapped');
const mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const moduleRoot = mapping.module;
if (typeof moduleRoot !== 'string' || !moduleRoot) fail(`${mapFile}: "module" is missing`);

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const trackedFiles = git('ls-files', '-z')
  .split('\0')
  .filter(Boolean)
  .filter(file => fs.existsSync(path.join(repoRoot, file)))
  .sort();
const tracked = new Set(trackedFiles);

// ── 1. Plan the moves ─────────────────────────────────────────────────────
const destinations = new Set(Object.keys(mapping.folders ?? {}));
if (destinations.size === 0) fail(`${mapFile}: "folders" is empty`);
const destinationRoots = new Set([...destinations].map(folder => folder.split('/')[0]));
const keep = new Set(Object.keys(mapping.keep ?? {}).map(name => name.replace(/\/$/, '')));
const prefix = `${moduleRoot}/`;
const entries = new Map(); // name directly under the module → tracked files under it
for (const file of trackedFiles) {
  if (!file.startsWith(prefix)) continue;
  const name = file.slice(prefix.length).split('/')[0];
  if (!entries.has(name)) entries.set(name, []);
  entries.get(name).push(file);
}

/** The folder a name goes to, from the map's rules or move lists. */
function placeFor() {
  if (Array.isArray(mapping.rules)) {
    const rules = mapping.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern) }));
    for (const rule of rules) {
      if (!destinations.has(rule.folder)) fail(`rule ${rule.pattern} names an unknown folder ${rule.folder}`);
    }
    return name => rules.find(candidate => candidate.regex.test(name))?.folder ?? null;
  }
  if (!mapping.moves || typeof mapping.moves !== 'object') fail(`${mapFile}: neither "rules" nor "moves"`);
  const placed = new Map();
  for (const [folder, names] of Object.entries(mapping.moves)) {
    if (!destinations.has(folder)) fail(`"moves" names an unknown folder ${folder}`);
    for (const name of names) {
      if (placed.has(name)) fail(`${name} is listed in ${placed.get(name)} and ${folder}`);
      if (keep.has(name)) fail(`${name} is listed in ${folder} and kept`);
      placed.set(name, folder);
    }
  }
  // A listed name that is neither in place to move nor already at its target.
  const atTarget = (name, folder) => {
    const target = `${prefix}${folder}/${name}`;
    return tracked.has(target) || trackedFiles.some(file => file.startsWith(`${target}/`));
  };
  const missing = [...placed].filter(([name, folder]) => !entries.has(name) && !atTarget(name, folder));
  if (missing.length > 0) {
    fail(`listed but not found: ${missing.map(([name, folder]) => `${folder}/${name}`).join(', ')}`);
  }
  return name => placed.get(name) ?? null;
}
const place = placeFor();

const fileMoves = new Map(); // old path → new path
const directoryMoves = new Map(); // old folder → new folder
const unmapped = [];
for (const [name, files] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
  if (destinationRoots.has(name) || keep.has(name)) continue;
  const folder = place(name);
  if (!folder) {
    unmapped.push(name);
    continue;
  }
  const isDirectory = !(files.length === 1 && files[0] === `${prefix}${name}`);
  if (isDirectory) directoryMoves.set(`${prefix}${name}`, `${prefix}${folder}/${name}`);
  for (const file of files) {
    const target = `${prefix}${folder}/${file.slice(prefix.length)}`;
    if (tracked.has(target)) fail(`${file} would overwrite ${target}`);
    fileMoves.set(file, target);
  }
}
if (unmapped.length > 0 && !allowUnmapped) {
  fail(
    `nothing in ${path.basename(mapFile)} places: ${unmapped.join(', ')}. Add them to the map, or run with --allow-unmapped to leave them in place.`,
  );
}
for (const name of unmapped) console.warn(`[split-ai-chatbot] left in place (not in the map): ${prefix}${name}`);

// ── 2. Plan the path rewrites ─────────────────────────────────────────────
const plan = planRewrites({ repoRoot, trackedFiles, fileMoves, directoryMoves, moduleRoot });
if (plan.refused.length > 0) fail(plan.refused.join('\n'));

// ── Report and apply ──────────────────────────────────────────────────────
const perFolder = new Map();
for (const target of fileMoves.values()) {
  const folder = posix.dirname(target.slice(prefix.length));
  const top = [...destinations]
    .filter(name => folder === name || folder.startsWith(`${name}/`))
    .sort()
    .pop();
  perFolder.set(top ?? folder, (perFolder.get(top ?? folder) ?? 0) + 1);
}
const totals = {};
for (const counts of plan.edits.values()) {
  for (const [kind, count] of Object.entries(counts)) totals[kind] = (totals[kind] ?? 0) + count;
}
console.log(
  `[split-ai-chatbot] ${path.basename(mapFile)}: ${fileMoves.size} files to move, ${plan.rewrites.size} files with path rewrites`,
);
console.log(
  `  path edits: ${totals.import ?? 0} import/export specifiers, ${totals.url ?? 0} new URL(…, import.meta.url), ${totals.literal ?? 0} other relative strings, ${totals.spelled ?? 0} rooted or short paths in text`,
);
for (const [folder, count] of [...perFolder].sort()) console.log(`  ${moduleRoot}/${folder}/: ${count} files`);
for (const warning of plan.warnings) console.warn(`[split-ai-chatbot] note: ${warning}`);
if (args.has('--list')) {
  for (const [from, to] of fileMoves) console.log(`  mv ${from} -> ${to}`);
  for (const [file, counts] of plan.edits) console.log(`  edit ${file} ${JSON.stringify(counts)}`);
}
if (dryRun) process.exit(0);

applyPlan({ repoRoot, git, rewrites: plan.rewrites, fileMoves, directoryMoves });
console.log('[split-ai-chatbot] done. Next: npx tsc --noEmit, npm run lint, npm test.');
