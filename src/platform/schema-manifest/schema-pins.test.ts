import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ORCHESTRATION_V2_GUARDS,
  ORCHESTRATION_V2_GUARDS_BEFORE_COURSE_PURGE_SQL,
} from '../../modules/ai-chatbot/ai-id/orchestration/lesson-author-orchestration-v2-schema.repository.js';
import {
  WORKSPACE_EXECUTION_GUARDS,
  WORKSPACE_FOUNDATION_GUARDS,
  WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES,
} from '../../modules/ai-chatbot/ai-id/workspace/read/lesson-author-workspace-schema.repository.js';
import {
  COURSE_PUBLISH_GOVERNANCE_FUNCTIONS,
  COURSE_PUBLISH_GOVERNANCE_FUNCTIONS_BEFORE_COURSE_PURGE_SQL,
} from '../../modules/course-authoring/course-publish-governance-schema.repository.js';
import { MANUAL_SQL_DIRECTORY } from '../../test-support/manual-sql.js';

// The md5 pins of guarded database functions that the startup checks compare
// (md5(btrim(replace(prosrc, chr(13), ''), E' \n\t'))) against the reviewed
// SQL files, through schema-manifest.json: the manifest that
// scripts/schema-manifest.mjs generates from supabase/manual_sql, reduced to
// the pinned functions. No runtime code reads the manifest; the pins in the
// code stay the contract.
//
// - Always (CI too): every pin matches one of its function's SQL definitions
//   (outside _ROLLBACK files), and the latest definition of every pinned
//   function is pinned somewhere, so a SQL hotfix of a guarded function
//   without the matching code pin fails here, not at startup after the SQL
//   was applied.
// - With the SQL files (../supabase/manual_sql next to landa-backend, or
//   SCHEMA_MANIFEST_SQL_DIR): schema-manifest.json is what the script
//   generates now. After a SQL change of a pinned function, or a new pin,
//   rewrite it:
//     SCHEMA_MANIFEST_WRITE=1 npx tsx --test src/platform/schema-manifest/schema-pins.test.ts

interface Definition {
  file: string;
  md5: string | null;
  rollback?: true;
}
interface FunctionEntry {
  latest: { file: string; md5: string | null; security_definer: boolean } | null;
  definitions: Definition[];
}
interface Manifest {
  format: number;
  hash: string;
  functions: Record<string, FunctionEntry>;
}
interface ManifestScript {
  buildSchemaManifest(sqlDir: string): Manifest;
  pickFunctions(manifest: Manifest, signatures: string[]): Manifest;
  functionsInSql(sql: string): Array<{ signature: string; md5: string | null; securityDefiner: boolean }>;
  functionBodyMd5(body: string): string;
}

async function manifestScript(): Promise<ManifestScript> {
  return (await import(new URL('../../../scripts/schema-manifest.mjs', import.meta.url).href)) as ManifestScript;
}

test('the script reads top-level CREATE FUNCTION statements as PostgreSQL stores them', async () => {
  const script = await manifestScript();
  const body = "\r\n  BEGIN\n    RAISE EXCEPTION 'no; really $x$';\n    RETURN NEW;\n  END;\n\t";
  const sql = [
    '-- CREATE FUNCTION commented_out() RETURNS void AS $$ $$;',
    '/* CREATE OR REPLACE FUNCTION also_commented() /* nested */ */',
    `SELECT E'it\\'s; fine', 'a''b;c';`,
    `CREATE OR REPLACE FUNCTION public.guard_x()\nRETURNS trigger LANGUAGE plpgsql\nSET search_path = pg_catalog, public\nAS $fn$${body}$fn$;`,
    'CREATE FUNCTION "public"."f_args"(p_tenant uuid, p_code varchar(64) DEFAULT \'a,b\', OUT p_total int,',
    '  p_at timestamptz = now(), p_ids uuid[] DEFAULT ARRAY[]::uuid[], double precision, p_flag bool)',
    'RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
    "DO $do$ BEGIN EXECUTE 'CREATE FUNCTION hidden() RETURNS void AS $h$ $h$ LANGUAGE sql'; END $do$;",
  ].join('\n');
  assert.deepEqual(script.functionsInSql(sql), [
    { signature: 'guard_x()', md5: script.functionBodyMd5(body), securityDefiner: false },
    {
      signature: 'f_args(uuid,character varying,timestamp with time zone,uuid[],double precision,boolean)',
      md5: script.functionBodyMd5(' SELECT 1 '),
      securityDefiner: true,
    },
  ]);
  // btrim(replace(prosrc, chr(13), ''), E' \n\t'): CR removed everywhere, only space/newline/tab trimmed.
  assert.equal(script.functionBodyMd5(' \r\n\tx\r\ny \n'), script.functionBodyMd5('x\ny'));
  assert.notEqual(script.functionBodyMd5('\fx'), script.functionBodyMd5('x'));
});

const MANIFEST_PATH = fileURLToPath(new URL('./schema-manifest.json', import.meta.url));
const SQL_DIR = process.env.SCHEMA_MANIFEST_SQL_DIR?.trim() || MANUAL_SQL_DIRECTORY;
const WRITE = process.env.SCHEMA_MANIFEST_WRITE === '1';
const sqlSkip: string | false = existsSync(SQL_DIR)
  ? false
  : `needs ${SQL_DIR} (the supabase repo next to landa-backend, or SCHEMA_MANIFEST_SQL_DIR)`;

interface Pin {
  /** Where the hash is written. */
  source: string;
  /** As the check looks it up: name(argument types), regprocedure style. */
  signature: string;
  md5: string;
}

