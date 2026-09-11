/**
 * One-off, operator-owned Help Docs transfer between two distinct Supabase
 * environments. This script is deliberately dry-run by default.
 *
 * It reads the source with a repeatable, read-only snapshot; uploads target
 * objects via the application storage/quota protocol; then creates the target
 * Help Docs in one database transaction. Do not run this as part of an API or
 * a PM2 process.
 *
 * Required source-only environment variables (never put their real values in
 * .env.example):
 *   SOURCE_DATABASE_URL
 *   SOURCE_SUPABASE_URL
 *   SOURCE_SUPABASE_SERVICE_KEY
 *
 * The destination is the environment selected by NODE_ENV and the existing
 * .env / .env.production in this backend directory.
 */

import { createHash, randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';

const SOURCE_TENANT_ID = 'c2b9eaa9-3f58-4ece-9374-3b2224520adb';
const TARGET_TENANT_ID = '32bc96aa-3581-4719-b72d-a7df0ddf2b2f';
const STORAGE_BUCKET = 'landa-storage';
const CONFIRMATION = 'TRANSFER_HELP_DOCS_C2_TO_32';
const MAX_SOURCE_OBJECT_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 256 * 1024 * 1024;
const DATABASE_QUOTA_SAFETY_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

type SourceFolder = {
  id: string;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

type SourcePage = {
  id: string;
  folder_id: string;
  title: string;
  slug: string;
  content: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

type SourceStorageRow = {
  name: string;
  metadata: JsonRecord | null;
};

type SourceFile = {
  sourcePath: string;
  targetPath: string;
  buffer: Buffer;
  sha256: string;
  contentType: string;
};

type TargetQuota = {
  id: string;
  name: string;
  data_limit_bytes: string | null;
  database_used_bytes: string | null;
  storage_used_bytes: string | null;
  storage_reserved_bytes: string | null;
  state: string | null;
};

type TargetFolder = Omit<SourceFolder, 'id'> & { id: string };
type TargetPage = Omit<SourcePage, 'id' | 'folder_id'> & { id: string; folder_id: string; tenant_id: string };
type StorageModule = typeof import('../config/storage.js');

function printHelp(): void {
  console.log(`
Usage (dry run):
  npm run transfer:help-docs

Execute only after reviewing the dry-run report:
  npm run transfer:help-docs -- --execute --confirm=${CONFIRMATION} \\
    --confirm-source=${SOURCE_TENANT_ID} --confirm-target=${TARGET_TENANT_ID}

The target is loaded from this backend's .env or .env.production. Provide
SOURCE_DATABASE_URL, SOURCE_SUPABASE_URL and SOURCE_SUPABASE_SERVICE_KEY only
through the shell environment. The script never prints them.
`);
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  return value;
}

function endpointIdentity(value: string, name: string): string {
  try {
    const url = new URL(value);
    const defaultPort = url.protocol === 'https:' || url.protocol === 'postgresql:' || url.protocol === 'postgres:' ? '443' : '80';
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || defaultPort}`;
  } catch {
    throw new Error(`${name} không phải URL kết nối hợp lệ.`);
  }
}

function asBigInt(value: string | null | undefined): bigint {
  return value ? BigInt(value) : 0n;
}

function formatBytes(value: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = Number(value);
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} ${units[unitIndex]}`;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contentTypeFor(row: SourceStorageRow, providerContentType: string): string {
  if (providerContentType) return providerContentType;
  const metadata = isJsonRecord(row.metadata) ? row.metadata : {};
  for (const key of ['mimetype', 'contentType', 'content_type']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'application/octet-stream';
}

function assertSafeStoragePath(path: string, expectedPrefix: string, label: string): void {
  if (!path.startsWith(expectedPrefix) || path.length <= expectedPrefix.length) {
    throw new Error(`${label} nằm ngoài phạm vi Help Docs được phép: ${path}`);
  }
  if (path.includes('..') || path.includes('\\') || path.includes('//') || /[<>"|?*]/.test(path)) {
    throw new Error(`${label} không an toàn: ${path}`);
  }
}

function targetPathFor(sourcePath: string): string {
  const sourcePrefix = `${SOURCE_TENANT_ID}/help-docs/`;
  assertSafeStoragePath(sourcePath, sourcePrefix, 'Đường dẫn nguồn');
  return `${TARGET_TENANT_ID}/help-docs/${sourcePath.slice(sourcePrefix.length)}`;
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function storagePathFromImageSource(value: string): string | null {
  const raw = value.trim();
  const sourcePrefix = `${SOURCE_TENANT_ID}/help-docs/`;
  if (raw.startsWith(sourcePrefix)) return raw;

  const proxyPrefix = '/api/storage/';
  if (raw.startsWith(proxyPrefix)) return decodePath(raw.slice(proxyPrefix.length));

  try {
    const url = new URL(raw);
    if (url.pathname.startsWith(proxyPrefix)) return decodePath(url.pathname.slice(proxyPrefix.length));
    const publicMarker = `/object/public/${STORAGE_BUCKET}/`;
    const markerIndex = url.pathname.indexOf(publicMarker);
    if (markerIndex >= 0) return decodePath(url.pathname.slice(markerIndex + publicMarker.length));
  } catch {
    return null;
  }
  return null;
}

/**
 * Canonicalize imported image src attributes as raw target storage paths. This
 * prevents old absolute source URLs from continuing to point at environment
 * 226 after the HTML is imported into the local environment.
 */
function rewritePageContent(content: string | null): string {
  if (!content) return content || '';
  const sourcePrefix = `${SOURCE_TENANT_ID}/help-docs/`;
  const targetPrefix = `${TARGET_TENANT_ID}/help-docs/`;
  const imageSourcePattern = /(<img\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  const rewrittenImages = content.replace(imageSourcePattern, (whole, prefix: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
    const source = doubleQuoted ?? singleQuoted ?? bare ?? '';
    const storagePath = storagePathFromImageSource(source);
    if (!storagePath?.startsWith(sourcePrefix)) return whole;
    const targetPath = `${targetPrefix}${storagePath.slice(sourcePrefix.length)}`;
    assertSafeStoragePath(targetPath, targetPrefix, 'Đường dẫn ảnh đích');
    return `${prefix}"${targetPath}"`;
  });

  // Current editors persist raw storage paths. This preserves that convention
  // for any non-img references while every image src above is canonicalized.
  const rewritten = rewrittenImages.split(sourcePrefix).join(targetPrefix);
  if (rewritten.includes(sourcePrefix)) {
    throw new Error('Không thể thay thế đầy đủ đường dẫn Help Docs nguồn trong nội dung trang.');
  }
  return rewritten;
}

function canonicalFolders(rows: readonly { title: string; slug: string; icon: string | null; sort_order: number; created_at: Date; updated_at: Date }[]) {
  return rows
    .map((row) => ({
      title: row.title,
      slug: row.slug,
      icon: row.icon,
      sort_order: Number(row.sort_order),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalPages(rows: readonly { folder_key: string; title: string; slug: string; content: string | null; is_published: boolean; sort_order: number; created_at: Date; updated_at: Date }[]) {
  return rows
    .map((row) => ({
      folder_key: row.folder_key,
      title: row.title,
      slug: row.slug,
      content: row.content || '',
      is_published: row.is_published,
      sort_order: Number(row.sort_order),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectedDatabaseBytes(folders: readonly SourceFolder[], pages: readonly SourcePage[]): bigint {
  let total = BigInt(DATABASE_QUOTA_SAFETY_BYTES);
  for (const folder of folders) {
    total += BigInt(Buffer.byteLength(folder.title, 'utf8'));
    total += BigInt(Buffer.byteLength(folder.slug, 'utf8'));
    total += BigInt(Buffer.byteLength(folder.icon || '', 'utf8'));
  }
  for (const page of pages) {
    total += BigInt(Buffer.byteLength(page.title, 'utf8'));
    total += BigInt(Buffer.byteLength(page.slug, 'utf8'));
    total += BigInt(Buffer.byteLength(page.content || '', 'utf8'));
  }
  return total;
}

async function readSourceSnapshot(sourceDatabaseUrl: string, sourceSupabaseUrl: string, sourceServiceKey: string): Promise<{
  folders: SourceFolder[];
  pages: SourcePage[];
  files: SourceFile[];
}> {
  const sourceDatabase = new pg.Client({ connectionString: sourceDatabaseUrl });
  const sourceStorage = createClient(sourceSupabaseUrl, sourceServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await sourceDatabase.connect();
    // The transaction only snapshots metadata. Help Docs image filenames are
    // immutable UUID-style uploads, so holding production locks during object
    // downloads would create needless write contention without improving the
    // transfer's safety.
    await sourceDatabase.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    // A pg Client is a single connection. Keep these snapshot reads ordered;
    // Promise.all here emits a pg v9 deprecation warning and can mask which
    // query failed first.
    const folderResult = await sourceDatabase.query<SourceFolder>(
      `SELECT id, title, slug, icon, sort_order, created_at, updated_at
       FROM public.help_folders
       WHERE tenant_id = $1::uuid
       ORDER BY sort_order ASC, title ASC, id ASC`,
      [SOURCE_TENANT_ID],
    );
    const pageResult = await sourceDatabase.query<SourcePage>(
      `SELECT hp.id, hp.folder_id, hp.title, hp.slug, hp.content, hp.is_published,
              hp.sort_order, hp.created_at, hp.updated_at
       FROM public.help_pages hp
       JOIN public.help_folders hf ON hf.id = hp.folder_id
       WHERE hf.tenant_id = $1::uuid
       ORDER BY hp.sort_order ASC, hp.title ASC, hp.id ASC`,
      [SOURCE_TENANT_ID],
    );
    const storageResult = await sourceDatabase.query<SourceStorageRow>(
      `SELECT name, metadata
       FROM storage.objects
       WHERE bucket_id = $1::text
         AND name LIKE $2::text
       ORDER BY name ASC`,
      [STORAGE_BUCKET, `${SOURCE_TENANT_ID}/help-docs/%`],
    );

    if (folderResult.rowCount === 0 || pageResult.rowCount === 0) {
      throw new Error('Nguồn không có đủ thư mục hoặc trang Tài liệu hướng dẫn để chuyển.');
    }

    await sourceDatabase.query('COMMIT');
    console.log(`[HelpDocsTransfer] Source snapshot collected: ${folderResult.rowCount} folders, ${pageResult.rowCount} pages, ${storageResult.rowCount} files. Verifying file bytes...`);

    const sourceObjectNames = new Set(storageResult.rows.map((row) => row.name));
    const files: SourceFile[] = [];
    let totalBytes = 0;
    for (let index = 0; index < storageResult.rows.length; index += 1) {
      const row = storageResult.rows[index];
      assertSafeStoragePath(row.name, `${SOURCE_TENANT_ID}/help-docs/`, 'Đường dẫn tệp nguồn');
      const { data, error } = await sourceStorage.storage.from(STORAGE_BUCKET).download(row.name);
      if (error || !data) throw new Error(`Không đọc được tệp nguồn thứ ${index + 1}: ${error?.message || 'không có dữ liệu'}`);
      const buffer = Buffer.from(await data.arrayBuffer());
      if (buffer.byteLength > MAX_SOURCE_OBJECT_BYTES) {
        throw new Error(`Tệp nguồn thứ ${index + 1} vượt giới hạn an toàn ${formatBytes(BigInt(MAX_SOURCE_OBJECT_BYTES))}.`);
      }
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        throw new Error(`Tổng dữ liệu nguồn vượt giới hạn an toàn ${formatBytes(BigInt(MAX_SOURCE_TOTAL_BYTES))}.`);
      }
      files.push({
        sourcePath: row.name,
        targetPath: targetPathFor(row.name),
        buffer,
        sha256: sha256(buffer),
        contentType: contentTypeFor(row, data.type),
      });
      if ((index + 1) % 10 === 0 || index + 1 === storageResult.rows.length) {
        console.log(`[HelpDocsTransfer] Source files verified: ${index + 1}/${storageResult.rows.length}.`);
      }
    }

    const sourcePrefix = `${SOURCE_TENANT_ID}/help-docs/`;
    for (const page of pageResult.rows) {
      const content = page.content || '';
      const referencedPaths = [...content.matchAll(new RegExp(`${SOURCE_TENANT_ID}/help-docs/[^\\s"'<>]+`, 'g'))]
        .map((match) => match[0].replace(/[),.;]+$/, ''));
      for (const path of referencedPaths) {
        if (path.startsWith(sourcePrefix) && !sourceObjectNames.has(path)) {
          throw new Error('Nội dung nguồn tham chiếu một ảnh Help Docs không tồn tại trong Storage.');
        }
      }
      page.content = rewritePageContent(page.content);
    }

    return { folders: folderResult.rows, pages: pageResult.rows, files };
  } catch (error) {
    await sourceDatabase.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await sourceDatabase.end().catch(() => undefined);
  }
}

async function targetStorageHash(storage: StorageModule, path: string): Promise<string> {
  const downloaded = await storage.downloadFileBuffer(path);
  return sha256(downloaded.buffer);
}

async function assertTargetIsReady(
  pool: Pool,
  expectedPaths: ReadonlySet<string>,
): Promise<TargetQuota> {
  const [quotaResult, documentsResult, storageResult] = await Promise.all([
    pool.query<TargetQuota>(
      `SELECT t.id, t.name, t.data_limit_bytes::text,
              q.database_used_bytes::text, q.storage_used_bytes::text,
              q.storage_reserved_bytes::text, q.state
       FROM public.tenants t
       LEFT JOIN public.tenant_data_quota_usage q ON q.tenant_id = t.id
       WHERE t.id = $1::uuid`,
      [TARGET_TENANT_ID],
    ),
    pool.query<{ folders: string; pages: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM public.help_folders WHERE tenant_id = $1::uuid) AS folders,
         (SELECT COUNT(*)::text
          FROM public.help_pages hp
          JOIN public.help_folders hf ON hf.id = hp.folder_id
          WHERE hf.tenant_id = $1::uuid) AS pages`,
      [TARGET_TENANT_ID],
    ),
    pool.query<{ name: string }>(
      `SELECT name
       FROM storage.objects
       WHERE bucket_id = $1::text
         AND name LIKE $2::text
       ORDER BY name ASC`,
      [STORAGE_BUCKET, `${TARGET_TENANT_ID}/help-docs/%`],
    ),
  ]);

  const quota = quotaResult.rows[0];
  if (!quota) throw new Error('Không tìm thấy tenant đích chính xác.');
  if (quota.state !== 'enforced') {
    throw new Error(`Tenant đích chưa sẵn sàng kiểm soát dung lượng (trạng thái: ${quota.state || 'không xác định'}).`);
  }
  if (documentsResult.rows[0]?.folders !== '0' || documentsResult.rows[0]?.pages !== '0') {
    throw new Error('Tenant đích đã có Tài liệu hướng dẫn; tool từ chối ghi chồng dữ liệu.');
  }

  for (const row of storageResult.rows) {
    if (!expectedPaths.has(row.name)) {
      throw new Error('Tenant đích có tệp Help Docs không thuộc phiên chuyển này; tool từ chối ghi chồng dữ liệu.');
    }
  }
  return quota;
}

async function assertExistingTargetFilesAreAccounted(
  pool: Pool,
  existingPaths: readonly string[],
): Promise<void> {
  if (existingPaths.length === 0) return;
  const result = await pool.query<{ storage_path: string }>(
    `SELECT storage_path
     FROM public.tenant_storage_quota_objects
     WHERE tenant_id = $1::uuid
       AND storage_path = ANY($2::text[])`,
    [TARGET_TENANT_ID, existingPaths],
  );
  if (result.rowCount !== existingPaths.length) {
    throw new Error('Có tệp đích từ lần chạy trước chưa được quota ledger xác nhận. Hãy chạy worker reconciliation trước khi tiếp tục.');
  }
}

async function insertHelpDocs(
  pool: Pool,
  folders: readonly SourceFolder[],
  pages: readonly SourcePage[],
): Promise<Map<string, string>> {
  const client = await pool.connect();
  const folderIdMap = new Map<string, string>();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`help-docs-transfer:${TARGET_TENANT_ID}`]);
    await client.query('SELECT id FROM public.tenants WHERE id = $1::uuid FOR UPDATE', [TARGET_TENANT_ID]);

    const occupied = await client.query<{ folders: string; pages: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM public.help_folders WHERE tenant_id = $1::uuid) AS folders,
         (SELECT COUNT(*)::text
          FROM public.help_pages hp
          JOIN public.help_folders hf ON hf.id = hp.folder_id
          WHERE hf.tenant_id = $1::uuid) AS pages`,
      [TARGET_TENANT_ID],
    );
    if (occupied.rows[0]?.folders !== '0' || occupied.rows[0]?.pages !== '0') {
      throw new Error('Tenant đích đã phát sinh Tài liệu hướng dẫn trong lúc chuyển; không ghi chồng dữ liệu.');
    }

    for (const folder of folders) {
      const targetFolderId = randomUUID();
      folderIdMap.set(folder.id, targetFolderId);
      await client.query(
        `INSERT INTO public.help_folders
           (id, tenant_id, title, slug, icon, sort_order, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::int, $7::timestamptz, $8::timestamptz)`,
        [targetFolderId, TARGET_TENANT_ID, folder.title, folder.slug, folder.icon, folder.sort_order, folder.created_at, folder.updated_at],
      );
    }

    for (const page of pages) {
      const targetFolderId = folderIdMap.get(page.folder_id);
      if (!targetFolderId) throw new Error('Trang nguồn không thuộc thư mục nguồn đã xác nhận.');
      await client.query(
        `INSERT INTO public.help_pages
           (id, folder_id, tenant_id, title, slug, content, is_published, sort_order, created_by, updated_by, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::int, NULL, NULL, $9::timestamptz, $10::timestamptz)`,
        [randomUUID(), targetFolderId, TARGET_TENANT_ID, page.title, page.slug, page.content || '', page.is_published, page.sort_order, page.created_at, page.updated_at],
      );
    }

    await client.query('COMMIT');
    return folderIdMap;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyDestination(
  pool: Pool,
  storage: StorageModule,
  folders: readonly SourceFolder[],
  pages: readonly SourcePage[],
  files: readonly SourceFile[],
  targetFolderIdMap: ReadonlyMap<string, string>,
): Promise<void> {
  const [targetFoldersResult, targetPagesResult, storageRows, ledgerRows] = await Promise.all([
    pool.query<TargetFolder>(
      `SELECT id, title, slug, icon, sort_order, created_at, updated_at
       FROM public.help_folders
       WHERE tenant_id = $1::uuid`,
      [TARGET_TENANT_ID],
    ),
    pool.query<TargetPage>(
      `SELECT hp.id, hp.folder_id, hp.tenant_id, hp.title, hp.slug, hp.content, hp.is_published,
              hp.sort_order, hp.created_at, hp.updated_at
       FROM public.help_pages hp
       JOIN public.help_folders hf ON hf.id = hp.folder_id
       WHERE hf.tenant_id = $1::uuid`,
      [TARGET_TENANT_ID],
    ),
    pool.query<{ name: string }>(
      `SELECT name FROM storage.objects
       WHERE bucket_id = $1::text AND name LIKE $2::text
       ORDER BY name ASC`,
      [STORAGE_BUCKET, `${TARGET_TENANT_ID}/help-docs/%`],
    ),
    pool.query<{ storage_path: string; size_bytes: string }>(
      `SELECT storage_path, size_bytes::text
       FROM public.tenant_storage_quota_objects
       WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])`,
      [TARGET_TENANT_ID, files.map((file) => file.targetPath)],
    ),
  ]);

  const sourceFolderIdByTargetId = new Map([...targetFolderIdMap.entries()].map(([sourceId, targetId]) => [targetId, sourceId]));
  const expectedPages = canonicalPages(pages.map((page) => ({ ...page, folder_key: page.folder_id })));
  const actualPages = canonicalPages(targetPagesResult.rows.map((page) => {
    const sourceFolderId = sourceFolderIdByTargetId.get(page.folder_id);
    if (!sourceFolderId) throw new Error('Trang đích không thuộc thư mục đích hợp lệ.');
    if (page.tenant_id !== TARGET_TENANT_ID) throw new Error('Trang đích mang tenant_id không hợp lệ.');
    return { ...page, folder_key: sourceFolderId };
  }));

  if (
    targetFoldersResult.rowCount !== folders.length
    || targetPagesResult.rowCount !== pages.length
    || stableDigest(canonicalFolders(folders)) !== stableDigest(canonicalFolders(targetFoldersResult.rows))
    || stableDigest(expectedPages) !== stableDigest(actualPages)
  ) {
    throw new Error('Đối soát dữ liệu Help Docs đích không khớp sau khi chuyển.');
  }

  const expectedFileMap = new Map(files.map((file) => [file.targetPath, file]));
  if (storageRows.rowCount !== files.length || storageRows.rows.some((row) => !expectedFileMap.has(row.name))) {
    throw new Error('Đối soát danh sách tệp Help Docs đích không khớp.');
  }
  if (ledgerRows.rowCount !== files.length) {
    throw new Error('Quota ledger chưa ghi nhận đủ tất cả tệp Help Docs đã chuyển.');
  }
  const ledgerByPath = new Map(ledgerRows.rows.map((row) => [row.storage_path, BigInt(row.size_bytes)]));
  for (const file of files) {
    const targetHash = await targetStorageHash(storage, file.targetPath);
    if (targetHash !== file.sha256) throw new Error('Đối soát SHA-256 tệp Help Docs đích không khớp.');
    if (ledgerByPath.get(file.targetPath) !== BigInt(file.buffer.byteLength)) {
      throw new Error('Quota ledger có kích thước tệp Help Docs không khớp.');
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const execute = args.includes('--execute');
  if (execute) {
    if (!args.includes(`--confirm=${CONFIRMATION}`)) {
      throw new Error(`Từ chối ghi dữ liệu nếu thiếu --confirm=${CONFIRMATION}`);
    }
    if (!args.includes(`--confirm-source=${SOURCE_TENANT_ID}`) || !args.includes(`--confirm-target=${TARGET_TENANT_ID}`)) {
      throw new Error('Từ chối ghi dữ liệu vì tenant xác nhận không khớp phiên chuyển đã được duyệt.');
    }
  }

  const sourceDatabaseUrl = requireEnvironment('SOURCE_DATABASE_URL');
  const sourceSupabaseUrl = requireEnvironment('SOURCE_SUPABASE_URL');
  const sourceServiceKey = requireEnvironment('SOURCE_SUPABASE_SERVICE_KEY');
  const database = await import('../config/database.js');
  const storage = await import('../config/storage.js');
  const { env } = await import('../config/env.js');

  if (endpointIdentity(sourceDatabaseUrl, 'SOURCE_DATABASE_URL') === endpointIdentity(env.DATABASE_URL, 'DATABASE_URL')) {
    throw new Error('Nguồn và đích đang trỏ cùng endpoint database; từ chối chuyển dữ liệu.');
  }
  if (endpointIdentity(sourceSupabaseUrl, 'SOURCE_SUPABASE_URL') === endpointIdentity(env.SUPABASE_URL, 'SUPABASE_URL')) {
    throw new Error('Nguồn và đích đang trỏ cùng endpoint Storage; từ chối chuyển dữ liệu.');
  }

  let createdTargetPaths: string[] = [];
  let databaseCommitted = false;
  try {
    const sourceSnapshot = await readSourceSnapshot(sourceDatabaseUrl, sourceSupabaseUrl, sourceServiceKey);
    const expectedPaths = new Set(sourceSnapshot.files.map((file) => file.targetPath));
    const targetQuota = await assertTargetIsReady(database.pool, expectedPaths);
    const sourceStorageBytes = sourceSnapshot.files.reduce((total, file) => total + BigInt(file.buffer.byteLength), 0n);
    const projectedMinimumBytes = sourceStorageBytes + expectedDatabaseBytes(sourceSnapshot.folders, sourceSnapshot.pages);
    const availableBytes = targetQuota.data_limit_bytes === null
      ? null
      : asBigInt(targetQuota.data_limit_bytes)
        - asBigInt(targetQuota.database_used_bytes)
        - asBigInt(targetQuota.storage_used_bytes)
        - asBigInt(targetQuota.storage_reserved_bytes);

    if (availableBytes !== null && projectedMinimumBytes > availableBytes) {
      throw new Error(`Dung lượng trống của tenant đích không đủ cho phiên chuyển an toàn (cần tối thiểu ${formatBytes(projectedMinimumBytes)}).`);
    }

    const existingPathsResult = await database.pool.query<{ name: string }>(
      `SELECT name FROM storage.objects
       WHERE bucket_id = $1::text AND name = ANY($2::text[])
       ORDER BY name ASC`,
      [STORAGE_BUCKET, sourceSnapshot.files.map((file) => file.targetPath)],
    );
    const existingPaths = existingPathsResult.rows.map((row) => row.name);
    await assertExistingTargetFilesAreAccounted(database.pool, existingPaths);

    console.log(`[HelpDocsTransfer] Source: ${sourceSnapshot.folders.length} folders, ${sourceSnapshot.pages.length} pages, ${sourceSnapshot.files.length} files (${formatBytes(sourceStorageBytes)}).`);
    console.log(`[HelpDocsTransfer] Target: ${targetQuota.name}; quota state=${targetQuota.state}; available=${availableBytes === null ? 'unlimited' : formatBytes(availableBytes)}.`);
    console.log(`[HelpDocsTransfer] Existing resumable target files: ${existingPaths.length}; files to upload: ${sourceSnapshot.files.length - existingPaths.length}.`);

    for (const file of sourceSnapshot.files) {
      if (!existingPaths.includes(file.targetPath)) continue;
      const targetHash = await targetStorageHash(storage, file.targetPath);
      if (targetHash !== file.sha256) {
        throw new Error('Có tệp Help Docs đích cùng đường dẫn nhưng SHA-256 không trùng nguồn; từ chối ghi đè.');
      }
    }

    if (!execute) {
      console.log(`[HelpDocsTransfer] Dry run passed. No database or Storage data was changed. Re-run with --execute and all confirmations to transfer.`);
      return;
    }

    for (let index = 0; index < sourceSnapshot.files.length; index += 1) {
      const file = sourceSnapshot.files[index];
      if (existingPaths.includes(file.targetPath)) continue;
      await storage.uploadFile(file.targetPath, file.buffer, file.contentType, false);
      createdTargetPaths.push(file.targetPath);
      const targetHash = await targetStorageHash(storage, file.targetPath);
      if (targetHash !== file.sha256) throw new Error(`SHA-256 không khớp ngay sau khi tải tệp thứ ${index + 1}.`);
      console.log(`[HelpDocsTransfer] Uploaded and verified ${index + 1}/${sourceSnapshot.files.length}.`);
    }

    const targetFolderIdMap = await insertHelpDocs(database.pool, sourceSnapshot.folders, sourceSnapshot.pages);
    databaseCommitted = true;
    await verifyDestination(database.pool, storage, sourceSnapshot.folders, sourceSnapshot.pages, sourceSnapshot.files, targetFolderIdMap);
    console.log('[HelpDocsTransfer] Completed and verified: Help Docs, images, SHA-256, and quota ledger all match.');
  } catch (error) {
    if (!databaseCommitted && createdTargetPaths.length > 0) {
      console.error(`[HelpDocsTransfer] Transfer failed before database commit; cleaning up ${createdTargetPaths.length} newly uploaded target file(s).`);
      try {
        await storage.deleteFiles(createdTargetPaths);
      } catch (cleanupError) {
        console.error('[HelpDocsTransfer] Cleanup requires reconciliation:', cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
    }
    throw error;
  } finally {
    await database.pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[HelpDocsTransfer] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
