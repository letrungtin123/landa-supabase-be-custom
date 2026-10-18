#!/usr/bin/env node
// Compare two load-test results (e.g. before / after a release):
//   node scripts/loadtest/compare.mjs results/before.json results/after.json [--threshold 10] [--fail-on-regression]
// A latency regression is p95 or p99 slower by more than --threshold percent (and by more than 5 ms); an error
// regression is an error rate higher by more than 0.5 percentage points and at least 3 more failed requests. Endpoints
// seen fewer than 50 times in either run are listed
// but never flagged.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const pct = (before, after) => (before > 0 && after !== null && after !== undefined ? ((after - before) / before) * 100 : null);
const fmtPct = (v) => (v === null ? '' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmt = (v) => (v === null || v === undefined ? '-' : String(v));

export function compareResults(before, after, { threshold = 10 } = {}) {
  const names = [...new Set([...Object.keys(before.endpoints || {}), ...Object.keys(after.endpoints || {})])].sort();
  const rows = [];
  const regressions = [];
  for (const name of names) {
    const b = before.endpoints?.[name];
    const a = after.endpoints?.[name];
    const row = {
      name,
      count: [b?.count ?? 0, a?.count ?? 0],
      p50: [b?.p50 ?? null, a?.p50 ?? null],
      p95: [b?.p95 ?? null, a?.p95 ?? null],
      p99: [b?.p99 ?? null, a?.p99 ?? null],
      err: [b ? b.error_rate * 100 : null, a ? a.error_rate * 100 : null],
    };
    row.p95Delta = pct(row.p95[0], row.p95[1]);
    row.p99Delta = pct(row.p99[0], row.p99[1]);
    const enough = (b?.count ?? 0) >= 50 && (a?.count ?? 0) >= 50;
    const failed = (e) => (e ? Math.round(e.error_rate * e.count) : 0);
    const slower = (i) => row[i][0] !== null && row[i][1] !== null && row[i][1] - row[i][0] > 5 && pct(row[i][0], row[i][1]) > threshold;
    if (enough && (slower('p95') || slower('p99'))) regressions.push(`${name}: p95 ${fmt(row.p95[0])} -> ${fmt(row.p95[1])} ms, p99 ${fmt(row.p99[0])} -> ${fmt(row.p99[1])} ms`);
    if (enough && row.err[1] - row.err[0] > 0.5 && failed(a) - failed(b) >= 3) regressions.push(`${name}: errors ${row.err[0].toFixed(2)}% -> ${row.err[1].toFixed(2)}%`);
    rows.push(row);
  }
  const totals = ['requests', 'rps', 'p50', 'p95', 'p99', 'error_rate'].map((k) => ({ k, b: before.totals?.[k], a: after.totals?.[k] }));
  const pgKeys = ['connections_max', 'active_max', 'active_avg', 'lock_waits_max', 'lock_waits_avg', 'advisory_waits_max', 'row_lock_waits_max', 'samples_with_lock_waits', 'longest_lock_wait_s'];
  const pg = pgKeys.map((k) => ({ k, b: before.pg?.summary?.[k] ?? null, a: after.pg?.summary?.[k] ?? null }));
  return { rows, regressions, totals, pg };
}

export function renderComparison(before, after, cmp) {
  const lines = [];
  const head = (r, label) => `${label}: ${r.label || '(no label)'} | ${r.started_at} | ${r.options?.learners} learners + ${r.options?.admins} admins | target ${r.target}`;
  lines.push(head(before, 'before'), head(after, 'after '));
  if (before.options?.learners !== after.options?.learners || before.options?.seed !== after.options?.seed || before.options?.thinkScale !== after.options?.thinkScale) {
    lines.push('WARNING: the runs differ in learners / seed / think scale; compare like with like.');
  }
  const header = ['endpoint', 'count b/a', 'p50 b/a', 'p95 b/a', 'p95 Δ', 'p99 b/a', 'p99 Δ', 'err% b/a'];
  const body = cmp.rows.map((r) => [r.name, `${r.count[0]}/${r.count[1]}`, `${fmt(r.p50[0])}/${fmt(r.p50[1])}`, `${fmt(r.p95[0])}/${fmt(r.p95[1])}`, fmtPct(r.p95Delta),
    `${fmt(r.p99[0])}/${fmt(r.p99[1])}`, fmtPct(r.p99Delta), `${r.err[0] === null ? '-' : r.err[0].toFixed(2)}/${r.err[1] === null ? '-' : r.err[1].toFixed(2)}`]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  lines.push('', line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line), '');
  lines.push(`totals: ${cmp.totals.map((t) => `${t.k} ${fmt(t.b)} -> ${fmt(t.a)}`).join(', ')}`);
  lines.push(`postgres: ${cmp.pg.map((t) => `${t.k} ${fmt(t.b)} -> ${fmt(t.a)}`).join(', ')}`);
  lines.push(cmp.regressions.length ? `REGRESSIONS (${cmp.regressions.length}):\n  ${cmp.regressions.join('\n  ')}` : 'no regression above the threshold');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
  if (files.length !== 2) {
    console.error('Usage: node scripts/loadtest/compare.mjs <before.json> <after.json> [--threshold 10] [--fail-on-regression]');
    process.exit(2);
  }
  const ti = args.indexOf('--threshold');
  const threshold = ti >= 0 ? Number(args[ti + 1]) : 10;
  const [before, after] = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const cmp = compareResults(before, after, { threshold });
  console.log(renderComparison(before, after, cmp));
  if (args.includes('--fail-on-regression') && cmp.regressions.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
