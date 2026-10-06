/**
 * Destructive PostgreSQL acceptance for CP5 publication governance.
 *
 * This runner intentionally refuses the normal runtime database, production
 * mode, Supabase-hosted endpoints and fixtures without an acceptance marker.
 * Every scenario needs its own disposable course because races deliberately
 * stale candidates, revoke permissions, publish content or delete the course.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import pg, { type PoolClient } from 'pg';
import {
  readCoursePublishAcceptanceManifest,
  requireDisposableAcceptanceDatabase,
  type BaseAcceptanceFixture,
  type CoursePublishAcceptanceManifest,
} from '../modules/course-authoring/course-publish-governance-acceptance.logic.js';

const { Pool } = pg;
const pause = (milliseconds: number) => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));

type Fixture = BaseAcceptanceFixture & {
  reviewerId?: string;
  assignmentId?: string;
  permissionGroupId?: string;
  mappingId?: string;
};

async function begin(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='20s'");
  await client.query("SET LOCAL lock_timeout='15s'");
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

function required(value: string | undefined, label: string): string {
  assert.ok(value, `${label} is required`);
  return value;
}

async function mutateDraft(client: PoolClient, fixture: Fixture): Promise<void> {
  const result = await client.query(
    `UPDATE public.course_blocks
       SET metadata=COALESCE(metadata,'{}'::jsonb)
         || jsonb_build_object('__course_publish_acceptance_marker',clock_timestamp()::text)
     WHERE id=$1 AND course_id=$2 AND deleted_at IS NULL`,
    [required(fixture.editBlockId, 'editBlockId'), fixture.courseId],
  );
  assert.equal(result.rowCount, 1, 'acceptance edit block is missing');
}

async function publishCandidate(client: PoolClient, fixture: Fixture): Promise<{ alreadyPublished: boolean }> {
  await begin(client);
  try {
    const started = await client.query<{ already_published: boolean }>(
      'SELECT * FROM public.begin_course_publish_candidate($1,$2,$3,$4,$5)',
      [fixture.candidateId, fixture.tenantId, fixture.courseId, fixture.targetBlockId, fixture.actorId],
    );
    const alreadyPublished = started.rows[0]?.already_published === true;
    if (!alreadyPublished) {
      const published = await client.query(
        `UPDATE public.course_blocks block
           SET is_published=true,published_data=block.data,published_metadata=block.metadata,
               has_draft_changes=false
          FROM public.course_publish_candidate_blocks snapshot
         WHERE snapshot.candidate_id=$1 AND snapshot.block_id=block.id
           AND snapshot.relation IN ('target','descendant') AND block.course_id=$2`,
        [fixture.candidateId, fixture.courseId],
      );
      assert.ok((published.rowCount ?? 0) > 0, 'candidate contains no publishable block');
      await client.query('SELECT public.finish_course_publish_candidate($1,$2)',
        [fixture.candidateId, fixture.actorId]);
    }
    await client.query('COMMIT');
    return { alreadyPublished };
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

function databaseCode(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown };
  return `${typeof candidate.code === 'string' ? `${candidate.code}:` : ''}${String(candidate.message ?? error)}`;
}

async function expectRejected(promise: Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await promise;
    assert.fail(`Expected rejection matching ${expected}`);
  } catch (error) {
    assert.match(databaseCode(error), expected);
  }
}

async function assertBlockedUntilRelease(
  operation: Promise<unknown>,
  release: () => Promise<void>,
): Promise<void> {
  let settled = false;
  void operation.finally(() => { settled = true; }).catch(() => undefined);
  await pause(150);
  assert.equal(settled, false, 'concurrent operation bypassed the required database lock');
  await release();
}

async function preflight(client: PoolClient, manifest: CoursePublishAcceptanceManifest): Promise<void> {
  const courseIds = Object.values(manifest.scenarios).map(fixture => fixture.courseId);
  const catalog = await client.query<{ function_count: string; table_count: string }>(
    `SELECT
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname IN ('begin_course_publish_candidate','finish_course_publish_candidate')) AS function_count,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname LIKE 'course_publish_%' AND c.relkind='r') AS table_count`,
  );
  assert.equal(Number(catalog.rows[0]?.function_count), 2, 'CP5 functions are not installed');
  assert.equal(Number(catalog.rows[0]?.table_count), 9, 'CP5 table set is incomplete');

  const fixtures = await client.query<{ id: string; display_name: string }>(
    `SELECT id,display_name FROM public.courses WHERE id=ANY($1::varchar[]) AND deleted_at IS NULL`,
    [courseIds],
  );
  assert.equal(fixtures.rows.length, courseIds.length, 'one or more disposable courses are missing');
  for (const course of fixtures.rows) {
    assert.match(course.display_name, /^\[COURSE_PUBLISH_ACCEPTANCE\]/,
      `course ${course.id} is missing the destructive acceptance display-name marker`);
  }

  for (const [scenario, fixture] of Object.entries(manifest.scenarios)) {
    if (!fixture.candidateId) continue;
    const candidate = await client.query(
      `SELECT 1 FROM public.course_publish_candidates
        WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND target_block_id=$4 AND status='open'`,
      [fixture.candidateId, fixture.tenantId, fixture.courseId, fixture.targetBlockId],
    );
    assert.equal(candidate.rowCount, 1, `${scenario} needs a fresh open candidate`);
  }
}

async function editVsApproval(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const editor = await pool.connect();
  try {
    await begin(editor);
    await mutateDraft(editor, fixture);
    const approval = pool.query(
      `INSERT INTO public.course_publish_approvals
        (candidate_id,tenant_id,course_id,reviewer_id,reviewer_role,assignment_id,candidate_hash,policy_version,reason)
       SELECT candidate.id,candidate.tenant_id,candidate.course_id,$2,reviewer.role::text,$3,
              candidate.candidate_hash,candidate.policy_version,'acceptance race approval'
         FROM public.course_publish_candidates candidate JOIN public.users reviewer ON reviewer.id=$2
        WHERE candidate.id=$1`,
      [fixture.candidateId, required(fixture.reviewerId, 'reviewerId'),
        required(fixture.assignmentId, 'assignmentId')],
    );
    await assertBlockedUntilRelease(approval, () => editor.query('COMMIT').then(() => undefined));
    await expectRejected(approval, /COURSE_PUBLISH_APPROVAL_FORBIDDEN|40001|42501/);
  } finally {
    await rollback(editor);
    editor.release();
  }
}

async function editVsPublish(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const editor = await pool.connect();
  const publisher = await pool.connect();
  try {
    await begin(editor);
    await mutateDraft(editor, fixture);
    const publication = publishCandidate(publisher, fixture);
    await assertBlockedUntilRelease(publication, () => editor.query('COMMIT').then(() => undefined));
    await expectRejected(publication, /COURSE_PUBLISH_CANDIDATE_STALE|40001/);
  } finally {
    await rollback(editor);
    await rollback(publisher);
    editor.release();
    publisher.release();
  }
}

async function permissionRevokeVsPublish(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const revoker = await pool.connect();
  const publisher = await pool.connect();
  try {
    await begin(revoker);
    const revoked = await revoker.query(
      `DELETE FROM public.user_permission_groups
        WHERE user_id=$1 AND permission_group_id=$2 AND tenant_id=$3`,
      [required(fixture.reviewerId, 'reviewerId'), required(fixture.permissionGroupId, 'permissionGroupId'),
        fixture.tenantId],
    );
    assert.equal(revoked.rowCount, 1, 'reviewer permission membership was not found');
    const publication = publishCandidate(publisher, fixture);
    await assertBlockedUntilRelease(publication, () => revoker.query('COMMIT').then(() => undefined));
    await expectRejected(publication, /COURSE_PUBLISH_APPROVAL_REQUIRED|COURSE_PUBLISH_FORBIDDEN|42501/);
  } finally {
    await rollback(revoker);
    await rollback(publisher);
    revoker.release();
    publisher.release();
  }
}

async function evidenceVsPublish(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const evidence = await pool.connect();
  const publisher = await pool.connect();
  try {
    await begin(evidence);
    // The CP5 fence takes the per-course lock before the pre-existing immutable
    // Apply-mapping guard rejects this illegal evidence rewrite. PostgreSQL keeps
    // the transaction-level lock until the aborted transaction is rolled back.
    await expectRejected(evidence.query(
      `UPDATE public.lesson_author_workspace_apply_mappings
          SET updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND course_id=$3`,
      [required(fixture.mappingId, 'mappingId'), fixture.tenantId, fixture.courseId],
    ), /Mapping identity\/order is immutable|23514/);
    const publication = publishCandidate(publisher, fixture);
    await assertBlockedUntilRelease(publication, () => rollback(evidence));
    await publication;
  } finally {
    await rollback(evidence);
    await rollback(publisher);
    evidence.release();
    publisher.release();
  }
}

async function staleCandidate(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const editor = await pool.connect();
  const publisher = await pool.connect();
  try {
    await begin(editor);
    await mutateDraft(editor, fixture);
    await editor.query('COMMIT');
    await expectRejected(publishCandidate(publisher, fixture), /COURSE_PUBLISH_CANDIDATE_STALE|40001/);
  } finally {
    await rollback(editor);
    await rollback(publisher);
    editor.release();
    publisher.release();
  }
}

async function idempotentReplay(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    assert.equal((await publishCandidate(first, fixture)).alreadyPublished, false);
    assert.equal((await publishCandidate(second, fixture)).alreadyPublished, true);
    const receipts = await pool.query<{ count: string }>(
      'SELECT count(*) FROM public.course_publish_receipts WHERE candidate_id=$1', [fixture.candidateId],
    );
    assert.equal(Number(receipts.rows[0]?.count), 1, 'idempotent replay created duplicate receipts');
  } finally {
    first.release();
    second.release();
  }
}

async function courseCascade(pool: InstanceType<typeof Pool>, fixture: Fixture): Promise<void> {
  const deleted = await pool.query('DELETE FROM public.courses WHERE id=$1 AND tenant_id=$2',
    [fixture.courseId, fixture.tenantId]);
  assert.equal(deleted.rowCount, 1, 'disposable cascade course was not deleted');
  const residue = await pool.query<{ residue: string }>(
    `SELECT
       (SELECT count(*) FROM public.course_publish_block_revisions WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_asset_revisions WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_policies WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_reviewer_assignments WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_candidates WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_candidate_blocks WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_candidate_assets WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_approvals WHERE course_id=$1)+
       (SELECT count(*) FROM public.course_publish_receipts WHERE course_id=$1) AS residue`,
    [fixture.courseId],
  );
  assert.equal(Number(residue.rows[0]?.residue), 0, 'course cascade left governance residue');
}

async function main(): Promise<void> {
  const connectionString = requireDisposableAcceptanceDatabase(process.env);
  const manifestPath = process.env.COURSE_PUBLISH_ACCEPTANCE_FIXTURE_PATH?.trim();
  if (!manifestPath) throw new Error('COURSE_PUBLISH_ACCEPTANCE_FIXTURE_PATH is required.');
  const manifest = readCoursePublishAcceptanceManifest(resolve(manifestPath));
  const pool = new Pool({ connectionString, max: 8, application_name: 'course-publish-acceptance' });
  try {
    const client = await pool.connect();
    try { await preflight(client, manifest); } finally { client.release(); }

    await editVsApproval(pool, manifest.scenarios.editVsApproval);
    await editVsPublish(pool, manifest.scenarios.editVsPublish);
    await permissionRevokeVsPublish(pool, manifest.scenarios.permissionRevokeVsPublish);
    await evidenceVsPublish(pool, manifest.scenarios.evidenceVsPublish);
    await staleCandidate(pool, manifest.scenarios.staleCandidate);
    await idempotentReplay(pool, manifest.scenarios.idempotentReplay);
    await courseCascade(pool, manifest.scenarios.courseCascade);
    process.stdout.write('COURSE_PUBLISH_ACCEPTANCE_PASS scenarios=7\n');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`COURSE_PUBLISH_ACCEPTANCE_FAIL ${databaseCode(error)}\n`);
  process.exitCode = 1;
});
