// ═══════════════════════════════════════════════════════════════
// Tenant data quota derived ownership backfill — manual operational job.
// Run only after the companion manual SQL remediation has completed Phase A
// and its concurrent tenant_id indexes have been created.
// ═══════════════════════════════════════════════════════════════

import { query } from '../config/database.js';

// Parents that also derive tenant_id always appear before their children.
const DERIVED_RELATIONS = [
  'public.course_blocks',
  'public.course_category_courses',
  'public.course_modal_configs',
  'public.course_modal_states',
  'public.course_progress',
  'public.help_pages',
  'public.kb_google_store',
  'public.notification_recipients',
  'public.permission_group_modules',
  'public.refresh_tokens',
  'public.section_modal_configs',
  'public.section_modal_shown',
  'public.sub_groups',
  'public.bot_personas',
  'public.chat_messages',
  'public.user_badges',
  'public.user_permission_groups',
  'public.block_completions',
  'public.kb_doc_gemini_mapping',
  'public.teams',
  'public.team_course_categories',
  'public.team_courses',
  'public.team_doc_categories',
  'public.team_members',
] as const;

const DEFAULT_BATCH_SIZE = 1_000;
const MAX_BATCH_SIZE = 10_000;

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseBatchSize(value: string | undefined): number {
  if (!value) return DEFAULT_BATCH_SIZE;
  if (!/^\d+$/.test(value)) throw new Error('--batch-size phải là số nguyên dương.');
  const batchSize = Number(value);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size phải nằm trong khoảng 1 đến ${MAX_BATCH_SIZE}.`);
  }
  return batchSize;
}

async function backfillRelation(relationName: string, batchSize: number): Promise<void> {
  let total = 0;
  while (true) {
    const result = await query<{ updated: number }>(
      'SELECT public.tenant_data_quota_backfill_derived_tenant_id_batch($1::regclass, $2::integer) AS updated',
      [relationName, batchSize],
    );
    const updated = Number(result.rows[0]?.updated ?? 0);
    total += updated;
    if (updated === 0) break;
  }
  console.log(`[tenant-data-quota] ${relationName}: đã xác định ownership cho ${total} bản ghi.`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm-manual-backfill')) {
    throw new Error(
      'Lệnh này thay đổi dữ liệu. Chỉ vận hành viên được phép chạy trong cửa sổ bảo trì với cờ --confirm-manual-backfill.',
    );
  }

  const batchSize = parseBatchSize(getArgument('--batch-size'));
  for (const relationName of DERIVED_RELATIONS) {
    await backfillRelation(relationName, batchSize);
  }

  if (process.argv.includes('--finalize')) {
    await query('SELECT public.tenant_data_quota_finalize_derived_ownership()');
    const wakeFunction = await query<{ ready: boolean }>(
      `SELECT to_regprocedure(
         'public.tenant_data_quota_wake_reconciliations_after_ownership_finalization()'
       ) IS NOT NULL AS ready`,
    );
    if (wakeFunction.rows[0]?.ready) {
      const result = await query<{ woken: number }>(
        `SELECT public.tenant_data_quota_wake_reconciliations_after_ownership_finalization() AS woken`,
      );
      console.log(`[tenant-data-quota] Đã đánh thức ${result.rows[0]?.woken ?? 0} lượt đồng bộ bị tạm dừng.`);
    }
    console.log('[tenant-data-quota] Ownership đã hoàn tất. Worker sẽ tự đồng bộ lại từng doanh nghiệp.');
  } else {
    console.log('[tenant-data-quota] Backfill xong. Kiểm tra các truy vấn verification của SQL trước khi chạy lại với --finalize.');
  }
}

main().catch((error) => {
  console.error('[tenant-data-quota] ownership backfill thất bại:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