function mapPins(source: string, pins: Record<string, string>): Pin[] {
  return Object.entries(pins).map(([signature, md5]) => ({ source, signature, md5 }));
}

function sourceText(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/** The chapter checkpoint guards are pinned inline (`const expected = {name: hash}`, zero-argument functions). */
function chapterCheckpointPins(): Pin[] {
  const text = sourceText('../../modules/ai-chatbot/ai-id/v1/lesson-author-chapter-runtime.service.ts');
  const block = /const expected:Record<string,string>=\{([^}]*)\}/.exec(text);
  assert.ok(block, 'the expected chapter guard hashes were not found in lesson-author-chapter-runtime.service.ts');
  return [...block[1].matchAll(/(\w+):'([0-9a-f]{32})'/g)].map(([, name, md5]) => ({
    source: 'lesson-author-chapter-runtime.service.ts',
    signature: `${name}()`,
    md5,
  }));
}

/** The durable Blueprint gate pins one guard inline (`row.guard_hash !== '<hash>'`). */
function durableBlueprintPins(): Pin[] {
  const text = sourceText('../../modules/ai-chatbot/ai-id/v1/lesson-author-durable-blueprint.service.ts');
  const hash = /row\.guard_hash !== '([0-9a-f]{32})'/.exec(text);
  const fn = /WHERE p\.oid=to_regprocedure\('public\.(\w+\([^)]*\))'\)/.exec(text);
  assert.ok(hash && fn, 'the durable Blueprint guard pin was not found in lesson-author-durable-blueprint.service.ts');
  return [{ source: 'lesson-author-durable-blueprint.service.ts', signature: fn[1], md5: hash[1] }];
}

const PINS: Pin[] = [
  ...mapPins('ORCHESTRATION_V2_GUARDS', ORCHESTRATION_V2_GUARDS),
  ...mapPins('WORKSPACE_FOUNDATION_GUARDS', WORKSPACE_FOUNDATION_GUARDS),
  ...mapPins('WORKSPACE_EXECUTION_GUARDS', WORKSPACE_EXECUTION_GUARDS),
  ...mapPins('WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES', WORKSPACE_V2_EXECUTION_GUARD_OVERRIDES),
  ...mapPins('COURSE_PUBLISH_GOVERNANCE_FUNCTIONS', COURSE_PUBLISH_GOVERNANCE_FUNCTIONS),
  // Predecessor bodies still accepted during the course purge SQL rollout (20261023_1500).
  ...mapPins('ORCHESTRATION_V2_GUARDS_BEFORE_COURSE_PURGE_SQL', ORCHESTRATION_V2_GUARDS_BEFORE_COURSE_PURGE_SQL),
  ...mapPins(
    'COURSE_PUBLISH_GOVERNANCE_FUNCTIONS_BEFORE_COURSE_PURGE_SQL',
    COURSE_PUBLISH_GOVERNANCE_FUNCTIONS_BEFORE_COURSE_PURGE_SQL,
  ),
  ...chapterCheckpointPins(),
  ...durableBlueprintPins(),
];
const PINNED_SIGNATURES = [...new Set(PINS.map(pin => pin.signature))].sort();

function committedManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

async function generatedManifest(): Promise<Manifest> {
  const script = await manifestScript();
  return script.pickFunctions(script.buildSchemaManifest(SQL_DIR), PINNED_SIGNATURES);
}

test('the pins are found in every place that writes them', () => {
  const sources = new Set(PINS.map(pin => pin.source));
  assert.equal(sources.size, 9);
  assert.equal(PINS.filter(pin => pin.source === 'lesson-author-chapter-runtime.service.ts').length, 4);
  for (const pin of PINS) assert.match(pin.md5, /^[0-9a-f]{32}$/, `${pin.source} ${pin.signature}`);
});

test('the committed manifest lists exactly the pinned functions', { skip: WRITE }, () => {
  assert.deepEqual(Object.keys(committedManifest().functions).sort(), PINNED_SIGNATURES);
});

test('every pin matches a definition of its function in the SQL files (not only a rollback)', { skip: WRITE }, () => {
  const manifest = committedManifest();
  const unmatched = PINS.filter(pin =>
    (manifest.functions[pin.signature]?.definitions ?? []).every(
      definition => definition.rollback || definition.md5 !== pin.md5,
    ),
  ).map(pin => `${pin.source} ${pin.signature} ${pin.md5}`);
  assert.deepEqual(unmatched, [], 'pins that match no reviewed SQL definition');
});

test('the latest SQL definition of every pinned function is pinned', { skip: WRITE }, () => {
  const manifest = committedManifest();
  const stale = PINNED_SIGNATURES.filter(signature => {
    const latest = manifest.functions[signature]?.latest;
    return !latest || !PINS.some(pin => pin.signature === signature && pin.md5 === latest.md5);
  }).map(signature => `${signature} (latest: ${manifest.functions[signature]?.latest?.file ?? 'none'})`);
  assert.deepEqual(stale, [], 'functions whose latest SQL body no check accepts');
});

test(
  'schema-manifest.json is what scripts/schema-manifest.mjs generates from the SQL files',
  { skip: sqlSkip },
  async () => {
    const generated = await generatedManifest();
    if (WRITE) {
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(generated, null, 2)}\n`);
      return;
    }
    assert.deepEqual(
      committedManifest(),
      generated,
      'stale: SCHEMA_MANIFEST_WRITE=1 npx tsx --test src/platform/schema-manifest/schema-pins.test.ts',
    );
  },
);
