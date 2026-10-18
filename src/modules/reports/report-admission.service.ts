// Process-wide report admission (limits in report-admission.logic.ts).

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../../config/env.js';
import { createConcurrencyGate } from '../ai-chatbot/ai-chat-admission.logic.js';
import { ReportsBusyError, createWaitingConcurrencyGate } from './report-admission.logic.js';

export type ReportExportSlot =
  | { release: () => void }
  | { refused: 'user' | 'busy' };

export interface ReportAdmissionLimits {
  tenantAggregates: number;
  totalAggregates: number;
  aggregateWaitMs: number;
  userExports: number;
  tenantExports: number;
  totalExports: number;
}

export interface ReportAdmission {
  /**
   * Runs one report aggregate (or a whole report chat turn) in a slot of its
   * tenant. Aggregates started inside take no further slot. Throws
   * ReportsBusyError when no slot frees up within the wait limit.
   */
  runReportAggregate<T>(tenantId: string, work: () => Promise<T>): Promise<T>;
  /** An export slot, or why there is none. Exports never wait. */
  tryAcquireReportExportSlot(actor: { tenantId: string; userId: string }): ReportExportSlot;
}

export function createReportAdmission(limits: ReportAdmissionLimits): ReportAdmission {
  const aggregateGate = createWaitingConcurrencyGate({ perKey: limits.tenantAggregates, total: limits.totalAggregates });
  const exportUserGate = createConcurrencyGate({ perKey: limits.userExports, total: Number.MAX_SAFE_INTEGER });
  const exportTenantGate = createConcurrencyGate({ perKey: limits.tenantExports, total: limits.totalExports });
  const heldSlot = new AsyncLocalStorage<true>();

  return {
    async runReportAggregate(tenantId, work) {
      if (heldSlot.getStore()) return work();
      const release = await aggregateGate.acquire(tenantId, limits.aggregateWaitMs);
      if (!release) {
        console.warn(JSON.stringify({
          event: 'reports_admission_refused',
          tenant_id: tenantId,
          tenant_active: aggregateGate.active(tenantId),
          total_active: aggregateGate.active(),
          waiting: aggregateGate.waiting(),
        }));
        throw new ReportsBusyError();
      }
      try {
        return await heldSlot.run(true, work);
      } finally {
        release();
      }
    },
    tryAcquireReportExportSlot(actor) {
      const releaseUser = exportUserGate.tryAcquire(actor.userId);
      if (!releaseUser) return { refused: 'user' };
      const releaseTenant = exportTenantGate.tryAcquire(actor.tenantId);
      if (!releaseTenant) {
        releaseUser();
        return { refused: 'busy' };
      }
      return {
        release: () => {
          releaseTenant();
          releaseUser();
        },
      };
    },
  };
}

const processAdmission = createReportAdmission({
  tenantAggregates: env.REPORTS_TENANT_CONCURRENCY,
  totalAggregates: env.REPORTS_GLOBAL_CONCURRENCY,
  aggregateWaitMs: env.REPORTS_ADMISSION_WAIT_MS,
  userExports: env.REPORTS_EXPORT_USER_CONCURRENCY,
  tenantExports: env.REPORTS_EXPORT_TENANT_CONCURRENCY,
  totalExports: env.REPORTS_EXPORT_GLOBAL_CONCURRENCY,
});

export const runReportAggregate: ReportAdmission['runReportAggregate'] = (tenantId, work) =>
  processAdmission.runReportAggregate(tenantId, work);

export const tryAcquireReportExportSlot: ReportAdmission['tryAcquireReportExportSlot'] = (actor) =>
  processAdmission.tryAcquireReportExportSlot(actor);
