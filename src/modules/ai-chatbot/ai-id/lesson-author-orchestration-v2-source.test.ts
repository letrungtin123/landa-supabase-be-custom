import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createSourceSnapshotRepositoryV2, SourceSnapshotRepositoryV2Error } from './lesson-author-orchestration-v2-source.repository.js';
import { normalizeSourceFactPageV2, sourceFactPageDigestV2, SourceFactV2Error } from './lesson-author-orchestration-v2-source.logic.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const candidates = [{ document_id: id(1), fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Nội dung nguồn.', source_page: 1,
  locator: { source_evidence_status: 'ready', source_evidence_revision: 'a'.repeat(64) } }];
const target = { snapshotId: id(2), workspaceId: id(3), tenantId: id(4), courseId: 'course-v1:test+1+2026' };

function db(responses: Array<Array<Record<string, unknown>>>): GenerationJobSql {
  return { async query() { const rows = responses.shift() ?? []; return { rows, rowCount: rows.length }; } } as unknown as GenerationJobSql;
}

test('normalizes a bounded contiguous page and hashes exact UTF-8 fact text', () => {
  const rows = normalizeSourceFactPageV2(5, candidates);
  assert.equal(rows[0].ordinal, 5);
  assert.match(rows[0].fact_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].locator.source_evidence_status, 'ready');
  assert.equal(rows[0].locator.source_evidence_revision, 'a'.repeat(64));
  assert.equal(sourceFactPageDigestV2(rows), sourceFactPageDigestV2(normalizeSourceFactPageV2(5, candidates)));
  assert.throws(() => normalizeSourceFactPageV2(-1, candidates), SourceFactV2Error);
  assert.throws(() => normalizeSourceFactPageV2(0, [...candidates, { ...candidates[0] }]),
    (error) => error instanceof SourceFactV2Error && error.code === 'SOURCE_FACT_IDENTITY_DUPLICATE');
});

test('appends only at the authoritative tail and confirms every inserted row', async () => {
  const repository = createSourceSnapshotRepositoryV2();
  const result = await repository.appendPage(db([
    [{ status: 'building', fact_count: 0 }],
    [],
    [{ count: 0, last: -1 }],
    [{ ordinal: 0 }],
  ]), target, 0, candidates);
  assert.equal(result.inserted, true);
  assert.equal(result.next_ordinal, 1);
  await assert.rejects(repository.appendPage(db([
    [{ status: 'building', fact_count: 0 }], [], [{ count: 2, last: 1 }],
  ]), target, 0, candidates),
  (error) => error instanceof SourceSnapshotRepositoryV2Error && error.code === 'SOURCE_FACT_PAGE_CONFLICT');
});

test('replays an exact committed page without writing it twice', async () => {
  const rows = normalizeSourceFactPageV2(0, candidates);
  const repository = createSourceSnapshotRepositoryV2();
  const result = await repository.appendPage(db([
    [{ status: 'building', fact_count: 0 }],
    rows.map((row) => ({ ordinal: row.ordinal, fact_key: row.fact_key, scope_key: row.scope_key,
      fact_hash: row.fact_hash, document_id: row.document_id })),
  ]), target, 0, candidates);
  assert.equal(result.inserted, false);
  assert.equal(result.page_digest, sourceFactPageDigestV2(rows));
});

test('seals only from database-computed nonempty totals', async () => {
  const repository = createSourceSnapshotRepositoryV2();
  assert.deepEqual(await repository.seal(db([[{ fact_count: 10, scope_count: 2, content_bytes: 1000 }]]), target),
    { fact_count: 10, scope_count: 2, content_bytes: 1000 });
  await assert.rejects(repository.seal(db([[]]), target),
    (error) => error instanceof SourceSnapshotRepositoryV2Error && error.code === 'SOURCE_SNAPSHOT_SEAL_UNCONFIRMED');
});

test('builds the bounded scope catalog from persisted facts instead of process memory', async () => {
  const repository = createSourceSnapshotRepositoryV2();
  const catalog = await repository.loadCatalog(db([[{
    scope_key: 'scope-1', source_ref: 'section-1', scope_title: 'Section 1',
    fact_count: 2, content_chars: 17, first_ordinal: 0,
  }]]), target);
  assert.deepEqual(catalog, [{ scope_key: 'scope-1', title: 'Section 1', source_ref: 'section-1',
    fact_count: 2, content_chars: 17 }]);
  await assert.rejects(repository.loadCatalog(db([[]]), target),
    (error) => error instanceof SourceSnapshotRepositoryV2Error && error.code === 'SOURCE_SCOPE_CATALOG_INVALID');
});
