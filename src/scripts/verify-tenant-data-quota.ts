// ═══════════════════════════════════════════════════════════════
// Tenant data quota health verification — read-only operator check.
//
// `fast` is safe for frequent monitoring: it never aggregates storage.objects.
// `full-parity` is a maintenance-window command because it reads every object
// in landa-storage to compare the provider catalog with the local ledger.
// ═══════════════════════════════════════════════════════════════

import { pool, query } from '../config/database.js';

type Mode = 'fast' | 'full-parity';
type HealthStatus = 'ready' | 'degraded' | 'blocked';

type Options = {
  mode: Mode;
  json: boolean;
  requireWorkerHeartbeat: boolean;
  maxWorkerHeartbeatAgeSeconds: number;
  maxRetryAttempts: number;
};

type SchemaRow = {
  usage_ready: boolean;
  specs_ready: boolean;
  manifest_ready: boolean;
  registry_ready: boolean;
  runs_ready: boolean;
  storage_ledger_ready: boolean;
  worker_heartbeat_ready: boolean;
  reconciliation_queue_ready: boolean;
};

type CoverageRow = {
  direct_relations: string;
  fully_protected_relations: string;
  missing_trigger_relations: string;
  unclassified_relations: string;
  inactive_ownership_specs: string;
};

type StateRow = {
  state: string;
  tenants: string;
  verified_tenants: string;
};

type RunRow = {
  status: string;
  tenants: string;
  max_attempt_count: string;
  earliest_next_attempt: Date | null;
  active_claims: string;
};

type ReservationRow = {
  expired_active_reservations: string;
  reconciliation_required_reservations: string;
};

type StorageLedgerRow = {
  objects: string;
  bytes: string;
};

type ReconciliationQueueRow = {
  due_tenants: string;
  oldest_due_at: Date | null;
};

type WorkerHeartbeatRow = {
  active_workers: string;
  latest_heartbeat_at: Date | null;
  latest_state: string | null;
  latest_error: string | null;
};

type FullParityRow = {
  tenant_name: string;
  actual_objects: string;
  ledger_objects: string;
  actual_bytes: string;
  ledger_bytes: string;
  invalid_size_objects: string;
};

type StorageClassificationRow = {
  platform_objects: string;
  platform_bytes: string;
  unclassified_objects: string;
  unclassified_bytes: string;
};

type HealthReport = {
  status: HealthStatus;
  mode: Mode;
  generatedAt: string;
  summary: {
    tenants: number;
    enforcedTenants: number;
    verifiedTenants: number;
    storageLedgerObjects: string;
    storageLedgerBytes: string;
  };
  coverage: CoverageRow;
  reconciliation: {
    runs: RunRow[];
    expiredActiveReservations: string;
    reconciliationRequiredReservations: string;
    queueReady: boolean;
    dueTenants: string | null;
    oldestDueAt: string | null;
    activeClaims: string;
  };
  worker: {
    required: boolean;
    schemaReady: boolean;
    activeWorkers: string | null;
    latestHeartbeatAt: string | null;
    latestState: string | null;
  };
  fullParity?: {
    mismatchedTenants: FullParityRow[];
    platformObjects: string;
    platformBytes: string;
    unclassifiedObjects: string;
    unclassifiedBytes: string;
  };
  blockers: string[];
  warnings: string[];
  information: string[];
};

function usage(): never {
  throw new Error('Cách dùng: verify:tenant-data-quota [--mode=fast|full-parity] [--json] [--require-worker-heartbeat] [--max-worker-heartbeat-age-seconds=180] [--max-retry-attempts=3]');
}

