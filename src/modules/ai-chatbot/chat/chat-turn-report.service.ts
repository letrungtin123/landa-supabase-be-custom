// The AI Report entry of an admin chat turn: a report question is answered
// by report-chat-turn.service.ts instead of the chat stages. Moved from
// sendMessageStream (chat.service.ts).

import { handleAdminReportTurn } from '../ai-report/report-chat-turn.service.js';
import { estimateAiTurnUsage } from './chat-turn-settle.service.js';
import type { ChatTurn } from './chat-turn.types.js';

/** True when the report entry answered the turn. */
export async function answerAdminReportTurn(turn: ChatTurn): Promise<boolean> {
  const { conversationId, userId, trimmed, options, ctx, aiSettings, onChunk, onDone, onSideEvent, finalizeAiReservation } = turn;
  // Report routing is limited to the normal admin deployment. The model can
  // only propose structured parameters; dates, org units and scope are
  // resolved and validated server-side (report-chat-turn.service.ts).
  if (ctx.target === 'admin' && options.canAccessReports && options.reportActorRole) {
    const reportOutcome = await handleAdminReportTurn({
      conversationId,
      tenantId: ctx.tenantId,
      userId,
      role: options.reportActorRole,
      locale: options.locale ?? 'vi',
      question: trimmed,
      reportFilters: options.reportFilters,
      chatModel: aiSettings.chatModel,
      isFirstMessage: ctx.messageCount === 0,
      correlationId: options.correlationId ?? null,
    }, {
      chunk: onChunk,
      sideEvent: (event) => onSideEvent?.(event),
      finalize: (inputParts, outputText, metadata) => finalizeAiReservation(
        estimateAiTurnUsage([ctx.systemPrompt, ...inputParts], outputText),
        { service: aiSettings.activeEngine, operation: 'chat' },
        metadata,
      ),
    });
    if (reportOutcome === 'handled') {
      onDone();
      return true;
    }
  }
  return false;
}
