import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answers,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
} from '../../test-support/sql-characterization.js';

// Characterization of the deletion Storage manifest
// (storage-manifest.service.ts), shared by course and user deletion: path
// registration, prefix and avatar discovery with their durable cursors, the
// drain (claim, Storage removal, success or release) and the unfinished
// count. Every SQL statement (text without whitespace differences,
// parameters, pool or transaction client, client releases), every Storage
// request (fetch double) and the result or error are recorded. The golden
// file was written by the code before the manifest repository existed;
// moving SQL into repositories must keep every entry equal.
//
// No database or network. A pg double answers every statement with one fixed
// row; a batched statement (one with "LIMIT $n") gets that row the first time
// its text is sent and no row afterwards. Rewrite the golden file only for an
// intended change:
//   STORAGE_MANIFEST_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/deletion/storage-manifest-sql.characterization.test.ts
// STORAGE_MANIFEST_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
let storageFails = false;
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  const sent = typeof init?.body === 'string' ? ` ${init.body}` : '';
  storageRequests.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}${sent}`);
  if (storageFails && method === 'DELETE') {
    return new globalThis.Response(JSON.stringify({ statusCode: '500', error: 'internal', message: 'storage down' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const manifest = await import('./storage-manifest.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const ITEM = 'c0000000-0000-4000-8000-000000000001';

const ROW = {
  id: ITEM,
  storage_path: `${TENANT}/courses/c1/a.png`,
  last_storage_path: null,
  completed_at: null,
  count: '3',
  data_limit_bytes: null,
  database_used_bytes: '0',
  storage_used_bytes: '0',
  storage_reserved_bytes: '0',
  state: 'observing',
  size_bytes: '0',
  ready: false,
};

function oneBatch(): Answer {
  const seen = new Set<string>();
  return text => {
    if (!/LIMIT \$\d/.test(text)) return undefined;
    if (seen.has(text)) return { rows: [] };
    seen.add(text);
    return undefined;
  };
}

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer, fails = false) =>
  cases.push({
    name,
    run: async () => {
      storageFails = fails;
      try {
        return await run();
      } finally {
        storageFails = false;
      }
    },
    answer: answer ? answers(answer, oneBatch()) : oneBatch(),
  });
const CURSOR = /SELECT last_storage_path, completed_at/;

add('helpers', async () => [
  manifest.shouldAdvanceStorageScanCursor(null, 'a'),
  manifest.shouldAdvanceStorageScanCursor('b', 'a'),
  manifest.normalizeTenantStoragePath(` https://x.test/storage/v1/object/public/landa-storage/${TENANT}/a%20b.png `, TENANT),
  manifest.normalizeTenantStoragePath(`${TENANT}/../x`, TENANT),
  manifest.normalizeTenantStoragePath('22222222-2222-4222-8222-222222222222/x', TENANT),
  manifest.getUserAvatarStorageStem(TENANT, USER),
  manifest.getUserAvatarStorageStem(TENANT, 'nope'),
  manifest.getUserAvatarStorageCursorPrefix(TENANT, USER),
]);
add('register paths', () =>
  manifest.registerStorageManifestPaths('course', JOB, TENANT, [
    `${TENANT}/courses/c1/a.png`,
    ` ${TENANT}/courses/c1/a.png `,
    `https://x.test/storage/v1/object/public/landa-storage/${TENANT}/courses/c1/b.png`,
    '22222222-2222-4222-8222-222222222222/x.png',
    `${TENANT}//bad`,
    '',
  ]),
);
add('register paths none', () => manifest.registerStorageManifestPaths('user', JOB, TENANT, ['https://cdn.example.test/a.png']));
add('register paths conflict', () => manifest.registerStorageManifestPaths('course', JOB, TENANT, [`${TENANT}/a.png`]), noRowsWhen(/INSERT INTO deletion_storage_items/));
add('prefix scan', () => manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, `${TENANT}/courses/c1/`));
add('prefix scan excluding moved assets', () =>
  manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, `${TENANT}/courses/c1/`, { excludeCourseAssetReferencesForOtherCourses: 'c1' }),
);
add('prefix scan resumes', () =>
  manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, `${TENANT}/assignments/c1/`),
  rowsWhen(CURSOR, [{ last_storage_path: `${TENANT}/assignments/c1/m.pdf`, completed_at: null }]),
);
add('prefix scan done', () =>
  manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, `${TENANT}/courses/c1/`),
  rowsWhen(CURSOR, [{ last_storage_path: null, completed_at: new Date('2026-10-01T00:00:00.000Z') }]),
);
add('prefix scan no cursor', () => manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, `${TENANT}/courses/c1/`), noRowsWhen(CURSOR));
add('prefix scan not a directory', () => manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, `${TENANT}/courses/c1`));
add('prefix scan other tenant', () => manifest.registerStoragePrefixManifestPaths('course', JOB, TENANT, '22222222-2222-4222-8222-222222222222/x/'));
add('avatar scan', () => manifest.registerUserAvatarStemManifestPaths(JOB, TENANT, USER));
add('avatar scan bad user', () => manifest.registerUserAvatarStemManifestPaths(JOB, TENANT, 'x'));
add('drain', () => manifest.deleteStorageManifest('course', JOB));
add('drain empty', () => manifest.deleteStorageManifest('user', JOB), noRowsWhen(/WITH expired AS/));
add('drain storage fails', () => manifest.deleteStorageManifest('course', JOB), undefined, true);
add('drain release fails', () =>
  manifest.deleteStorageManifest('course', JOB),
  text => (/SET status = 'pending', lease_expires_at = NULL, last_error = \$2/.test(text) ? { error: { code: '08006', message: 'lost' } } : undefined),
  true,
);
add('unfinished count', () => manifest.countUnfinishedStorageManifestItems('course', JOB));
add('unfinished count none', () => manifest.countUnfinishedStorageManifestItems('user', JOB), noRowsWhen(/count\(\*\)/));

registerCharacterization({
  title: 'storage manifest characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'storage-manifest-sql.characterization.golden.json'),
  writeEnv: 'STORAGE_MANIFEST_SQL_GOLDEN_WRITE',
  fullOutEnv: 'STORAGE_MANIFEST_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER, JOB, ITEM],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: storageRequests,
});
