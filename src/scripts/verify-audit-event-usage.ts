import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegisteredAuditEventCodes } from '../modules/audit-logs/audit-event.contract.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = path.join(backendRoot, 'src');
const excludedRelativePaths = new Set([
  'modules/audit-logs/audit-event.contract.ts',
  'modules/audit-logs/audit-event.contract.test.ts',
  'scripts/verify-audit-event-usage.ts',
]);

async function walkTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkTypeScriptFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolutePath] : [];
  }));
  return nested.flat();
}

function findStaticAuditCodeLiterals(source: string): string[] {
  const codes: string[] = [];
  const pattern = /\bcode\s*:\s*(['"])([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\1/g;
  for (const match of source.matchAll(pattern)) codes.push(match[2]);
  return codes;
}

async function main(): Promise<void> {
  const registeredCodes = new Set(getRegisteredAuditEventCodes());
  const referencedCodes = new Set<string>();
  const unknownStaticCodes = new Set<string>();
  const files = (await walkTypeScriptFiles(sourceRoot))
    .filter((file) => !excludedRelativePaths.has(path.relative(sourceRoot, file).replaceAll('\\', '/')))
    .filter((file) => !file.endsWith('.test.ts'));

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const code of findStaticAuditCodeLiterals(source)) {
      if (registeredCodes.has(code)) referencedCodes.add(code);
      else unknownStaticCodes.add(code);
    }
    // This also catches the two static branches of conditional audit events.
    for (const code of registeredCodes) {
      if (source.includes(`'${code}'`) || source.includes(`\"${code}\"`)) referencedCodes.add(code);
    }
  }

  if (unknownStaticCodes.size > 0) {
    throw new Error(`Mã Audit chưa được đăng ký: ${[...unknownStaticCodes].sort().join(', ')}`);
  }

  const unusedCodes = [...registeredCodes].filter((code) => !referencedCodes.has(code)).sort();
  console.log(`[audit-event-usage] OK: ${referencedCodes.size}/${registeredCodes.size} mã Audit đã được tham chiếu từ mã nguồn.`);
  if (unusedCodes.length > 0) {
    console.warn(`[audit-event-usage] CẦN RÀ SOÁT: ${unusedCodes.length} mã đã đăng ký nhưng chưa có caller tĩnh: ${unusedCodes.join(', ')}`);
  }
}

main().catch((error) => {
  console.error('[audit-event-usage] FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
