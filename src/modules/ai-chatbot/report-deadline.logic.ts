// Hard deadline for calls a report request must never wait on indefinitely
// (Gemini, Redis). The work receives an AbortSignal that fires at the
// deadline, and the caller stops waiting then even if the work ignores it.

export class ReportDeadlineError extends Error {
  readonly code = 'REPORT_DEADLINE_EXCEEDED';

  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs} ms`);
    this.name = 'ReportDeadlineError';
  }
}

export async function withReportDeadline<T>(operation: string, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ReportDeadlineError(operation, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
