// ═══════════════════════════════════════════════════════════════
// Report admission: how much report work this process runs at once
//
// - Aggregates (a report page read that misses the cache, one report chat
//   turn): per tenant and in total. One over a limit waits a short, bounded
//   time for a slot, then is refused with 429 REPORTS_BUSY.
// - Excel exports: per user, per tenant and in total, refused at once.
// The limits are per API process (like AI chat admission); with several
// processes the totals add up. They protect the reports pool
// (config/reports-database.ts) and keep one tenant from taking all of it.
// ═══════════════════════════════════════════════════════════════

export const REPORTS_BUSY_CODE = 'REPORTS_BUSY';
export const REPORT_EXPORT_IN_PROGRESS_CODE = 'REPORT_EXPORT_IN_PROGRESS';
export const REPORT_EXPORT_BUSY_CODE = 'REPORT_EXPORT_BUSY';

/** Seconds the client is asked to wait before trying again (Retry-After). */
export const REPORTS_BUSY_RETRY_AFTER_SECONDS = 5;
export const REPORT_EXPORT_BUSY_RETRY_AFTER_SECONDS = 30;

/** [HTTP status, Vietnamese, English]. */
export const REPORTS_BUSY_ERROR = [
  429,
  'Báo cáo đang được nhiều người xem cùng lúc, vui lòng thử lại sau ít giây.',
  'Many people are viewing reports right now. Please try again in a few seconds.',
] as const;

export const REPORT_EXPORT_IN_PROGRESS_ERROR = [
  429,
  'Bạn đang xuất một file báo cáo khác. Vui lòng đợi file đó tải xong rồi thử lại.',
  'You are already exporting another report file. Please wait until it has downloaded, then try again.',
] as const;

export const REPORT_EXPORT_BUSY_ERROR = [
  429,
  'Đang có nhiều file báo cáo được xuất cùng lúc. Vui lòng thử lại sau ít phút.',
  'Several report files are being exported right now. Please try again in a few minutes.',
] as const;

/** Thrown when a report aggregate found no free slot in time. */
export class ReportsBusyError extends Error {
  readonly code = REPORTS_BUSY_CODE;

  constructor() {
    super('Report aggregate refused: too many report aggregates are running');
    this.name = 'ReportsBusyError';
  }
}

export function isReportsBusyError(error: unknown): error is ReportsBusyError {
  return error instanceof ReportsBusyError;
}

export interface WaitingConcurrencyGate {
  /**
   * A release function once a slot is free (at once, or within `maxWaitMs`),
   * else null. Releasing twice is harmless.
   */
  acquire(key: string, maxWaitMs: number): Promise<(() => void) | null>;
  active(key?: string): number;
  waiting(): number;
}

interface Waiter {
  key: string;
  grant: (release: () => void) => void;
}

/**
 * Per-key and total limits with a FIFO wait list. A freed slot goes to the
 * oldest waiter that fits; after every release no waiting request fits, so a
 * new request that fits at once never overtakes one that could have run.
 */
export function createWaitingConcurrencyGate(limits: { perKey: number; total: number }): WaitingConcurrencyGate {
  const perKey = new Map<string, number>();
  const waiters: Waiter[] = [];
  let total = 0;

  const fits = (key: string) => total < limits.total && (perKey.get(key) ?? 0) < limits.perKey;

  const take = (key: string): (() => void) => {
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
    total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      total -= 1;
      const left = (perKey.get(key) ?? 1) - 1;
      if (left > 0) perKey.set(key, left); else perKey.delete(key);
      grantWaiters();
    };
  };

  function grantWaiters(): void {
    for (let index = 0; index < waiters.length && total < limits.total;) {
      const waiter = waiters[index];
      if (!fits(waiter.key)) {
        index += 1;
        continue;
      }
      waiters.splice(index, 1);
      waiter.grant(take(waiter.key));
    }
  }

  return {
    acquire(key, maxWaitMs) {
      if (fits(key)) return Promise.resolve(take(key));
      if (maxWaitMs <= 0) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter: Waiter = {
          key,
          grant: (release) => {
            clearTimeout(timer);
            resolve(release);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, maxWaitMs);
        waiters.push(waiter);
      });
    },
    active(key) {
      return key === undefined ? total : perKey.get(key) ?? 0;
    },
    waiting() {
      return waiters.length;
    },
  };
}
