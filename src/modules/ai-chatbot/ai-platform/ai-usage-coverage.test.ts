import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Every direct Gemini generation call must read the provider's own usage
// (aiUsageFromGeminiMetadata / createStreamUsageTracker) near the call, so the
// AI ledger never settles a paid call on a text-length guess. A call that cannot
// (legacy paths) carries the marker "AI usage: legacy estimate" just above it.
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CALL = /\.generateContent(Stream)?\(/;
const READS_USAGE = /aiUsageFromGeminiMetadata\(|createStreamUsageTracker\(/;
const LEGACY = 'AI usage: legacy estimate';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

test('every direct Gemini call settles on provider usage', () => {
  const unmetered: string[] = [];
  let calls = 0;
  for (const file of files(src)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!CALL.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
      calls += 1;
      const before = lines.slice(Math.max(0, index - 6), index).join('\n');
      const after = lines.slice(index, index + 60).join('\n');
      if (!READS_USAGE.test(after) && !before.includes(LEGACY)) unmetered.push(`${path.relative(src, file)}:${index + 1}`);
    });
  }
  assert.ok(calls >= 10, `expected the known Gemini call sites, found ${calls}`);
  assert.deepEqual(unmetered, []);
});
