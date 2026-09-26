import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import { createChapterCheckpointRepository } from './lesson-author-chapter-checkpoint.repository.js';
import { releaseTenantAiTokenReservation } from './ai-token-quota.service.js';

export const chapterCheckpointRepository = createChapterCheckpointRepository({transaction:withDatabaseTransaction});
export const logChapterCheckpoint = (event: Record<string,unknown>) => console.info('[LessonAuthorChapter]',JSON.stringify(event));
let ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = true;
let active: Promise<void> | undefined;
export function assertChapterCheckpointReady() {
  if (!env.LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED || !ready) {
    throw new AppError('Chức năng tiếp tục chương chưa sẵn sàng.',503,'CHAPTER_CHECKPOINT_UNAVAILABLE');
  }
}

/** SELECT only: installed schema is a prerequisite, never auto-migrated. */
export async function verifyChapterCheckpointSchema() {
  const result = await query<{name:string; rls:boolean; browser_access:boolean; can_write:boolean; triggers:number; policies:number}>(`
    SELECT c.relname AS name,c.relrowsecurity AS rls,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS browser_access,
      has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND
      has_table_privilege(current_user,c.oid,'UPDATE') AND has_table_privilege(current_user,c.oid,'DELETE') AND
      (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR
       (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user)) AS can_write,
      (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')) AS triggers,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND
      c.relname IN ('lesson_author_chapter_drafts','lesson_author_chapter_attempts','lesson_author_chapter_units')`);
  if (result.rows.length !== 3 || result.rows.some(r=>!r.rls || r.browser_access || !r.can_write || r.policies)
    || result.rows.reduce((n,r)=>n+r.triggers,0)!==17 || env.AI_TOKEN_RESERVATION_SECONDS<600) {
    throw new AppError('Chapter checkpoint schema is not ready.',503,'CHAPTER_CHECKPOINT_SCHEMA_INVALID');
  }
  const expected:Record<string,string>={guard_lesson_author_chapter_draft:'0f37e2654c7de6d98e73db91d62cf2ed',
    guard_lesson_author_chapter_attempt:'021fd62f7a4468d045a8b602e0318aaf',guard_lesson_author_chapter_unit:'58a9367dd10beee849fa807f86c22119',
    assert_lesson_author_chapter_publication:'4c85f460d5145eaa28b4db1935c16e4b'};
  const guards=await query<{name:string;hash:string;definer:boolean}>(`SELECT p.proname AS name,
    md5(btrim(replace(p.prosrc,chr(13),''),E' \\n\\t')) AS hash,p.prosecdef AS definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.pronargs=0
    AND p.proname=ANY($1::text[])`,[Object.keys(expected)]);
  if(guards.rows.length!==4 || guards.rows.some(g=>g.definer || expected[g.name]!==g.hash)) {
    throw new AppError('Chapter checkpoint guards do not match the installed contract.',503,'CHAPTER_CHECKPOINT_SCHEMA_INVALID');
  }
}

/** Only expires abandoned leases and retention. NEVER dispatches/retries paid work. */
async function maintainChapterCheckpoints() {
  const expired = await query<{draft_id:string; id:string; tenant_id:string; course_id:string;
    conversation_id:string; requested_by:string; lease_token:string; correlation_id:string; dispatch_started_at:Date|null}>(`
    SELECT a.id,a.draft_id,a.tenant_id,a.course_id,a.lease_token,a.correlation_id,a.dispatch_started_at,
      d.conversation_id,d.requested_by FROM lesson_author_chapter_attempts a JOIN lesson_author_chapter_drafts d ON d.id=a.draft_id
    WHERE a.status='running' AND (a.lease_expires_at<=clock_timestamp() OR a.deadline_at<=clock_timestamp())
    ORDER BY a.lease_expires_at LIMIT 8`);
  for (const row of expired.rows) {
    try {
      await chapterCheckpointRepository.interrupt({draftId:row.draft_id,attemptId:row.id,tenantId:row.tenant_id,
        courseId:row.course_id,conversationId:row.conversation_id,userId:row.requested_by,leaseToken:row.lease_token},
      row.dispatch_started_at ? 'outcome_unknown':'timed_out',
      {stage:'chapter_lease_recovery',internalCode:'CHAPTER_ATTEMPT_LEASE_EXPIRED',externalCode:'PROVIDER_ERROR'},
      async (_tx,attempt,hold) => {
        if (hold) return 'pending_reconciliation';
        await releaseTenantAiTokenReservation(String(attempt.ai_reservation_id),row.tenant_id);
        return 'settled';
      });
      logChapterCheckpoint({event:'chapter_attempt_recovered',correlation_id:row.correlation_id,draft_id:row.draft_id,
        attempt_id:row.id,usage_source:'unavailable',automatic_retry:false});
    } catch { /* Another owner may have renewed/finalized; DB guard remains authoritative. */ }
  }
  await withDatabaseTransaction(async () => {
    // Bounded parent-only retention; independent reservation holds are NOT released.
    await query(`DELETE FROM lesson_author_chapter_drafts WHERE id IN (
      SELECT d.id FROM lesson_author_chapter_drafts d WHERE d.expires_at<=clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM lesson_author_chapter_attempts a WHERE a.draft_id=d.id AND a.status='running')
      ORDER BY d.expires_at LIMIT 8 FOR UPDATE SKIP LOCKED)`);
  });
}
export async function startChapterCheckpointMaintenance() {
  if (!env.LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED || !stopped) return;
  await verifyChapterCheckpointSchema();
  stopped=false; ready=true;
  const tick = () => {
    if (stopped) return;
    active = maintainChapterCheckpoints().catch(() => logChapterCheckpoint({event:'chapter_maintenance_failed',
      internal_failure_code:'CHAPTER_MAINTENANCE_UNAVAILABLE'})).finally(()=>{
      active=undefined;
      if (!stopped) { timer=setTimeout(tick,15_000); timer.unref(); }
    });
  };
  tick();
  logChapterCheckpoint({event:'chapter_checkpoint_ready',checkpoint_version:1});
}
export async function stopChapterCheckpointMaintenance() {
  stopped=true; ready=false;
  if (timer) clearTimeout(timer);
  await active;
}
