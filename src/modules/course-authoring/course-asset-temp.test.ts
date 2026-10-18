import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COURSE_ASSET_TEMP_MAX_AGE_MS, cleanupStaleCourseAssetTempFiles } from './course-asset-temp.js';

// L1: a restarting process must not delete an upload another API process is
// still receiving. Temp files in a throwaway OS temp directory.

function tempDirWith(files: Array<{ name: string; ageMs: number }>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'landa-course-assets-test-'));
  for (const file of files) {
    const filePath = path.join(directory, file.name);
    fs.writeFileSync(filePath, 'x');
    const at = new Date(Date.now() - file.ageMs);
    fs.utimesSync(filePath, at, at);
  }
  return directory;
}

test('several processes: only crash residue older than the limit is removed', (t) => {
  const directory = tempDirWith([{ name: 'in-flight.upload', ageMs: 60_000 }, { name: 'residue.upload', ageMs: COURSE_ASSET_TEMP_MAX_AGE_MS + 60_000 }]);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(cleanupStaleCourseAssetTempFiles({ directory, minAgeMs: COURSE_ASSET_TEMP_MAX_AGE_MS }), 1);
  assert.deepEqual(fs.readdirSync(directory), ['in-flight.upload']);
});

test('one process at start (as before): every temp file goes', (t) => {
  const directory = tempDirWith([{ name: 'a.upload', ageMs: 1_000 }, { name: 'b.upload', ageMs: 5_000 }]);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(cleanupStaleCourseAssetTempFiles({ directory }), 2);
  assert.deepEqual(fs.readdirSync(directory), []);
});
