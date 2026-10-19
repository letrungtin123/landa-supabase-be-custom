#!/usr/bin/env node
// Schema manifest: the functions that the reviewed SQL files of
// supabase/manual_sql define, with the hash the backend compares at startup.
//
// Several startup checks (lesson-author workspace / orchestration V2 /
// chapter checkpoints / durable Blueprint, course publish governance) refuse
// to run when a guarded database function's body is not the reviewed one.
// They compare md5(btrim(replace(prosrc, chr(13), ''), E' \n\t')) with a
// hash written by hand in the code. This script computes the same hash from
// the SQL files, so the hand-written pins can be checked against the SQL
// (src/platform/schema-manifest/schema-pins.test.ts) instead of against a
// live database.
//
// The files are read in name order (the timestamp prefix is the order they
// are applied in); files whose name contains _ROLLBACK undo another file and
// are listed but never count as the latest definition. Only the
// CREATE [OR REPLACE] FUNCTION statements at the top level of a file are read
// (a function created through EXECUTE inside a DO block is not seen).
// Read-only: the script never runs SQL.
//
// Usage:
//   node scripts/schema-manifest.mjs [--sql-dir <dir>] [--function '<name(args)>' ...] [--out <file>]
//   --sql-dir   default: ../supabase/manual_sql next to landa-backend
//   --function  only these signatures (as the code pins them, e.g. 'guard_x()'), repeatable
//   --out       write the JSON there instead of printing it
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SQL_DIR = path.resolve(ROOT, '..', 'supabase', 'manual_sql');

/** The hash the startup checks compute in SQL: md5(btrim(replace(prosrc, chr(13), ''), E' \n\t')). */
export function functionBodyMd5(body) {
  return createHash('md5')
    .update(body.replace(/\r/g, '').replace(/^[ \n\t]+|[ \n\t]+$/g, ''))
    .digest('hex');
}

export function isRollbackFile(fileName) {
  return /_ROLLBACK/i.test(fileName);
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Splits SQL into top-level statements. Comments are dropped, the content of
 * every dollar-quoted string is replaced by a $BODY<n>$ placeholder (the raw
 * content is kept in `bodies`), quoted strings and identifiers are kept.
 */
export function splitStatements(sql) {
  const statements = [];
  let masked = '';
  let bodies = [];
  let i = 0;
  const flush = () => {
    if (masked.trim()) statements.push({ masked: masked.trim(), bodies });
    masked = '';
    bodies = [];
  };
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      masked += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      masked += ' ';
      continue;
    }
    if (char === "'") {
      const escaped = /[Ee]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      masked += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      masked += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === '$' && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64));
      if (tag) {
        const open = tag[0];
        const start = i + open.length;
        const end = sql.indexOf(open, start);
        const stop = end === -1 ? sql.length : end;
        masked += `$BODY${bodies.length}$`;
        bodies.push(sql.slice(start, stop));
        i = end === -1 ? sql.length : end + open.length;
        continue;
      }
    }
    if (char === ';') {
      flush();
      i += 1;
      continue;
    }
    masked += char;
    i += 1;
  }
  flush();
  return statements;
}

/** Splits on commas outside parentheses and quotes. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const TYPE_ALIASES = new Map([
  ['varchar', 'character varying'],
  ['char', 'character'],
  ['bpchar', 'character'],
  ['int', 'integer'],
  ['int4', 'integer'],
  ['int8', 'bigint'],
  ['int2', 'smallint'],
  ['bool', 'boolean'],
  ['float8', 'double precision'],
  ['float4', 'real'],
  ['decimal', 'numeric'],
  ['timestamptz', 'timestamp with time zone'],
  ['timestamp', 'timestamp without time zone'],
  ['timetz', 'time with time zone'],
  ['time', 'time without time zone'],
]);

// First words of the built-in type names that contain a space.
const MULTI_WORD_TYPE_START = new Set(['character', 'double', 'timestamp', 'time', 'bit', 'interval']);

/** An argument type as regprocedure prints it: no type modifier, aliases resolved, public. dropped. */
export function normalizeType(type) {
  let text = type.trim().toLowerCase().replace(/\s+/g, ' ');
  const array = /(\[\s*\d*\s*\])+$/.test(text) ? '[]' : '';
  text = text.replace(/(\[\s*\d*\s*\])+$/, '').trim();
  text = text.replace(/\s*\([^)]*\)/g, '');
  text = text.replace(/^public\./, '').replace(/"/g, '');
  if (/^(timestamp|time)( without time zone)?$/.test(text)) text = `${text.split(' ')[0]} without time zone`;
  text = TYPE_ALIASES.get(text) ?? text;
  return `${text}${array}`;
}

