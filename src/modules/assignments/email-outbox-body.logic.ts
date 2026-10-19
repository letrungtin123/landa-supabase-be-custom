// ═══════════════════════════════════════════════════════════════
// Email outbox body markers: where the owner feedback digest inserts its items,
// and the cleanup that removes the markers before a message is sent. Pure;
// moved unchanged from email-outbox.service.ts.
// ═══════════════════════════════════════════════════════════════

export const OWNER_FEEDBACK_HTML_MARKER = '<!-- LANDA_OWNER_FEEDBACK_ITEMS -->';
export const OWNER_FEEDBACK_TEXT_MARKER = '[LANDA_OWNER_FEEDBACK_ITEMS]';

export function cleanEmailBody(value: string): string {
  return value
    .split(OWNER_FEEDBACK_HTML_MARKER).join('')
    .split(OWNER_FEEDBACK_TEXT_MARKER).join('');
}
