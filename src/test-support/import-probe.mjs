// Child process of src/config/import-side-effects.test.ts (test only):
// imports every module listed in the JSON file IMPORT_PROBE_MODULES, stays a
// moment so a timer or connection started on import gets its chance to run,
// writes what it found to IMPORT_PROBE_OUT, then returns. The process must
// then exit by itself: anything an import left running keeps it alive.
// Preloaded: tsx and process-boot-harness.mjs (BOOT_HARNESS_MODE=observe).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const modules = JSON.parse(readFileSync(process.env.IMPORT_PROBE_MODULES, 'utf8'));
const waitMs = Number(process.env.IMPORT_PROBE_WAIT_MS || 1500);
const failures = [];
for (const file of modules) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const resourcesAfterImport = process.getActiveResourcesInfo();
await new Promise(resolve => setTimeout(resolve, waitMs));
writeFileSync(
  process.env.IMPORT_PROBE_OUT,
  JSON.stringify({
    imported: modules.length,
    failures,
    resourcesAfterImport,
    resourcesAfterWait: process.getActiveResourcesInfo(),
  }),
);
