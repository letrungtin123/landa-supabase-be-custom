import { pool, query } from '../config/database.js';
import { deleteFiles, STORAGE_BUCKET } from '../config/storage.js';

const DEFAULT_LIMIT = 100;
const CONFIRMATION = 'DELETE_ORPHAN_PROFILE_AVATARS';
const PROFILE_AVATAR_PATTERN = '^[0-9a-fA-F-]{36}/avatars/[0-9a-fA-F-]{36}\\.[^/]+$';

type CandidateRow = {
  storage_path: string;
};

function readPositiveLimit(args: readonly string[]): number {
  const raw = args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error('--limit must be an integer from 1 to 1000');
  }
  return parsed;
}

async function findOrphanedProfileAvatars(limit: number): Promise<string[]> {
  const result = await query<CandidateRow>(
    `SELECT object.name AS storage_path
     FROM storage.objects object
     WHERE object.bucket_id = $1::text
       -- Only the deterministic profile-avatar convention is eligible. Bot
       -- avatars and all other tenant files have different filenames.
       AND object.name ~ $2::text
       AND NOT EXISTS (
         SELECT 1
         FROM users account
         WHERE account.tenant_id::text = split_part(object.name, '/', 1)
           AND account.id::text = regexp_replace(split_part(object.name, '/', 3), '\\..*$', '')
       )
     ORDER BY object.name ASC
     LIMIT $3::int`,
    [STORAGE_BUCKET, PROFILE_AVATAR_PATTERN, limit],
  );
  return result.rows.map((row) => row.storage_path);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const confirmed = args.includes(`--confirm=${CONFIRMATION}`);
  const limit = readPositiveLimit(args);
  const candidates = await findOrphanedProfileAvatars(limit);

  console.log(`[DeletionReconcile] Found ${candidates.length} exact orphan profile-avatar candidate(s) (limit ${limit}).`);
  if (!apply) {
    console.log(`[DeletionReconcile] Dry run only. To delete this bounded batch, rerun with --apply --confirm=${CONFIRMATION}.`);
    return;
  }
  if (!confirmed) {
    throw new Error(`Refusing to delete storage objects without --confirm=${CONFIRMATION}`);
  }

  await deleteFiles(candidates);
  console.log(`[DeletionReconcile] Deleted ${candidates.length} orphan profile-avatar object(s).`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('[DeletionReconcile] Failed:', error instanceof Error ? error.message : String(error));
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
