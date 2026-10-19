import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of course outline transfers (course-outline-transfer.service.ts):
// the worker side (claim with its lease, asset preparation, the Storage copy
// with its lease renewals, the final duplicate, the retry / terminal mark
// with its max_attempts and backoff SQL, the copied Storage cleanup and the
// schema gate) and the request side (target courses, destination options
// and parents, the transfer request, the job status). Every SQL statement
// (exact text, parameters), Storage request, Redis command, log line and
// result is digested into a golden file written by the code before the
// service was split into files. Rewrite it only for an intended change:
//   COURSE_OUTLINE_TRANSFER_GOLDEN_WRITE=1 npx tsx --test src/modules/course-authoring/course-outline-transfer.characterization.test.ts
// COURSE_OUTLINE_TRANSFER_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const h = await import('../../test-support/job-characterization.js');
const transfer = await import('./course-outline-transfer.service.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const LEASE = 'b1000000-0000-4000-8000-000000000001';
const SOURCE_BLOCK = 'c0000000-0000-4000-8000-000000000001';
const DEST_PARENT = 'c0000000-0000-4000-8000-000000000002';
const DEST_CHAPTER = 'c0000000-0000-4000-8000-000000000003';
const DEST_SEQUENTIAL = 'c0000000-0000-4000-8000-000000000004';
const ROOT_BLOCK = 'c0000000-0000-4000-8000-000000000005';
const ASSET = 'd0000000-0000-4000-8000-000000000001';
const ASSET_2 = 'd0000000-0000-4000-8000-000000000002';
const ASSET_3 = 'd0000000-0000-4000-8000-000000000003';
const JOB_ASSET = 'e0000000-0000-4000-8000-000000000001';
const JOB_ASSET_2 = 'e0000000-0000-4000-8000-000000000002';
const JOB_ASSET_3 = 'e0000000-0000-4000-8000-000000000003';
const IDEMPOTENCY = 'f0000000-0000-4000-8000-000000000001';
const SOURCE_COURSE = 'course-v1:Landa+SRC+2026';
const DEST_COURSE = 'course-v1:Landa+DST+2026';
const ROOT_UPDATED = new Date('2026-10-01T01:02:03.000Z');
const DEST_UPDATED = new Date('2026-10-02T01:02:03.000Z');
const SOURCE_PATH = `${TENANT}/courses/${SOURCE_COURSE}/1790000000000_intro.mp4`;
const SOURCE_PATH_2 = `${TENANT}/courses/${SOURCE_COURSE}/1790000000001_slides.pdf`;

const JOB_ROW = {
  id: JOB,
  tenant_id: TENANT,
  source_course_id: SOURCE_COURSE,
  source_block_id: SOURCE_BLOCK,
  destination_course_id: DEST_COURSE,
  destination_parent_id: DEST_PARENT,
  operation: 'duplicate',
  requested_by: USER,
  requested_username: 'admin.nesso',
  requested_ip: '10.0.0.7',
  source_block_name: 'Chapter one',
  source_block_type: 'chapter',
  source_root_updated_at: ROOT_UPDATED,
  destination_parent_updated_at: DEST_UPDATED,
  status: 'running',
  attempts: 2,
  max_attempts: 5,
  asset_count: 0,
  block_count: 3,
  lease_token: LEASE,
};
const PAYLOAD_ROWS = [
  {
    id: SOURCE_BLOCK,
    data: { html: `<video src="https://storage.example.test/storage/v1/object/public/landa-storage/${SOURCE_PATH}">` },
    metadata: { note: SOURCE_PATH_2, ai_id_author_notes: { text: `${TENANT}/courses/${SOURCE_COURSE}/ignored.png` } },
    published_data: null,
    published_metadata: null,
  },
];
const SOURCE_ASSETS = [
  { id: ASSET, storage_path: SOURCE_PATH, url: null, display_name: 'intro.mp4', content_type: 'video/mp4', file_size: '2048' },
  { id: ASSET_2, storage_path: null, url: SOURCE_PATH_2, display_name: 'slides.pdf', content_type: null, file_size: 512 },
  { id: ASSET_3, storage_path: `${TENANT}/courses/${SOURCE_COURSE}/unused.png`, url: null, display_name: 'unused.png', content_type: 'image/png', file_size: null },
];
const assetRow = (id: string, source: string, contentType: string | null) => ({
  id,
  job_id: JOB,
  tenant_id: TENANT,
  source_asset_id: ASSET,
  source_storage_path: source,
  target_storage_path: `${TENANT}/courses/${DEST_COURSE}/outline-transfers/${JOB}/${id}.bin`,
  display_name: 'file',
  content_type: contentType,
  file_size: '10',
  source_url: null,
  target_url: null,
  status: 'queued',
});
const JOB_ASSETS = [
  assetRow(JOB_ASSET, SOURCE_PATH, 'video/mp4'),
  assetRow(JOB_ASSET_2, SOURCE_PATH_2, null),
  assetRow(JOB_ASSET_3, SOURCE_PATH, 'video/mp4'),
];
const BLOCK = (id: string, courseId: string, blockType: string, updatedAt: Date, parentId: string | null) => ({
  id,
  course_id: courseId,
  parent_id: parentId,
  block_type: blockType,
  display_name: `Block ${blockType}`,
  updated_at: updatedAt,
  deleted_at: null,
  delete_status: 'active',
});
const COURSES = [
  { id: SOURCE_COURSE, display_name: 'Source course', tenant_id: TENANT, deleted_at: null },
  { id: DEST_COURSE, display_name: 'Destination course', tenant_id: TENANT, deleted_at: null },
];
const JOB_STATUS = {
  id: JOB,
  operation: 'duplicate',
  status: 'queued',
  source_course_id: SOURCE_COURSE,
  source_block_id: SOURCE_BLOCK,
  destination_course_id: DEST_COURSE,
  destination_parent_id: DEST_PARENT,
  source_block_name: 'Chapter one',
  source_block_type: 'chapter',
  attempts: 0,
  max_attempts: 5,
  block_count: 3,
  asset_count: 0,
  total_asset_bytes: '0',
  copied_asset_bytes: '0',
  last_error: null,
  created_at: '2026-10-19 10:00:00+07',
  started_at: null,
  next_attempt_at: '2026-10-19 10:00:00+07',
  completed_at: null,
};

// ── Statements ──
const CLAIM = /SET status = 'running', attempts = attempts \+ 1, lease_token = \$1::uuid/;
const REMAINING = /AS count FROM course_outline_transfer_job_assets\n\s+WHERE job_id = \$1::uuid AND tenant_id = \$2::uuid AND status <> 'copied'/;
const PREPARED = /SELECT COUNT\(\*\)::text AS count\n\s+FROM course_outline_transfer_job_assets/;
const PAYLOAD = /SELECT id, data, metadata, published_data, published_metadata\n\s+FROM subtree/;
const SOURCE_ASSET_LIST = /SELECT id, storage_path, url, display_name, content_type, file_size\n\s+FROM course_assets/;
const ROOT_LOCK = /SELECT id, updated_at\n\s+FROM course_blocks/;
const JOB_ASSET_LIST = /SELECT id, job_id, tenant_id, source_asset_id/;
const RENEW = /SET lease_expires_at = now\(\) \+ \(\$3::integer \* interval '1 second'\), updated_at = now\(\)/;
const OWNED = /AND lease_expires_at > now\(\)\n\s+FOR UPDATE/;
const LOCKED_BLOCK = /SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name, b.updated_at, b.deleted_at, b.delete_status/;
const LOCKED_COURSES = /SELECT id, display_name, tenant_id, deleted_at\n\s+FROM courses\n\s+WHERE id = ANY/;
const MARK = /SET status = CASE WHEN \$4::boolean OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END/;
const COPIED = /SELECT target_storage_path FROM course_outline_transfer_job_assets/;
const SCHEMA = /to_regclass\('public.course_outline_transfer_jobs'\)::text AS jobs/;
const SOURCE_TYPE = /SELECT block.block_type\n\s+FROM course_blocks block/;
const COURSE_ACCESS = /FROM courses/;
const PATH_ROWS = /parent.block_type AS parent_block_type, parent.parent_id AS parent_parent_id/;
const EXISTING_JOB = /WHERE tenant_id = \$1::uuid AND requested_by = \$2::uuid AND idempotency_key = \$3::uuid/;
const ROOT_EXISTING = /AND block.block_type = 'course' AND block.deleted_at IS NULL/;
const BLOCK_COUNT = /\) SELECT COUNT\(\*\)::text AS count FROM subtree/;
const INSERT_JOB = /INSERT INTO course_outline_transfer_jobs \(/;
const JOB_BY_ID = /FROM course_outline_transfer_jobs\n\s+WHERE id = \$1::uuid AND tenant_id = \$2::uuid/;
const TARGET_COURSES = /WHERE tenant_id = \$1::uuid AND id <> \$2 AND deleted_at IS NULL/;
const OPTIONS = /AND \(\$5 = '' OR block.display_name ILIKE/;
const PARENTS = /ORDER BY block.sort_order ASC, block.display_name ASC, block.id ASC/;

type Value = Parameters<typeof h.answers>[0][number][1];
type Row = [RegExp, Value];

// Storage quota of the tenant (uploads reserve before the provider call).
const QUOTA: Row[] = [
  [
    /FOR UPDATE OF usage/,
    [{ data_limit_bytes: '1000000000', database_used_bytes: '0', storage_used_bytes: '0', storage_reserved_bytes: '0', state: 'enforced' }],
  ],
  [/FROM tenant_storage_quota_objects/, []],
  [
    /FROM tenant_storage_quota_reservations\n\s+WHERE id = \$1::uuid\n\s+FOR UPDATE/,
    [{ id: ASSET, tenant_id: TENANT, storage_path: 'p', previous_size_bytes: '0', reserved_bytes: '10', requested_size_bytes: '10', status: 'committed' }],
  ],
];

/** Locked source and destination blocks of the job, by id. */
function lockedBlocks(source = BLOCK(SOURCE_BLOCK, SOURCE_COURSE, 'chapter', ROOT_UPDATED, ROOT_BLOCK), destination = BLOCK(DEST_PARENT, DEST_COURSE, 'course', DEST_UPDATED, null)) {
  return (text: string, params: unknown[]) =>
    LOCKED_BLOCK.test(text) ? { rows: params[0] === SOURCE_BLOCK ? [source] : params[0] === DEST_PARENT ? [destination] : [] } : undefined;
}

/** The answers of a duplicate that runs to the end; `first` answers before them. */
function duplicate(first: Row[] = [], blocks = lockedBlocks()): import('../../test-support/job-characterization.js').SqlAnswer {
  const table = h.answers([
    ...first,
    [CLAIM, [JOB_ROW]],
    [REMAINING, [{ count: '0' }]],
    [PREPARED, [{ count: '0' }]],
    [PAYLOAD, PAYLOAD_ROWS],
    [SOURCE_ASSET_LIST, SOURCE_ASSETS],
    [ROOT_LOCK, [{ id: SOURCE_BLOCK, updated_at: ROOT_UPDATED }]],
    [JOB_ASSET_LIST, JOB_ASSETS],
    [RENEW, [{ id: JOB }]],
    [OWNED, [{ id: JOB }]],
    [LOCKED_COURSES, COURSES],
    [/AS next_order/, [{ next_order: 4 }]],
    [MARK, [{ status: 'queued' }]],
    ...QUOTA,
    [COPIED, [{ target_storage_path: `${TENANT}/courses/${DEST_COURSE}/outline-transfers/${JOB}/copied.bin` }]],
  ]);
  return (text, params) => blocks(text, params) ?? table(text, params);
}

type Case = import('../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];
const add = (name: string, sql: Case['sql'], run: Case['run']) => cases.push({ name, sql, run });

const STORAGE_DOWN = () => new globalThis.Response(JSON.stringify({ statusCode: '500', error: 'internal', message: 'storage down' }), { status: 500, headers: { 'content-type': 'application/json' } });

/** Storage answers: the bucket, object downloads (bytes) and uploads / removals (JSON). */
function storage(context: Context, fail?: (method: string, path: string) => boolean): void {
  context.setFetch((method, requestPath) => {
    if (fail?.(method, requestPath)) return STORAGE_DOWN();
    if (method === 'GET' && requestPath.includes('/object/')) {
      return new globalThis.Response(Buffer.from('file bytes'), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', Key: 'k' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

const processNext = async (context: Context) => {
  storage(context);
  return transfer.processNextCourseOutlineTransferJob();
};

// ── Worker side ──
add('no job is due', h.answers([]), processNext);
add('claim fails', h.answers([[CLAIM, h.sqlError('connection reset')]]), processNext);
add('legacy move job fails terminally', duplicate([[CLAIM, [{ ...JOB_ROW, operation: 'move' }]], [MARK, [{ status: 'failed' }]]]), processNext);
add('duplicate runs to the end', duplicate(), processNext);
add('duplicate with assets already prepared', duplicate([[PREPARED, [{ count: '2' }]]]), processNext);
add('duplicate whose job counted its assets', duplicate([[CLAIM, [{ ...JOB_ROW, asset_count: 2 }]], [JOB_ASSET_LIST, JOB_ASSETS.slice(0, 1)]]), processNext);
add('duplicate without assets to copy', duplicate([[PAYLOAD, [{ ...PAYLOAD_ROWS[0], data: {}, metadata: {} }]], [JOB_ASSET_LIST, []]]), processNext);
add('source content is gone', duplicate([[PAYLOAD, []], [MARK, [{ status: 'failed' }]]]), processNext);
add('referenced file is not a course asset', duplicate([[SOURCE_ASSET_LIST, SOURCE_ASSETS.slice(1)], [MARK, [{ status: 'failed' }]]]), processNext);
add('source changed before preparation', duplicate([[ROOT_LOCK, [{ id: SOURCE_BLOCK, updated_at: DEST_UPDATED }]], [MARK, [{ status: 'failed' }]]]), processNext);
add('lease lost during the copy', duplicate([[RENEW, h.sequence([{ id: JOB }], [])]]), processNext);
add('storage download fails and the job is retried', duplicate(), async context => {
  storage(context, (method, requestPath) => method === 'GET' && requestPath.includes('/object/'));
  return transfer.processNextCourseOutlineTransferJob();
});
add('assets still copying at the finish', duplicate([[REMAINING, [{ count: '1' }]]]), processNext);
add('lease lost before the finish', duplicate([[OWNED, []]]), processNext);
add(
  'destination changed before the finish',
  duplicate([], lockedBlocks(undefined, BLOCK(DEST_PARENT, DEST_COURSE, 'course', ROOT_UPDATED, null))),
  processNext,
);
add('destination is no longer a valid parent', duplicate([], lockedBlocks(undefined, BLOCK(DEST_PARENT, DEST_COURSE, 'sequential', DEST_UPDATED, null))), processNext);
add('source type changed before the finish', duplicate([], lockedBlocks(BLOCK(SOURCE_BLOCK, SOURCE_COURSE, 'vertical', ROOT_UPDATED, ROOT_BLOCK))), processNext);
add('a course is gone before the finish', duplicate([[LOCKED_COURSES, COURSES.slice(0, 1)]]), processNext);
add('quota is reached during the copy', duplicate([[/INSERT INTO course_assets/, Object.assign(new Error('quota'), { code: 'LQ001' })]]), processNext);
add('quota reconciling during the copy', duplicate([[/INSERT INTO course_assets/, Object.assign(new Error('reconciling'), { code: 'LQ002' })]]), processNext);
add('terminal duplicate failure cleans copied storage', duplicate([[OWNED, h.sqlError('lock timeout', '55P03')], [MARK, [{ status: 'failed' }]]]), processNext);
add('terminal duplicate cleanup fails', duplicate([[PAYLOAD, []], [MARK, [{ status: 'failed' }]]]), async context => {
  storage(context, method => method === 'DELETE');
  return transfer.processNextCourseOutlineTransferJob();
});
add('terminal duplicate with nothing copied', duplicate([[PAYLOAD, []], [MARK, [{ status: 'failed' }]], [COPIED, []]]), processNext);
add('retry mark fails', duplicate([[PAYLOAD, []], [MARK, h.sqlError('connection reset')]]), processNext);
add('schema ready', h.answers([[SCHEMA, [{ jobs: 'a', assets: 'b', maps: 'c', rewrite: 'd' }]]]), () =>
  transfer.isCourseOutlineTransferSchemaReady(),
);
add('schema missing a table', h.answers([[SCHEMA, [{ jobs: 'a', assets: null, maps: 'c', rewrite: 'd' }]]]), () =>
  transfer.isCourseOutlineTransferSchemaReady(),
);
add('schema check fails', h.answers([[SCHEMA, h.sqlError('permission denied', '42501')]]), () =>
  transfer.isCourseOutlineTransferSchemaReady(),
);
add('storage path normalization', h.answers([]), () =>
  [
    SOURCE_PATH,
    `https://storage.example.test/storage/v1/object/public/landa-storage/${encodeURIComponent(SOURCE_PATH)}?download=1`,
    `${SOURCE_PATH}/../x`,
    '/abs/path',
    'https://elsewhere.example.test/a.png',
    42,
    ' ',
    'x'.repeat(1_201),
  ].map(value => transfer.normalizeCourseOutlineTransferStoragePath(value)),
);

// ── Request side ──
const cursor = Buffer.from(JSON.stringify({ displayName: 'Course B', id: 'course-v1:Landa+B+2026' })).toString('base64url');
const COURSE_PAGE = Array.from({ length: 11 }, (_, index) => ({ id: `course-v1:Landa+C${index}+2026`, display_name: `Course ${index}` }));
add('target courses', h.answers([[TARGET_COURSES, COURSE_PAGE.slice(0, 3)]]), () =>
  transfer.listTransferTargetCourses(TENANT, SOURCE_COURSE, '  intro  '),
);
add('target courses with more pages', h.answers([[TARGET_COURSES, COURSE_PAGE]]), () =>
  transfer.listTransferTargetCourses(TENANT, SOURCE_COURSE, 42, cursor),
);
add('target courses with a bad cursor', h.answers([]), () => transfer.listTransferTargetCourses(TENANT, SOURCE_COURSE, '', 'bm90IGpzb24'));
add('target courses with a cursor of the wrong shape', h.answers([]), () =>
  transfer.listTransferTargetCourses(TENANT, SOURCE_COURSE, '', Buffer.from('{"displayName":1}').toString('base64url')),
);

const accessOk: Row = [COURSE_ACCESS, [{ id: DEST_COURSE }]];
add('destination options for a chapter', h.answers([[SOURCE_TYPE, [{ block_type: 'chapter' }]], accessOk]), () =>
  transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, undefined, '', 10),
);
add(
  'destination options for a unit, first level',
  h.answers([[SOURCE_TYPE, [{ block_type: 'vertical' }]], [OPTIONS, [{ id: DEST_CHAPTER, display_name: 'Ch', block_type: 'chapter' }]], accessOk]),
  () => transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, [], ' ch ', '5'),
);
add(
  'destination options for a unit, second level',
  h.answers([
    [SOURCE_TYPE, [{ block_type: 'vertical' }]],
    [PATH_ROWS, [{ id: DEST_CHAPTER, parent_id: ROOT_BLOCK, block_type: 'chapter', parent_block_type: 'course', parent_parent_id: null }]],
    [OPTIONS, Array.from({ length: 3 }, (_, index) => ({ id: `c0000000-0000-4000-8000-00000000010${index}`, display_name: `Seq ${index}`, block_type: 'sequential' }))],
    accessOk,
  ]),
  () => transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, [DEST_CHAPTER], '', 2),
);
add(
  'destination options for a unit, complete path',
  h.answers([
    [SOURCE_TYPE, [{ block_type: 'vertical' }]],
    [
      PATH_ROWS,
      [
        { id: DEST_CHAPTER, course_id: DEST_COURSE, parent_id: null, block_type: 'chapter', parent_block_type: null, parent_parent_id: null },
        { id: DEST_SEQUENTIAL, course_id: DEST_COURSE, parent_id: DEST_CHAPTER, block_type: 'sequential', parent_block_type: 'chapter', parent_parent_id: null },
      ],
    ],
    accessOk,
  ]),
  () => transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, [DEST_CHAPTER, DEST_SEQUENTIAL], '', 2),
);
add(
  'destination options with a path from elsewhere',
  h.answers([
    [SOURCE_TYPE, [{ block_type: 'vertical' }]],
    [PATH_ROWS, [{ id: DEST_CHAPTER, parent_id: DEST_PARENT, block_type: 'chapter', parent_block_type: 'chapter', parent_parent_id: null }]],
    accessOk,
  ]),
  () => transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, [DEST_CHAPTER], '', 2),
);
add('destination options for a missing source', h.answers([]), () =>
  transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, [], '', 2),
);
add('destination options with a bad source id', h.answers([]), () =>
  transfer.listTransferDestinationOptions(TENANT, 'not-a-uuid', DEST_COURSE, [], '', 2),
);
add('destination options with a path too long', h.answers([[SOURCE_TYPE, [{ block_type: 'sequential' }]]]), () =>
  transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, [DEST_CHAPTER, DEST_SEQUENTIAL], '', 2),
);
add('destination options with a malformed path', h.answers([[SOURCE_TYPE, [{ block_type: 'sequential' }]]]), () =>
  transfer.listTransferDestinationOptions(TENANT, SOURCE_BLOCK, DEST_COURSE, ['x'], '', 2),
);
add('destination parents of a chapter', h.answers([[/FROM courses\n\s+WHERE id = \$1 AND tenant_id = \$2::uuid AND deleted_at IS NULL`?$/, [{ id: DEST_COURSE, display_name: 'Destination course' }]]]), () =>
  transfer.listTransferDestinationParents(TENANT, DEST_COURSE, 'chapter', '', undefined),
);
add('destination parents of a unit', h.answers([[PARENTS, [{ id: DEST_SEQUENTIAL, display_name: 'Seq', block_type: 'sequential' }]]]), () =>
  transfer.listTransferDestinationParents(TENANT, DEST_COURSE, 'vertical', 'seq', 500),
);
add('destination parents of a component', h.answers([]), () =>
  transfer.listTransferDestinationParents(TENANT, DEST_COURSE, 'problem', null, 0),
);

const REQUEST = {
  tenantId: TENANT,
  requestedBy: USER,
  requestedUsername: 'admin.nesso',
  requestedIp: '10.0.0.7',
  sourceBlockId: SOURCE_BLOCK,
  destinationCourseId: DEST_COURSE,
  destinationParentId: DEST_SEQUENTIAL,
  destinationPathIds: [DEST_CHAPTER, DEST_SEQUENTIAL],
  operation: 'duplicate' as const,
  idempotencyKey: IDEMPOTENCY,
};
const SCHEMA_READY: Row = [SCHEMA, [{ jobs: 'a', assets: 'b', maps: 'c', rewrite: 'd' }]];
const VERTICAL_PATH: Row = [
  PATH_ROWS,
  [
    { id: DEST_CHAPTER, course_id: DEST_COURSE, parent_id: ROOT_BLOCK, block_type: 'chapter', parent_block_type: 'course', parent_parent_id: null },
    { id: DEST_SEQUENTIAL, course_id: DEST_COURSE, parent_id: DEST_CHAPTER, block_type: 'sequential', parent_block_type: 'chapter', parent_parent_id: ROOT_BLOCK },
  ],
];
function requestAnswers(
  first: Row[] = [],
  sourceType = 'vertical',
  sourceExtra: Record<string, unknown> = {},
): import('../../test-support/job-characterization.js').SqlAnswer {
  const table = h.answers([
    ...first,
    SCHEMA_READY,
    [BLOCK_COUNT, [{ count: '7' }]],
    [EXISTING_JOB, []],
    [INSERT_JOB, [JOB_STATUS]],
    [ROOT_EXISTING, []],
    [/SELECT id, display_name, tenant_id, deleted_at\n\s+FROM courses\n\s+WHERE id = \$1/, [COURSES[1]]],
    [/INSERT INTO course_blocks \(/, [BLOCK(ROOT_BLOCK, DEST_COURSE, 'course', DEST_UPDATED, null)]],
    VERTICAL_PATH,
  ]);
  return (text, params) => {
    if (LOCKED_BLOCK.test(text)) {
      if (params[0] === SOURCE_BLOCK) return { rows: [{ ...BLOCK(SOURCE_BLOCK, SOURCE_COURSE, sourceType, ROOT_UPDATED, ROOT_BLOCK), ...sourceExtra }] };
      if (params[0] === DEST_SEQUENTIAL) return { rows: [BLOCK(DEST_SEQUENTIAL, DEST_COURSE, 'sequential', DEST_UPDATED, DEST_CHAPTER)] };
      if (params[0] === ROOT_BLOCK) return { rows: [BLOCK(ROOT_BLOCK, DEST_COURSE, 'course', DEST_UPDATED, null)] };
      return { rows: [] };
    }
    return table(text, params);
  };
}
add('request a duplicate', requestAnswers(), () => transfer.requestCourseOutlineTransfer(REQUEST));
add('request replays the same key', requestAnswers([[EXISTING_JOB, [JOB_STATUS]]]), () => transfer.requestCourseOutlineTransfer(REQUEST));
add('request a chapter into the course root', requestAnswers([], 'chapter'), () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationParentId: DEST_COURSE, destinationPathIds: [] }),
);
add('request a chapter into an existing course root', requestAnswers([[ROOT_EXISTING, [BLOCK(ROOT_BLOCK, DEST_COURSE, 'course', DEST_UPDATED, null)]]], 'chapter'), () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationParentId: DEST_COURSE, destinationPathIds: undefined }),
);
add('request a move', requestAnswers(), () => transfer.requestCourseOutlineTransfer({ ...REQUEST, operation: 'move' }));
add('request before the schema is installed', h.answers([]), () => transfer.requestCourseOutlineTransfer(REQUEST));
add(
  'request a destination of the wrong type',
  requestAnswers(
    [[PATH_ROWS, [{ id: DEST_CHAPTER, course_id: DEST_COURSE, parent_id: ROOT_BLOCK, block_type: 'chapter', parent_block_type: 'course', parent_parent_id: null }]]],
    'sequential',
  ),
  () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationPathIds: [DEST_CHAPTER], destinationParentId: DEST_CHAPTER }),
);
add('request a component source', requestAnswers([], 'course'), () => transfer.requestCourseOutlineTransfer(REQUEST));
add('request with a bad key', requestAnswers(), () => transfer.requestCourseOutlineTransfer({ ...REQUEST, idempotencyKey: 'k' }));
add('request a source in the same course', requestAnswers(), () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationCourseId: SOURCE_COURSE }),
);
add('request a source being deleted', requestAnswers([], 'vertical', { delete_status: 'deleting' }), () =>
  transfer.requestCourseOutlineTransfer(REQUEST),
);
add('request an incomplete path', requestAnswers(), () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationPathIds: [DEST_CHAPTER] }),
);
add('request a path that no longer matches', requestAnswers([], 'sequential'), () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationPathIds: [DEST_CHAPTER, DEST_SEQUENTIAL].slice(0, 1), destinationParentId: DEST_CHAPTER }),
);
add('request without a course to create the root in', requestAnswers([[/SELECT id, display_name, tenant_id, deleted_at\n\s+FROM courses\n\s+WHERE id = \$1/, []]], 'chapter'), () =>
  transfer.requestCourseOutlineTransfer({ ...REQUEST, destinationParentId: DEST_COURSE, destinationPathIds: [] }),
);
add('job status', h.answers([[JOB_BY_ID, [JOB_STATUS]]]), () => transfer.getCourseOutlineTransferJob(TENANT, JOB));
add('job status missing', h.answers([]), () => transfer.getCourseOutlineTransferJob(TENANT, JOB));
add('job status with a bad id', h.answers([]), () => transfer.getCourseOutlineTransferJob(TENANT, 'x'));

h.registerJobCharacterization({
  title: 'course outline transfer characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'course-outline-transfer.characterization.golden.json'),
  writeEnv: 'COURSE_OUTLINE_TRANSFER_GOLDEN_WRITE',
  fullOutEnv: 'COURSE_OUTLINE_TRANSFER_FULL_OUT',
  cases,
  fixedIds: [TENANT, USER, JOB, LEASE, SOURCE_BLOCK, DEST_PARENT, DEST_CHAPTER, DEST_SEQUENTIAL, ROOT_BLOCK, ASSET, ASSET_2, ASSET_3, JOB_ASSET, JOB_ASSET_2, JOB_ASSET_3, IDEMPOTENCY],
  now: Date.UTC(2026, 9, 19, 3, 0, 0),
});
