import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegisteredAuditEventCodes } from '../modules/audit-logs/audit-event.contract.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dashboardLocaleRoot = path.resolve(backendRoot, '..', 'landa-dashboard', 'landa-dashboard', 'src', 'i18n', 'locales');

function hasEventTranslation(source: string, eventCode: string): boolean {
  const escaped = eventCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${escaped}"\\s*:`).test(source);
}

async function main(): Promise<void> {
  const [en, vi] = await Promise.all([
    readFile(path.join(dashboardLocaleRoot, 'en.ts'), 'utf8'),
    readFile(path.join(dashboardLocaleRoot, 'vi.ts'), 'utf8'),
  ]);
  const codes = getRegisteredAuditEventCodes();
  const missingEn = codes.filter((code) => !hasEventTranslation(en, code));
  const missingVi = codes.filter((code) => !hasEventTranslation(vi, code));

  if (missingEn.length || missingVi.length) {
    const messages = [
      missingEn.length ? `EN thiếu: ${missingEn.join(', ')}` : '',
      missingVi.length ? `VI thiếu: ${missingVi.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(`Audit event translations are incomplete. ${messages.join(' | ')}`);
  }
  console.log(`[audit-i18n] OK: ${codes.length} registered event codes have EN and VI translations.`);
}

main().catch((error) => {
  console.error('[audit-i18n] FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
