// ═══════════════════════════════════════════════════════════════
// Small JSON logger (BE-S14) for the background process and the worker
// entry points. One line per record, `[Tag] {"event":...}`: the shape of the
// structured lines the code already writes ([DB], [LessonAuthorWorkspace],
// [RuntimeTenantFence]), so PM2 logs stay readable and a script can parse the
// JSON after the tag. No dependency.
//
// Every record has `event`, `level` and `ts` (ISO time) first, then the
// logger's fields, then the call's fields. Errors become { name, message,
// code }; bigints become strings; a circular value becomes "[Circular]".
// Never pass tokens, passwords, keys, prompts or personal data beyond IDs.
// ═══════════════════════════════════════════════════════════════

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface JsonLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose records also carry `fields`. */
  child(fields: LogFields): JsonLogger;
}

export interface JsonLoggerOptions {
  /** The `[Tag]` in front of the JSON, e.g. 'Heartbeat'. */
  tag: string;
  /** Fields of every record (e.g. role, pid). */
  fields?: LogFields;
  /** Where a line goes; default console.log / console.warn / console.error by level. */
  write?: (level: LogLevel, line: string) => void;
  now?: () => Date;
}

const RESERVED = new Set(['event', 'level', 'ts']);

function consoleWrite(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function errorFields(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
}

/** JSON text of a record; never throws. */
export function formatLogRecord(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(record, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return errorFields(value);
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({ event: record.event, level: record.level, ts: record.ts, log_error: 'unserializable_fields' });
  }
}

export function createJsonLogger(options: JsonLoggerOptions): JsonLogger {
  const write = options.write ?? consoleWrite;
  const now = options.now ?? (() => new Date());
  const base = options.fields ?? {};

  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const record: Record<string, unknown> = { event, level, ts: now().toISOString() };
    for (const source of [base, fields]) {
      for (const [key, value] of Object.entries(source)) {
        if (!RESERVED.has(key)) record[key] = value;
      }
    }
    write(level, `[${options.tag}] ${formatLogRecord(record)}`);
  };

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: fields => createJsonLogger({ ...options, fields: { ...base, ...fields } }),
  };
}
