// ═══════════════════════════════════════════════════════════════
// Email outbox repository: the claim of due jobs and of stale 'sending'
// leases, the recipient re-check before SMTP, the sent / retry / cooldown
// transitions, the sent retention and its session advisory lock. SQL only;
// moved unchanged from email-outbox.service.ts. The delivery service keeps
// the batching, retries, tenant circuit and SMTP sessions.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query(), a pool client or a session client. */
export interface EmailOutboxDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface ClaimedEmailOutboxJob {
  id: string;
  tenant_id: string;
  status: string;
  previous_status: string;
  recipient_user_id: string | null;
  recipient_email: string;
  subject: string;
  html_body: string;
  text_body: string;
  attempts: number;
  max_attempts: number;
}

export function createEmailOutboxRepository(db: EmailOutboxDb) {
  return {
    /** Due pending jobs and failed ones under max_attempts, whose recipient may still be mailed, set to 'sending'. */
    async claimRunnableJobs(client: EmailOutboxDb, limit: number, tenantId: string | undefined): Promise<ClaimedEmailOutboxJob[]> {
      const params: unknown[] = [limit];
      let tenantFilter = '';
      if (tenantId) {
        params.push(tenantId);
        tenantFilter = `AND tenant_id = $${params.length}::uuid`;
      }

      const runnable = await client.query<ClaimedEmailOutboxJob>(
        `WITH picked AS (
         SELECT id, status AS previous_status
         FROM email_outbox
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= now()
           AND (status = 'pending' OR attempts < max_attempts)
           AND (
             (requires_active_recipient = false AND recipient_user_id IS NULL)
             OR EXISTS (
               SELECT 1
               FROM users recipient
               WHERE recipient.id = email_outbox.recipient_user_id
                 AND recipient.deletion_requested_at IS NULL
                 AND recipient.is_active = true
             )
           )
           ${tenantFilter}
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_outbox eo
       SET status = 'sending',
           updated_at = now()
       FROM picked
       WHERE eo.id = picked.id
       RETURNING eo.id, eo.tenant_id, eo.status, picked.previous_status,
                 eo.recipient_user_id,
                 eo.recipient_email, eo.subject, eo.html_body, eo.text_body,
                 eo.attempts, eo.max_attempts`,
        params,
      );
      return runnable.rows;
    },

    /** 'sending' jobs not updated for staleMinutes (a worker died mid-send), claimed again. */
    async claimStaleSendingJobs(
      client: EmailOutboxDb,
      limit: number,
      staleMinutes: number,
      tenantId: string | undefined,
    ): Promise<QueryResult<ClaimedEmailOutboxJob>> {
      const staleParams: unknown[] = [limit, staleMinutes];
      let staleTenantFilter = '';
      if (tenantId) {
        staleParams.push(tenantId);
        staleTenantFilter = `AND tenant_id = $${staleParams.length}::uuid`;
      }

      return client.query<ClaimedEmailOutboxJob>(
        `WITH picked AS (
         SELECT id, status AS previous_status
         FROM email_outbox
         WHERE status = 'sending'
           AND updated_at < now() - (($2::int || ' minutes')::interval)
           AND (
             (requires_active_recipient = false AND recipient_user_id IS NULL)
             OR EXISTS (
               SELECT 1
               FROM users recipient
               WHERE recipient.id = email_outbox.recipient_user_id
                 AND recipient.deletion_requested_at IS NULL
                 AND recipient.is_active = true
             )
           )
           ${staleTenantFilter}
         ORDER BY updated_at ASC, created_at ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_outbox eo
       SET status = 'sending',
           updated_at = now()
       FROM picked
       WHERE eo.id = picked.id
       RETURNING eo.id, eo.tenant_id, eo.status, picked.previous_status,
                 eo.recipient_user_id,
                 eo.recipient_email, eo.subject, eo.html_body, eo.text_body,
                 eo.attempts, eo.max_attempts`,
        staleParams,
      );
    },

    async markJobSent(jobId: string): Promise<void> {
      await db.query(
        `UPDATE email_outbox
     SET status = 'sent',
         sent_at = now(),
         last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
        [jobId],
      );
    },

    /** attempts + 1 and the next attempt in attempts² minutes; status 'pending' or 'failed'. */
    async markJobRetry(jobId: string, nextStatus: string, lastError: string, nextAttempts: number): Promise<void> {
      await db.query(
        `UPDATE email_outbox
     SET status = $2,
         attempts = attempts + 1,
         last_error = $3,
         next_attempt_at = now() + ((($4::int * $4::int) || ' minutes')::interval),
         updated_at = now()
     WHERE id = $1`,
        [jobId, nextStatus, lastError, nextAttempts],
      );
    },

    /** Back to 'pending' until the tenant's SMTP cooldown ends (epoch milliseconds). */
    async releaseJobUntil(jobId: string, reason: string, untilMs: number): Promise<void> {
      await db.query(
        `UPDATE email_outbox
     SET status = 'pending',
         last_error = $2,
         next_attempt_at = to_timestamp($3::double precision / 1000.0),
         updated_at = now()
     WHERE id = $1`,
        [jobId, reason, untilMs],
      );
    },

    /** The claimed jobs whose recipient may still be mailed. */
    async selectDeliverableJobIds(jobIds: string[]): Promise<Array<{ id: string }>> {
      const result = await db.query<{ id: string }>(
        `SELECT eo.id
     FROM email_outbox eo
     LEFT JOIN users recipient ON recipient.id = eo.recipient_user_id
     WHERE eo.id = ANY($1::uuid[])
       AND eo.status = 'sending'
       AND (
         (eo.requires_active_recipient = false AND eo.recipient_user_id IS NULL)
         OR (recipient.id IS NOT NULL AND recipient.is_active = true AND recipient.deletion_requested_at IS NULL)
       )`,
        [jobIds],
      );
      return result.rows;
    },

    async deleteSendingJobs(jobIds: string[]): Promise<void> {
      await db.query(
        `DELETE FROM email_outbox
       WHERE id = ANY($1::uuid[]) AND status = 'sending'`,
        [jobIds],
      );
    },

    /** Deletes up to batchSize jobs sent more than retentionDays ago, oldest first; the count deleted. */
    async deleteSentBefore(retentionDays: number, batchSize: number): Promise<number> {
      const result = await db.query(
        `WITH doomed AS (
       SELECT id
       FROM email_outbox
       WHERE status = 'sent'
         AND sent_at < now() - (($1::int || ' days')::interval)
       ORDER BY sent_at ASC, id ASC
       LIMIT $2::int
     )
     DELETE FROM email_outbox eo
     USING doomed
     WHERE eo.id = doomed.id`,
        [retentionDays, batchSize],
      );
      return result.rowCount || 0;
    },

    /** Session advisory lock: the client must be a session client (getSessionClient). */
    async tryAdvisoryLock(sessionClient: EmailOutboxDb, key: string): Promise<boolean | undefined> {
      const lock = await sessionClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',
        [key],
      );
      return lock.rows[0]?.locked;
    },

    async advisoryUnlock(sessionClient: EmailOutboxDb, key: string): Promise<void> {
      await sessionClient.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [key]);
    },
  };
}

export type EmailOutboxRepository = ReturnType<typeof createEmailOutboxRepository>;