function parseBoundedInteger(raw: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} phải là số nguyên.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} phải nằm trong khoảng ${minimum}-${maximum}.`);
  }
  return parsed;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    mode: 'fast',
    json: false,
    requireWorkerHeartbeat: false,
    maxWorkerHeartbeatAgeSeconds: 180,
    maxRetryAttempts: 3,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[index + 1];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--require-worker-heartbeat') {
      options.requireWorkerHeartbeat = true;
    } else if (argument === '--mode' || argument.startsWith('--mode=')) {
      if (value !== 'fast' && value !== 'full-parity') usage();
      options.mode = value;
      if (argument === '--mode') index += 1;
    } else if (argument === '--max-worker-heartbeat-age-seconds' || argument.startsWith('--max-worker-heartbeat-age-seconds=')) {
      options.maxWorkerHeartbeatAgeSeconds = parseBoundedInteger(value, 'Tuổi heartbeat tối đa', 30, 3_600);
      if (argument === '--max-worker-heartbeat-age-seconds') index += 1;
    } else if (argument === '--max-retry-attempts' || argument.startsWith('--max-retry-attempts=')) {
      options.maxRetryAttempts = parseBoundedInteger(value, 'Số lần thử lại tối đa', 1, 100);
      if (argument === '--max-retry-attempts') index += 1;
    } else {
      usage();
    }
  }

  return options;
}

function asCount(value: string | undefined): number {
  const parsed = Number(value || '0');
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function asTimestamp(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function exitCodeFor(status: HealthStatus): number {
  if (status === 'ready') return 0;
  return status === 'blocked' ? 2 : 3;
}

function printText(report: HealthReport): void {
  console.log(`[tenant-data-quota] ${report.status.toUpperCase()}: tenants enforced=${report.summary.enforcedTenants}/${report.summary.tenants}, verified=${report.summary.verifiedTenants}.`);
  console.log(`[tenant-data-quota] Storage ledger: ${report.summary.storageLedgerObjects} tệp, ${report.summary.storageLedgerBytes} bytes.`);
  console.log(`[tenant-data-quota] Coverage: direct=${report.coverage.direct_relations}, protected=${report.coverage.fully_protected_relations}, missing-triggers=${report.coverage.missing_trigger_relations}, unclassified=${report.coverage.unclassified_relations}, inactive-specs=${report.coverage.inactive_ownership_specs}.`);
  console.log(`[tenant-data-quota] Reconciliation queue: ${report.reconciliation.queueReady ? `due=${report.reconciliation.dueTenants ?? '0'}, active-claims=${report.reconciliation.activeClaims}, oldest=${report.reconciliation.oldestDueAt ?? '—'}` : 'chưa có SQL queue/finalization fence'}.`);
  console.log(`[tenant-data-quota] Worker heartbeat: ${report.worker.schemaReady ? `${report.worker.latestState ?? 'chưa có'} @ ${report.worker.latestHeartbeatAt ?? '—'}` : 'chưa có SQL heartbeat'}.`);
  for (const message of report.blockers) console.error(`[tenant-data-quota] BỊ CHẶN: ${message}`);
  for (const message of report.warnings) console.warn(`[tenant-data-quota] CẢNH BÁO: ${message}`);
  for (const message of report.information) console.log(`[tenant-data-quota] THÔNG TIN: ${message}`);
}

async function loadFullParity(): Promise<{ mismatchedTenants: FullParityRow[]; classification: StorageClassificationRow }> {
  const [mismatches, classification] = await Promise.all([
    query<FullParityRow>(
      `WITH actual AS (
         SELECT tenant.id AS tenant_id,
                COUNT(object.name)::bigint AS actual_objects,
                COALESCE(SUM(
                  CASE WHEN object.metadata ->> 'size' ~ '^[0-9]+$'
                    THEN (object.metadata ->> 'size')::numeric
                    ELSE 0
                  END
                ), 0)::bigint AS actual_bytes,
                COUNT(*) FILTER (WHERE object.name IS NOT NULL AND (object.metadata ->> 'size' !~ '^[0-9]+$' OR object.metadata ->> 'size' IS NULL))::bigint AS invalid_size_objects
         FROM public.tenants tenant
         LEFT JOIN storage.objects object
           ON object.bucket_id = 'landa-storage'
          AND object.name LIKE tenant.id::text || '/%'
         GROUP BY tenant.id
       ), ledger AS (
         SELECT tenant_id,
                COUNT(*)::bigint AS ledger_objects,
                COALESCE(SUM(size_bytes), 0)::bigint AS ledger_bytes
         FROM public.tenant_storage_quota_objects
         GROUP BY tenant_id
       )
       SELECT tenant.name AS tenant_name,
              actual.actual_objects::text,
              COALESCE(ledger.ledger_objects, 0)::text AS ledger_objects,
              actual.actual_bytes::text,
              COALESCE(ledger.ledger_bytes, 0)::text AS ledger_bytes,
              actual.invalid_size_objects::text
       FROM public.tenants tenant
       JOIN actual ON actual.tenant_id = tenant.id
       LEFT JOIN ledger ON ledger.tenant_id = tenant.id
       WHERE actual.actual_objects <> COALESCE(ledger.ledger_objects, 0)
          OR actual.actual_bytes <> COALESCE(ledger.ledger_bytes, 0)
          OR actual.invalid_size_objects <> 0
       ORDER BY tenant.name`,
    ),
    query<StorageClassificationRow>(
      `SELECT COUNT(*) FILTER (WHERE object.name LIKE 'system/prompt-mascots/%')::text AS platform_objects,
              COALESCE(SUM(CASE WHEN object.name LIKE 'system/prompt-mascots/%' AND object.metadata ->> 'size' ~ '^[0-9]+$'
                THEN (object.metadata ->> 'size')::numeric ELSE 0 END), 0)::bigint::text AS platform_bytes,
              COUNT(*) FILTER (WHERE object.name NOT LIKE 'system/prompt-mascots/%')::text AS unclassified_objects,
              COALESCE(SUM(CASE WHEN object.name NOT LIKE 'system/prompt-mascots/%' AND object.metadata ->> 'size' ~ '^[0-9]+$'
                THEN (object.metadata ->> 'size')::numeric ELSE 0 END), 0)::bigint::text AS unclassified_bytes
       FROM storage.objects object
       WHERE object.bucket_id = 'landa-storage'
         AND NOT EXISTS (
           SELECT 1
           FROM public.tenants tenant
           WHERE object.name LIKE tenant.id::text || '/%'
         )`,
    ),
  ]);

  return {
    mismatchedTenants: mismatches.rows,
    classification: classification.rows[0] || {
      platform_objects: '0',
      platform_bytes: '0',
      unclassified_objects: '0',
      unclassified_bytes: '0',
    },
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const availabilityResult = await query<SchemaRow>(
    `SELECT to_regclass('public.tenant_data_quota_usage') IS NOT NULL AS usage_ready,
            to_regclass('public.tenant_data_quota_derived_ownership_specs') IS NOT NULL AS specs_ready,
            to_regclass('public.tenant_data_quota_ownership_manifest') IS NOT NULL AS manifest_ready,
            to_regclass('public.tenant_data_quota_table_registry') IS NOT NULL AS registry_ready,
            to_regclass('public.tenant_data_quota_reconciliation_runs') IS NOT NULL AS runs_ready,
            to_regclass('public.tenant_storage_quota_objects') IS NOT NULL AS storage_ledger_ready,
            to_regclass('public.tenant_data_quota_worker_heartbeats') IS NOT NULL
              AND to_regprocedure('public.tenant_data_quota_record_worker_heartbeat(text,uuid,text,integer,integer,integer,integer,text)') IS NOT NULL
              AS worker_heartbeat_ready,
            to_regclass('public.tenant_data_quota_reconciliation_queue') IS NOT NULL
              AND to_regprocedure('public.tenant_data_quota_prepare_reconciliation_finalization(uuid,uuid,integer)') IS NOT NULL
              AND to_regprocedure('public.tenant_data_quota_finish_reconciliation(uuid,uuid,integer)') IS NOT NULL
              AS reconciliation_queue_ready`,
  );
  const availability = availabilityResult.rows[0];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const information: string[] = [];

  if (!availability || !availability.usage_ready || !availability.specs_ready || !availability.manifest_ready
    || !availability.registry_ready || !availability.runs_ready || !availability.storage_ledger_ready) {
    const report: HealthReport = {
      status: 'blocked',
      mode: options.mode,
      generatedAt: new Date().toISOString(),
      summary: { tenants: 0, enforcedTenants: 0, verifiedTenants: 0, storageLedgerObjects: '0', storageLedgerBytes: '0' },
      coverage: { direct_relations: '0', fully_protected_relations: '0', missing_trigger_relations: '0', unclassified_relations: '0', inactive_ownership_specs: '0' },
      reconciliation: {
        runs: [],
        expiredActiveReservations: '0',
        reconciliationRequiredReservations: '0',
        queueReady: false,
        dueTenants: null,
        oldestDueAt: null,
        activeClaims: '0',
      },
      worker: { required: options.requireWorkerHeartbeat, schemaReady: false, activeWorkers: null, latestHeartbeatAt: null, latestState: null },
      blockers: ['Thiếu bảng quota nền tảng. Không được tin số liệu hoặc bật enforcement mới.'],
      warnings,
      information,
    };
    options.json ? console.log(JSON.stringify(report)) : printText(report);
    process.exitCode = exitCodeFor(report.status);
    return;
  }

  const [coverageResult, statesResult, runsResult, reservationsResult, storageLedgerResult] = await Promise.all([
    query<CoverageRow>(
      `WITH direct_relations AS (
         SELECT relation_name::oid AS relation_oid
         FROM public.tenant_data_quota_table_registry
       ), trigger_counts AS (
         SELECT direct_relations.relation_oid,
                COUNT(trigger_row.oid) FILTER (
                  WHERE NOT trigger_row.tgisinternal
                    AND trigger_row.tgname IN ('tenant_data_quota_direct_insert', 'tenant_data_quota_direct_update', 'tenant_data_quota_direct_delete')
                )::integer AS quota_trigger_count
         FROM direct_relations
         LEFT JOIN pg_trigger trigger_row ON trigger_row.tgrelid = direct_relations.relation_oid
         GROUP BY direct_relations.relation_oid
       )
       SELECT (SELECT COUNT(*)::text FROM direct_relations) AS direct_relations,
              (SELECT COUNT(*)::text FROM trigger_counts WHERE quota_trigger_count = 3) AS fully_protected_relations,
              (SELECT COUNT(*)::text FROM trigger_counts WHERE quota_trigger_count <> 3) AS missing_trigger_relations,
              (SELECT COUNT(*)::text FROM public.tenant_data_quota_ownership_manifest WHERE classification = 'unclassified') AS unclassified_relations,
              (SELECT COUNT(*)::text FROM public.tenant_data_quota_derived_ownership_specs WHERE NOT is_active) AS inactive_ownership_specs`,
    ),
    query<StateRow>(
      `SELECT COALESCE(usage.state, 'initializing') AS state,
              COUNT(*)::text AS tenants,
              COUNT(usage.last_verified_at)::text AS verified_tenants
       FROM public.tenants tenant
       LEFT JOIN public.tenant_data_quota_usage usage ON usage.tenant_id = tenant.id
       GROUP BY COALESCE(usage.state, 'initializing')
       ORDER BY state`,
    ),
    query<RunRow>(
      `SELECT status, COUNT(*)::text AS tenants, MAX(attempt_count)::text AS max_attempt_count,
              MIN(next_attempt_at) AS earliest_next_attempt,
              COUNT(*) FILTER (
                WHERE claim_token IS NOT NULL
                  AND lease_expires_at > clock_timestamp()
              )::text AS active_claims
       FROM public.tenant_data_quota_reconciliation_runs
       GROUP BY status
       ORDER BY status`,
    ),
    query<ReservationRow>(
      `SELECT COUNT(*) FILTER (
                WHERE status IN ('pending', 'reconcile_required')
                  AND expires_at <= clock_timestamp()
              )::text AS expired_active_reservations,
              COUNT(*) FILTER (WHERE status = 'reconcile_required')::text AS reconciliation_required_reservations
       FROM public.tenant_storage_quota_reservations`,
    ),
    query<StorageLedgerRow>(
      `SELECT COUNT(*)::text AS objects, COALESCE(SUM(size_bytes), 0)::text AS bytes
       FROM public.tenant_storage_quota_objects`,
    ),
  ]);

  const coverage = coverageResult.rows[0];
  const states = statesResult.rows;
  const runs = runsResult.rows;
  const reservations = reservationsResult.rows[0] || { expired_active_reservations: '0', reconciliation_required_reservations: '0' };
  const storageLedger = storageLedgerResult.rows[0] || { objects: '0', bytes: '0' };
  let reconciliationQueue: ReconciliationQueueRow | null = null;
  if (availability.reconciliation_queue_ready) {
    const queueResult = await query<ReconciliationQueueRow>(
      `SELECT COUNT(*) FILTER (WHERE due_at <= clock_timestamp())::text AS due_tenants,
              MIN(due_at) FILTER (WHERE due_at <= clock_timestamp()) AS oldest_due_at
       FROM public.tenant_data_quota_reconciliation_queue`,
    );
    reconciliationQueue = queueResult.rows[0] || { due_tenants: '0', oldest_due_at: null };
  }
  const totalTenants = states.reduce((total, row) => total + asCount(row.tenants), 0);
  const enforcedTenants = states.filter((row) => row.state === 'enforced').reduce((total, row) => total + asCount(row.tenants), 0);
  const verifiedTenants = states.reduce((total, row) => total + asCount(row.verified_tenants), 0);
  const activeClaims = runs.reduce((total, run) => total + asCount(run.active_claims), 0).toString();

  if (!coverage || asCount(coverage.missing_trigger_relations) > 0 || asCount(coverage.unclassified_relations) > 0 || asCount(coverage.inactive_ownership_specs) > 0) {
    blockers.push('Ownership hoặc trigger quota chưa bao phủ toàn bộ bảng tenant.');
  }
  if (totalTenants !== enforcedTenants || totalTenants !== verifiedTenants) {
    warnings.push('Có tenant chưa ở trạng thái enforced với snapshot đã xác nhận; các ghi tăng dữ liệu của tenant đó phải tiếp tục fail-close.');
  }
  if (runs.some((run) => run.status === 'failed')) {
    warnings.push('Có reconciliation đang thất bại và chờ thử lại.');
  }
  if (runs.some((run) => run.status !== 'succeeded' && asCount(run.max_attempt_count) > options.maxRetryAttempts)) {
    warnings.push(`Có reconciliation vượt ngưỡng ${options.maxRetryAttempts} lần thử lại.`);
  }
  if (asCount(reservations.expired_active_reservations) > 0) {
    warnings.push('Có reservation Storage hết hạn chưa được reconciliation xử lý.');
  }
  if (asCount(reservations.reconciliation_required_reservations) > 0) {
    warnings.push('Có mutation Storage có kết quả mơ hồ, đang cần reconciliation.');
  }
  if (!availability.reconciliation_queue_ready) {
    blockers.push('Chưa có SQL queue và finalization fence cho quota worker; worker mới sẽ không được phép quét.');
  } else if (asCount(reconciliationQueue?.due_tenants) > 0) {
    warnings.push('Có tenant đang chờ worker reconciliation xử lý trong queue.');
  }

  let worker: HealthReport['worker'] = {
    required: options.requireWorkerHeartbeat,
    schemaReady: availability.worker_heartbeat_ready,
    activeWorkers: null,
    latestHeartbeatAt: null,
    latestState: null,
  };
  if (!availability.worker_heartbeat_ready) {
    const message = 'Chưa có heartbeat SQL cho worker; quota vẫn hoạt động nhưng chưa thể giám sát worker khi không có tenant cần quét.';
    if (options.requireWorkerHeartbeat) blockers.push(message);
    else information.push(message);
  } else {
    const heartbeatResult = await query<WorkerHeartbeatRow>(
      `SELECT COUNT(*) FILTER (
                WHERE state IN ('starting', 'idle', 'reconciling')
                  AND last_heartbeat_at >= clock_timestamp() - ($1::integer * interval '1 second')
              )::text AS active_workers,
              MAX(last_heartbeat_at) AS latest_heartbeat_at,
              (ARRAY_AGG(state ORDER BY last_heartbeat_at DESC))[1] AS latest_state,
              (ARRAY_AGG(last_error ORDER BY last_heartbeat_at DESC))[1] AS latest_error
       FROM public.tenant_data_quota_worker_heartbeats
       WHERE worker_name = 'landa-tenant-data-quota-worker'`,
      [options.maxWorkerHeartbeatAgeSeconds],
    );
    const heartbeat = heartbeatResult.rows[0];
    worker = {
      required: options.requireWorkerHeartbeat,
      schemaReady: true,
      activeWorkers: heartbeat?.active_workers || '0',
      latestHeartbeatAt: asTimestamp(heartbeat?.latest_heartbeat_at),
      latestState: heartbeat?.latest_state || null,
    };
    if (asCount(worker.activeWorkers ?? '0') === 0) {
      const message = `Không có worker quota active có heartbeat mới trong ${options.maxWorkerHeartbeatAgeSeconds} giây.`;
      if (options.requireWorkerHeartbeat) blockers.push(message);
      else warnings.push(message);
    }
    if (heartbeat?.latest_state === 'failed') warnings.push('Worker quota gần nhất báo trạng thái failed.');
    if (heartbeat?.latest_error) information.push('Worker có lưu lỗi gần nhất; xem dữ liệu heartbeat để chẩn đoán, không hiển thị lỗi nhạy cảm trong UI.');
  }

  let fullParity: HealthReport['fullParity'];
  if (options.mode === 'full-parity') {
    const full = await loadFullParity();
    fullParity = {
      mismatchedTenants: full.mismatchedTenants,
      platformObjects: full.classification.platform_objects,
      platformBytes: full.classification.platform_bytes,
      unclassifiedObjects: full.classification.unclassified_objects,
      unclassifiedBytes: full.classification.unclassified_bytes,
    };
    if (full.mismatchedTenants.length > 0) blockers.push('Ledger Storage không khớp storage.objects cho ít nhất một tenant.');
    if (asCount(full.classification.unclassified_objects) > 0) {
      blockers.push('Có object Storage không thuộc tenant hoặc prefix platform đã được phê duyệt; không thể xác nhận quota đầy đủ.');
    }
    if (asCount(full.classification.platform_objects) > 0) {
      information.push('Object platform system/prompt-mascots được loại khỏi quota tenant theo thiết kế.');
    }
  }

  const status: HealthStatus = blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'degraded' : 'ready';
  const report: HealthReport = {
    status,
    mode: options.mode,
    generatedAt: new Date().toISOString(),
    summary: {
      tenants: totalTenants,
      enforcedTenants,
      verifiedTenants,
      storageLedgerObjects: storageLedger.objects,
      storageLedgerBytes: storageLedger.bytes,
    },
    coverage: coverage || { direct_relations: '0', fully_protected_relations: '0', missing_trigger_relations: '0', unclassified_relations: '0', inactive_ownership_specs: '0' },
    reconciliation: {
      runs,
      expiredActiveReservations: reservations.expired_active_reservations,
      reconciliationRequiredReservations: reservations.reconciliation_required_reservations,
      queueReady: availability.reconciliation_queue_ready,
      dueTenants: reconciliationQueue?.due_tenants ?? null,
      oldestDueAt: asTimestamp(reconciliationQueue?.oldest_due_at),
      activeClaims,
    },
    worker,
    ...(fullParity ? { fullParity } : {}),
    blockers,
    warnings,
    information,
  };

  options.json ? console.log(JSON.stringify(report)) : printText(report);
  process.exitCode = exitCodeFor(report.status);
}

main()
  .catch((error) => {
    console.error('[tenant-data-quota] Không thể kiểm tra:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
