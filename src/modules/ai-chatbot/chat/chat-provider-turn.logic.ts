// ═══════════════════════════════════════════════════════════════
// One chat answer from the provider: stop, retry and metering rules (H10)
//
// - The answer stops when the client leaves or the answer deadline passes
//   (one AbortSignal for the provider calls, the retry wait included).
// - A retry waits with jitter and never repeats text the client already got.
// - Metering: every provider call that started is paid for. A call counts as
//   started when it streamed text, reported usage, finished, or was stopped
//   by us after it was sent (the provider still bills an aborted call). It
//   is charged its reported usage, else an estimate. Only a call the
//   provider refused outright (an error before any text or usage) is free.
// ═══════════════════════════════════════════════════════════════

import type { AiUsage } from '../ai-platform/ai-engine.types.js';
import { addAiUsage } from '../ai-platform/ai-usage.logic.js';

export const CHAT_ANSWER_STOPPED_BY_CLIENT = 'chat_client_disconnected';

/** One signal for a chat answer: the client's disconnect plus the answer deadline. */
export function chatAnswerSignal(clientSignal: AbortSignal | undefined, deadlineMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(deadlineMs);
  return clientSignal ? AbortSignal.any([clientSignal, deadline]) : deadline;
}

/** Whether the answer was stopped by its deadline (not by the client leaving). */
export function stoppedByDeadline(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait before retry `attempt` (>= 1), with jitter so many turns refused
 * together do not come back together: at least the provider's own hint
 * (up to 20% more), else base x attempt with half of it random.
 */
export function chatRetryDelayMs(attempt: number, suggestedMs: number | null, baseMs: number, random: () => number = Math.random): number {
  if (suggestedMs && suggestedMs > 0) return Math.round(suggestedMs + random() * suggestedMs * 0.2);
  const delay = baseMs * Math.max(1, attempt);
  return Math.round(delay / 2 + random() * (delay / 2));
}

/**
 * Whether a failed attempt may be retried. Only provider overload (429/503)
 * is retried, never after the answer was stopped, and never once text has
 * reached the client (it cannot be taken back, a retry would repeat it).
 */
export function mayRetryChatAttempt(input: {
  status: number;
  attempt: number;
  maxRetries: number;
  stopped: boolean;
  textSentToClient: boolean;
}): boolean {
  if (input.stopped || input.textSentToClient) return false;
  if (input.status !== 429 && input.status !== 503) return false;
  return input.attempt < input.maxRetries;
}

export interface ChatProviderCall {
  addOutput(text: string): void;
  /** Usage the provider reported for this call; the last report wins. */
  setUsage(usage: AiUsage | null): void;
  /** The call ended with an error; `stopped` when our signal ended it. */
  fail(stopped: boolean): void;
}

interface CallRecord {
  usage: AiUsage | null;
  outputText: string;
  failed: boolean;
  stopped: boolean;
}

export interface ChatProviderMeter {
  start(): ChatProviderCall;
  /** True when any call was stopped by the client or the deadline after it was sent. */
  anyStopped(): boolean;
  /** What the provider bills for this answer, or null when no call started. */
  billedUsage(): AiUsage | null;
}

/** `estimateTokens(text)` estimates tokens of a text; `inputTokens` is the estimated prompt of one call. */
export function createChatProviderMeter(options: {
  inputTokens: () => number;
  estimateTokens: (text: string) => number;
}): ChatProviderMeter {
  const calls: CallRecord[] = [];
  const started = (call: CallRecord) => call.usage !== null || call.outputText.length > 0 || call.stopped || !call.failed;
  return {
    start() {
      const call: CallRecord = { usage: null, outputText: '', failed: false, stopped: false };
      calls.push(call);
      return {
        addOutput: (text) => { call.outputText += text; },
        setUsage: (usage) => { if (usage) call.usage = usage; },
        fail: (stopped) => { call.failed = true; call.stopped = call.stopped || stopped; },
      };
    },
    anyStopped: () => calls.some((call) => call.stopped),
    billedUsage() {
      let total: AiUsage | null = null;
      for (const call of calls) {
        if (!started(call)) continue;
        const estimate = (): AiUsage => {
          const inputTokens = Math.max(0, Math.ceil(options.inputTokens()));
          const outputTokens = call.outputText ? Math.max(0, Math.ceil(options.estimateTokens(call.outputText))) : 0;
          return { inputTokens, outputTokens, embeddingTokens: 0, totalTokens: inputTokens + outputTokens };
        };
        total = addAiUsage(total, call.usage ?? estimate());
      }
      return total;
    },
  };
}
