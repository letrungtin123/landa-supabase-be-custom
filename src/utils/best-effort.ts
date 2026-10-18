// ═══════════════════════════════════════════════════════════════
// Best-effort work — record a failure the caller deliberately ignores
// ═══════════════════════════════════════════════════════════════
//
// For work allowed to fail without failing the caller (storage cleanup,
// reservation release, job bookkeeping, startup maintenance). These helpers
// never change control flow: they only record that the work failed, as
//   [BestEffort] {"event":"best_effort_failed","tag":"...","error_kind":"..."}
// with a short tag and the kind of error. Never the message, a path, an id or
// any other data: those can carry personal data or tenant details (a JSON
// parse message, for one, quotes the request body it failed on).
//
// - bestEffort(tag, fn) / bestEffortSync(tag, fn): run the work, record a
//   failure, resolve (return) undefined instead of throwing. Use them in
//   place of an empty `catch {}` around work that may fail.
// - swallowAndLog(tag): the same for an existing `.catch(...)`.
// - logSwallowedError(tag, error): inside a catch block that does more.

const MAX_KIND_LENGTH = 80;

export interface SwallowOptions {
  /** A local temp file that is already gone (ENOENT) is not a failure: nothing is left behind. */
  ignoreMissingFile?: boolean;
}

/** The error's class name and, when present, its code (e.g. "Error:ENOENT", "DatabaseError:23505"). */
export function errorKind(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error !== 'object' && typeof error !== 'function') return typeof error;
  let name = 'object';
  let code: unknown;
  try {
    const candidate = (error as { name?: unknown }).name;
    if (typeof candidate === 'string' && candidate) name = candidate;
    else if (error instanceof Error) name = 'Error';
    code = (error as { code?: unknown }).code;
  } catch {
    // A throwing getter on a foreign error object: the generic kind is enough.
  }
  const kind = typeof code === 'string' || typeof code === 'number' ? `${name}:${code}` : name;
  return kind.replace(/[^\w.:-]/g, '_').slice(0, MAX_KIND_LENGTH);
}

function isMissingFile(error: unknown): boolean {
  try {
    return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
  } catch {
    return false;
  }
}

/** Records a failure of best-effort work. Never throws. */
export function logSwallowedError(tag: string, error: unknown, options: SwallowOptions = {}): void {
  try {
    if (options.ignoreMissingFile && isMissingFile(error)) return;
    console.warn(`[BestEffort] ${JSON.stringify({ event: 'best_effort_failed', tag, error_kind: errorKind(error) })}`);
  } catch {
    // Logging must never change the caller's control flow.
  }
}

/**
 * Runs best-effort work. Its result when it succeeds; when it throws or
 * rejects, the failure is recorded (tag and error kind only) and the result is
 * undefined. Never throws.
 */
export async function bestEffort<T>(
  tag: string,
  work: () => T | PromiseLike<T>,
  options: SwallowOptions = {},
): Promise<Awaited<T> | undefined> {
  try {
    return await work();
  } catch (error) {
    logSwallowedError(tag, error, options);
    return undefined;
  }
}

/**
 * bestEffort for synchronous work. A promise returned by mistake is not left
 * unhandled: its rejection is recorded the same way, and the result is undefined.
 */
export function bestEffortSync<T>(tag: string, work: () => T, options: SwallowOptions = {}): T | undefined {
  try {
    const result = work();
    if (isThenable(result)) {
      result.then(undefined, (error: unknown) => logSwallowedError(tag, error, options));
      return undefined;
    }
    return result;
  } catch (error) {
    logSwallowedError(tag, error, options);
    return undefined;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** For `.catch(...)`: records the failure and resolves to undefined, like `.catch(() => undefined)`. */
export function swallowAndLog(tag: string, options: SwallowOptions = {}): (error: unknown) => undefined {
  return (error: unknown) => {
    logSwallowedError(tag, error, options);
    return undefined;
  };
}