/** The argument types of a CREATE FUNCTION argument list, without OUT arguments, names and defaults. */
export function argumentTypes(argumentList) {
  const types = [];
  for (const raw of splitTopLevel(argumentList)) {
    let arg = raw
      .trim()
      .replace(/\s+DEFAULT\s+[\s\S]*$/i, '')
      .replace(/\s*=\s*[\s\S]*$/, '');
    const mode = /^(IN|OUT|INOUT|VARIADIC)\s+/i.exec(arg);
    if (mode) {
      if (/^OUT$/i.test(mode[1])) continue;
      arg = arg.slice(mode[0].length);
    }
    const words = arg.split(/\s+/);
    const first = words[0].toLowerCase().replace(/"/g, '');
    const hasName = words.length > 1 && !MULTI_WORD_TYPE_START.has(first);
    types.push(normalizeType(hasName ? words.slice(1).join(' ') : arg));
  }
  return types;
}

const CREATE_FUNCTION =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)\s*\(/i;

/** The functions one SQL file creates at its top level: { signature, md5, securityDefiner }. */
export function functionsInSql(sql) {
  const found = [];
  for (const statement of splitStatements(sql)) {
    const head = CREATE_FUNCTION.exec(statement.masked);
    if (!head) continue;
    const name = head[1]
      .replace(/\s+/g, '')
      .replace(/"/g, '')
      .replace(/^public\./i, '');
    let depth = 1;
    let j = head[0].length;
    while (j < statement.masked.length && depth > 0) {
      if (statement.masked[j] === '(') depth += 1;
      else if (statement.masked[j] === ')') depth -= 1;
      j += 1;
    }
    const argumentList = statement.masked.slice(head[0].length, j - 1);
    const rest = statement.masked.slice(j);
    const body = /\bAS\s+\$BODY(\d+)\$/i.exec(rest);
    found.push({
      signature: `${name}(${argumentTypes(argumentList).join(',')})`,
      md5: body ? functionBodyMd5(statement.bodies[Number(body[1])]) : null,
      securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(rest),
    });
  }
  return found;
}

/**
 * Every function defined in the .sql files of `sqlDir`:
 * { [signature]: { latest: { file, md5, security_definer } | null, definitions: [{ file, md5, rollback? }] } },
 * `latest` being the last definition outside a _ROLLBACK file.
 */
export function buildSchemaManifest(sqlDir = DEFAULT_SQL_DIR) {
  const files = readdirSync(sqlDir)
    .filter(name => name.endsWith('.sql'))
    .sort();
  const functions = {};
  for (const file of files) {
    const rollback = isRollbackFile(file);
    for (const fn of functionsInSql(readFileSync(path.join(sqlDir, file), 'utf8'))) {
      const entry = (functions[fn.signature] ??= { latest: null, definitions: [] });
      entry.definitions.push(rollback ? { file, md5: fn.md5, rollback: true } : { file, md5: fn.md5 });
      if (!rollback) entry.latest = { file, md5: fn.md5, security_definer: fn.securityDefiner };
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(functions)
      .sort()
      .map(signature => [signature, functions[signature]]),
  );
  return { format: 1, hash: "md5(btrim(replace(prosrc, chr(13), ''), E' \\n\\t'))", functions: sorted };
}

/** The manifest reduced to `signatures` (each present, `latest` null and no definitions when the SQL has none). */
export function pickFunctions(manifest, signatures) {
  const functions = {};
  for (const signature of [...new Set(signatures)].sort()) {
    functions[signature] = manifest.functions[signature] ?? { latest: null, definitions: [] };
  }
  return { ...manifest, functions };
}

function parseArguments(argv) {
  const options = { sqlDir: DEFAULT_SQL_DIR, functions: [], out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--sql-dir' && value) options.sqlDir = path.resolve(value);
    else if (argv[i] === '--function' && value) options.functions.push(value);
    else if (argv[i] === '--out' && value) options.out = path.resolve(value);
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    i += 1;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const full = buildSchemaManifest(options.sqlDir);
  const manifest = options.functions.length ? pickFunctions(full, options.functions) : full;
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, json);
  else process.stdout.write(json);
}
