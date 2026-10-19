// What the client sees of a chat answer: chunks of a whole answer, and no
// internal routing label ("Phân loại: …") at its start. Moved from
// chat.service.ts (move only).

import { foldVietnameseText } from '../ai-id/legacy/context.service.js';

export function emitTextAsSseChunks(text: string, onChunk: (chunk: string) => void): void {
  const chunkSize = 900;
  for (let index = 0; index < text.length; index += chunkSize) {
    onChunk(text.slice(index, index + chunkSize));
  }
}

/**
 * Personas may need to route a turn to the right source, but that routing is
 * not user-facing content. Keep this narrowly scoped so a legitimate answer
 * about classification is never altered.
 */
function normalizeInternalChatRoutingLabel(value: string): string {
  return foldVietnameseText(value)
    .replace(/[*_`]/g, '')
    .replace(/^[\s>:\-\u2022]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInternalChatRoutingLabel(value: string): boolean {
  const normalized = normalizeInternalChatRoutingLabel(value);
  return /^(?:phan loai|classification|intent)\s*:\s*(?:[abc]\s*(?:[.)-]\s*)?)?(?:noi dung hoc tap|giao dien(?:\s*\/\s*tinh nang)?(?:\s*lms)?|ket hop ca hai)(?:\s*\([^\r\n)]{0,240}\))?$/i.test(normalized);
}

function mayBeInternalChatRoutingLabel(value: string): boolean {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? '';
  const normalized = normalizeInternalChatRoutingLabel(firstLine);
  if (!normalized) return true;
  const label = normalized.split(':', 1)[0].trim();
  return ['phan loai', 'classification', 'intent'].some(prefix => prefix.startsWith(label));
}

export function stripLeadingInternalChatRoutingLabels(value: string): string {
  let remaining = value;
  for (let index = 0; index < 2; index += 1) {
    const lineBreak = remaining.search(/\r?\n/);
    const line = lineBreak === -1 ? remaining : remaining.slice(0, lineBreak);
    if (!isInternalChatRoutingLabel(line)) break;
    remaining = lineBreak === -1
      ? ''
      : remaining.slice(lineBreak).replace(/^(?:\r?\n)+/, '');
  }
  return remaining;
}

export interface ChatResponseEmitter {
  push: (text: string) => void;
  flush: () => void;
}

/**
 * Preserve normal streaming while holding only a possible first routing line.
 * This prevents an internal A/B/C label from flashing in the widget before the
 * complete response is saved in sanitized form.
 */
export function createChatResponseEmitter(onChunk: (chunk: string) => void): ChatResponseEmitter {
  let pending = '';
  let committed = false;

  const flushPending = () => {
    if (!pending) return;
    const safeText = stripLeadingInternalChatRoutingLabels(pending);
    pending = '';
    committed = true;
    if (safeText) onChunk(safeText);
  };

  return {
    push: (text: string) => {
      if (!text) return;
      if (committed) {
        onChunk(text);
        return;
      }

      pending += text;
      const hasCompleteFirstLine = /\r?\n/.test(pending);
      if (hasCompleteFirstLine || pending.length >= 384 || !mayBeInternalChatRoutingLabel(pending)) {
        flushPending();
      }
    },
    flush: flushPending,
  };
}
