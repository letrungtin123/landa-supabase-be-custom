// SQL of the organization profile drafting worker (background process): claim one queued (or
// lease-expired) state row with FOR UPDATE SKIP LOCKED, and finish it under the same lease token.
// Lease and status updates keep the revision; a new AI draft bumps it with the current version.

import type { OrgContextDb } from './lesson-author-org-context.repository.js';
import { ORG_CONTEXT_DISTILL_MAX_ATTEMPTS } from './lesson-author-org-context.logic.js';

export interface OrgContextDistillClaim {
  tenant_id: string;
  locale: 'vi' | 'en';
  requested_by: string | null;
  attempts: number;
  lease_token: string;
}

/** Extra claim predicates (tenant fences) as a SQL fragment on `s.tenant_id` and its parameters. */
export interface OrgContextTenantFilter { clause: string; params: unknown[] }

export function createOrgContextDistillRepository(db: OrgContextDb) {
  return {
    /**
     * A running draft whose lease ran out after its last attempt fails for good (a process died twice
     * on it); earlier ones are claimed again below.
     */
    async failExhaustedLeases(): Promise<number> {
      const result = await db.query(`UPDATE lesson_author_org_context_states SET distill_status='failed',
          distill_error_code='ORG_CONTEXT_DISTILL_INTERRUPTED',distill_lease_token=NULL,distill_lease_until=NULL,
          distill_finished_at=now(),updated_at=now()
        WHERE distill_status='running' AND distill_lease_until<now() AND distill_attempts>=$1`,
      [ORG_CONTEXT_DISTILL_MAX_ATTEMPTS]);
      return result.rowCount ?? 0;
    },

    /** Claims one tenant's draft (oldest request first) and counts the attempt. */
    async claim(leaseToken: string, leaseMs: number, filter: (firstParameter: number) => OrgContextTenantFilter):
      Promise<OrgContextDistillClaim | null> {
      const fence = filter(3);
      const result = await db.query(`WITH candidate AS (
          SELECT s.tenant_id FROM lesson_author_org_context_states s
          WHERE (s.distill_status='queued' OR (s.distill_status='running' AND s.distill_lease_until<now()))${fence.clause}
          ORDER BY s.distill_requested_at NULLS FIRST,s.tenant_id
          LIMIT 1 FOR UPDATE OF s SKIP LOCKED)
        UPDATE lesson_author_org_context_states s SET distill_status='running',distill_lease_token=$1::uuid,
          distill_lease_until=now()+($2::integer*interval '1 millisecond'),distill_attempts=s.distill_attempts+1,
          updated_at=now()
        FROM candidate WHERE s.tenant_id=candidate.tenant_id
        RETURNING s.tenant_id::text AS tenant_id,s.distill_locale,s.distill_requested_by::text AS requested_by,
          s.distill_attempts`, [leaseToken, leaseMs, ...fence.params]);
      const row = result.rows[0];
      if (!row) return null;
      return { tenant_id: String(row.tenant_id), locale: row.distill_locale === 'en' ? 'en' : 'vi',
        requested_by: typeof row.requested_by === 'string' ? row.requested_by : null,
        attempts: Number(row.distill_attempts), lease_token: leaseToken };
    },

    /** Locks the state row while this lease still owns it (false: another process took it over). */
    async lockLease(tenantId: string, leaseToken: string): Promise<boolean> {
      const result = await db.query(`SELECT tenant_id FROM lesson_author_org_context_states
        WHERE tenant_id=$1 AND distill_status='running' AND distill_lease_token=$2::uuid FOR UPDATE`, [tenantId, leaseToken]);
      return result.rows.length === 1;
    },

    /** The AI draft became the current version: a change, so the revision moves. */
    async finishSucceeded(tenantId: string, leaseToken: string, currentVersion: number): Promise<boolean> {
      const result = await db.query(`UPDATE lesson_author_org_context_states SET revision=revision+1,current_version=$3,
          distill_status='idle',distill_lease_token=NULL,distill_lease_until=NULL,distill_error_code=NULL,
          distill_finished_at=now(),updated_by=distill_requested_by,updated_at=now()
        WHERE tenant_id=$1 AND distill_status='running' AND distill_lease_token=$2::uuid`,
      [tenantId, leaseToken, currentVersion]);
      return result.rowCount === 1;
    },

    /** A failed attempt: queued again (status only) or failed for good with its code. */
    async finishFailed(tenantId: string, leaseToken: string, status: 'queued' | 'failed', errorCode: string): Promise<boolean> {
      // $3 is read twice (column and comparison): one explicit type, or PostgreSQL refuses the statement (42P08).
      const result = await db.query(`UPDATE lesson_author_org_context_states SET distill_status=$3::varchar,distill_error_code=$4,
          distill_lease_token=NULL,distill_lease_until=NULL,
          distill_finished_at=CASE WHEN $3::varchar='failed' THEN now() ELSE distill_finished_at END,updated_at=now()
        WHERE tenant_id=$1 AND distill_status='running' AND distill_lease_token=$2::uuid`,
      [tenantId, leaseToken, status, errorCode]);
      return result.rowCount === 1;
    },
  };
}

export type OrgContextDistillRepository = ReturnType<typeof createOrgContextDistillRepository>;
